import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, resolve } from "node:path";
import { registerCommands } from "./commands.ts";
import { buildRepoConfig, isConfigured, loadSettings, readRepoConfigValues } from "./config.ts";
import { ensureLinks } from "./operations.ts";
import { classifyBash, compileProtected, renderBranch, shellQuote } from "./policy.ts";
import { renderSection, SECTION_NAME, toolGuidelines } from "./prompt.ts";
import { canonical, findBareRoot, isInsideRoot, listWorktrees, worktreeForPath } from "./repo.ts";
import { activeIsProtected, ENTRY_TYPE, isRouted, type EntryData, type State } from "./state.ts";
import { createLiveRefresher, publish } from "./status.ts";
import { registerWorktreeTool, TOOL_NAME } from "./tool.ts";

const PATH_TOOLS = new Set(["read", "edit", "write", "ls", "grep", "find"]);
const CWD_DEFAULT_TOOLS = new Set(["ls", "grep", "find"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
const SUBAGENT_TOOLS = new Set(["subagent", "task", "spawn_agent"]);

export default function piBareWorktrees(pi: ExtensionAPI) {
	const state: State = {
		settings: loadSettings(),
		bare: null,
		config: null,
		configured: false,
		worktrees: [],
		active: null,
		cwd: process.cwd(),
		enforcement: "on",
		isProtected: () => false,
		live: null,
	};
	const refresher = createLiveRefresher(pi, state);
	let toolHidden = false;
	let syncHintShownFor: string | null = null;

	registerWorktreeTool(pi, state, refresher);
	registerCommands(pi, state, refresher);

	function restoreFromSession(ctx: ExtensionContext): { active: { path: string } | null | undefined; enforcement: "on" | "off" | undefined } {
		let active: { path: string } | null | undefined;
		let enforcement: "on" | "off" | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as EntryData | undefined;
			if (!data) continue;
			if ("active" in data) active = data.active;
			if ("enforcement" in data) enforcement = data.enforcement;
		}
		return { active, enforcement };
	}

	pi.on("session_start", async (event, ctx) => {
		refresher.cancel();
		state.cwd = canonical(ctx.cwd);
		state.settings = loadSettings();
		state.bare = findBareRoot(ctx.cwd);
		state.live = null;

		if (!state.bare) {
			state.config = null;
			state.configured = false;
			state.worktrees = [];
			state.active = null;
			state.enforcement = "off";
			state.isProtected = () => false;
			if (!toolHidden) {
				pi.setActiveTools(pi.getActiveTools().filter((t) => t !== TOOL_NAME));
				toolHidden = true;
			}
			if (event.reason === "startup" && state.settings.warnWhenNotBare && ctx.hasUI) {
				ctx.ui.notify(
					"pi-bare-worktrees is off: this is not a bare checkout. Set warnWhenNotBare=false in ~/.pi/agent/pi-bare-worktrees.json to hide this.",
					"warning",
				);
			}
			publish(pi, ctx, state);
			return;
		}

		if (toolHidden) {
			pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
			toolHidden = false;
		}
		const values = readRepoConfigValues(state.bare.bareDir);
		state.configured = isConfigured(values);
		state.config = buildRepoConfig(values, state.bare.defaultBranch, state.settings);
		state.isProtected = compileProtected(state.bare.defaultBranch, state.config.protected);
		state.worktrees = listWorktrees(state.bare);

		const restored = restoreFromSession(ctx);
		state.enforcement = restored.enforcement ?? "on";
		const restoredActive = restored.active ? state.worktrees.find((w) => w.path === restored.active!.path && !w.missing) : undefined;
		state.active = restoredActive ?? worktreeForPath(state.worktrees, ctx.cwd);

		if (state.active && state.config.autoLink) {
			const r = ensureLinks(state, state.active.path);
			if (r?.linked.length && ctx.hasUI) ctx.ui.notify(`Linked ${r.linked.length} shared env files into ${state.active.name}.`, "info");
		}
		if (!state.configured && event.reason === "startup" && ctx.hasUI) {
			ctx.ui.notify("pi-bare-worktrees: bare checkout detected but not configured. Run /wt setup.", "warning");
		}
		publish(pi, ctx, state);
		refresher.schedule(ctx, 0);
	});

	pi.on("session_shutdown", () => refresher.cancel());

	pi.on("before_agent_start", (event) => {
		if (!state.bare) return;
		const opts = event.systemPromptOptions;
		if (state.settings.systemPrompt) opts.sections[SECTION_NAME] = renderSection(state);
		const guidelines = toolGuidelines(state);
		for (const [tool, lines] of Object.entries(guidelines)) {
			if (!lines) continue;
			opts.toolGuidelines[tool] = [...(opts.toolGuidelines[tool] ?? []), ...lines];
		}
	});

	pi.on("tool_call", (event) => {
		const bare = state.bare;
		if (!bare) return;
		const name = event.toolName;
		if (name === TOOL_NAME) return;
		const input = event.input as Record<string, unknown>;
		const active = state.active;

		if (SUBAGENT_TOOLS.has(name)) {
			if (active && (input.cwd === undefined || input.cwd === null || input.cwd === "")) input.cwd = active.path;
			if (typeof input.cwd === "string" && isInsideRoot(bare, input.cwd)) ensureLinks(state, input.cwd);
			return;
		}

		// Routing: make relative work land in the active worktree when the
		// session cwd is somewhere else (after a model-initiated create/use).
		if (active && isRouted(state)) {
			if (name === "bash" && typeof input.command === "string") {
				input.command = `cd ${shellQuote(active.path)}\n${input.command}`;
			} else if (PATH_TOOLS.has(name)) {
				if (typeof input.path === "string" && input.path && !isAbsolute(input.path)) input.path = join(active.path, input.path);
				else if (input.path === undefined && CWD_DEFAULT_TOOLS.has(name)) input.path = active.path;
			}
		}

		if (state.enforcement === "off") return;
		const effectiveCwd = active?.path ?? state.cwd;

		if (name === "bash" && typeof input.command === "string") {
			const command = isRouted(state) ? input.command.slice(input.command.indexOf("\n") + 1) : input.command;
			const cls = classifyBash(command);
			if (!cls) return;
			if (cls.kind === "worktree-switch") {
				return {
					block: true,
					reason: `'${cls.match}' is not allowed: worktree paths equal branch names here. Use the worktree tool (action create or use) instead.`,
				};
			}
			const touchesProtected =
				activeIsProtected(state) || state.worktrees.some((w) => state.isProtected(w.branch) && command.includes(w.path));
			if (touchesProtected) return { block: true, reason: createHint(cls.match) };
			return;
		}

		if (WRITE_TOOLS.has(name) && typeof input.path === "string") {
			const target = resolve(effectiveCwd, input.path);
			if (!isInsideRoot(bare, target)) return;
			const wt = worktreeForPath(state.worktrees, target);
			if (!wt || state.isProtected(wt.branch)) return { block: true, reason: createHint(`${name} ${input.path}`) };
		}
	});

	function createHint(what: string): string {
		const branch = state.active?.branch ?? "the root";
		const example = renderBranch(state.config?.branchTemplate ?? "feat/{slug}", "short-task-slug");
		return (
			`Blocked '${what}': ${branch} is protected (read-only). ` +
			`Create a worktree first: worktree({action:"create", branch:"${example}"}) with a slug that describes the task, ` +
			`then retry. The retry runs inside the new worktree automatically. If the user really wants changes on ${branch}, tell them to run /wt off.`
		);
	}

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === TOOL_NAME) refresher.schedule(ctx, 0);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.bare) return;
		refresher.schedule(ctx);
		if (ctx.hasUI && state.active && isRouted(state) && syncHintShownFor !== state.active.path) {
			syncHintShownFor = state.active.path;
			ctx.ui.notify(`Tools run in ${state.active.name}. Run /wt sync to move the session there.`, "info");
		}
	});
}
