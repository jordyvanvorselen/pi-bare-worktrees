import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { buildRepoConfig, readRepoConfigValues, writeRepoConfig, type RepoConfig } from "./config.ts";
import { compileProtected } from "./policy.ts";
import { create, doctor, ensureLinks, findWorktree, refreshWorktrees, remove, setEnforcement, use, WorktreeError, activate } from "./operations.ts";
import { canonical, fetchPrune, goneBranches, isDirty, pruneWorktrees, worktreeForPath, type Worktree } from "./repo.ts";
import type { State } from "./state.ts";
import { isRouted } from "./state.ts";
import { publish } from "./status.ts";
import type { LiveRefresher } from "./types.ts";
import { editForm, type FormField, type FormValues } from "./ui/form.ts";
import { pickMany } from "./ui/picker.ts";

const USAGE = [
	"/wt                      pick a worktree",
	"/wt new <branch> [--from <ref>] [--move]",
	"/wt use <branch> [--move]",
	"/wt list",
	"/wt link",
	"/wt rm <branch> [--force] [--branch]",
	"/wt clean                remove worktrees whose remote branch is gone",
	"/wt doctor [--fix]",
	"/wt sync                 move the session cwd into the active worktree",
	"/wt setup",
	"/wt on | off",
].join("\n");

function parseArgs(raw: string): { positional: string[]; flags: Map<string, string | true> } {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.startsWith("--")) {
			const name = t.slice(2);
			const next = tokens[i + 1];
			if (name === "from" && next && !next.startsWith("--")) {
				flags.set(name, next);
				i++;
			} else flags.set(name, true);
		} else positional.push(t);
	}
	return { positional, flags };
}

function fail(ctx: ExtensionContext, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	ctx.ui.notify(message, "error");
}

/**
 * Move the session itself into `path`: fork the session file with the new
 * cwd and switch to it, like powerline's /cd. Only possible from a command.
 */
async function switchSessionTo(ctx: ExtensionCommandContext, state: State, path: string): Promise<boolean> {
	if (canonical(ctx.cwd) === path) return true;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) return false;
	await ctx.waitForIdle();
	const next = SessionManager.forkFrom(sessionFile, path);
	const nextFile = next.getSessionFile();
	if (!nextFile) return false;
	const result = await ctx.switchSession(nextFile, {
		withSession: async (nextCtx) => {
			try {
				process.chdir(nextCtx.cwd);
			} catch {
				// cwd may be gone; routing still works
			}
			nextCtx.ui.setTitle(`pi - ${basename(nextCtx.cwd)}`);
		},
	});
	if (result.cancelled) {
		try {
			if (existsSync(nextFile)) unlinkSync(nextFile);
		} catch {
			// best effort
		}
		return false;
	}
	return true;
}

/** Setup fields, prefilled with the current config so Enter keeps everything. */
export function setupFields(current: RepoConfig, defaultBranch: string): FormField[] {
	return [
		{ kind: "text", id: "sharedEnv", label: "Shared env directory", value: current.sharedEnv, help: "Relative to the root. Every file in it is symlinked into each worktree." },
		{ kind: "text", id: "baseBranch", label: "Base branch", value: current.baseBranch || defaultBranch, help: "New worktrees branch off this ref. It is always protected." },
		{ kind: "text", id: "protected", label: "Protected patterns", value: current.protected.join(", "), empty: "none", help: "Comma separated globs of read-only branches, e.g. release/*." },
		{ kind: "text", id: "branchTemplate", label: "Branch template", value: current.branchTemplate, help: "Name for new work. {slug} is filled from the task." },
		{ kind: "toggle", id: "fetchBeforeCreate", label: "Fetch before create", value: current.fetchBeforeCreate, help: "Run git fetch --prune before every new worktree. Costs a network round-trip." },
		{ kind: "toggle", id: "autoLink", label: "Auto-link on start", value: current.autoLink, help: "Re-link shared env files at session start when links are missing." },
		{ kind: "text", id: "postCreate", label: "Post-create commands", value: current.postCreate.join(" && "), empty: "none", help: "Run inside a new worktree, separated by ' && '. Leave empty for none." },
		{ kind: "text", id: "copy", label: "Copy instead of link", value: current.copy.join(", "), empty: "none", help: "Comma separated paths copied from the base worktree, e.g. .idea." },
	];
}

/** Turn raw form values into a config, falling back to `current` for blanks. */
export function configFromForm(values: FormValues, current: RepoConfig, defaultBranch: string): RepoConfig {
	const text = (id: string, fallback: string) => (typeof values[id] === "string" ? (values[id] as string).trim() : "") || fallback;
	const list = (id: string) => text(id, "").split(",").map((s) => s.trim()).filter(Boolean);
	return {
		sharedEnv: text("sharedEnv", current.sharedEnv),
		baseBranch: text("baseBranch", current.baseBranch || defaultBranch),
		protected: list("protected"),
		branchTemplate: text("branchTemplate", current.branchTemplate),
		fetchBeforeCreate: values.fetchBeforeCreate === true,
		postCreate: text("postCreate", "").split(/\s*&&\s*/).filter(Boolean),
		copy: list("copy"),
		autoLink: values.autoLink === true,
	};
}

/** One prompt per field, for hosts without a TUI. Defaults are in the title. */
async function askFields(ctx: ExtensionContext, fields: FormField[]): Promise<FormValues | null> {
	const values: FormValues = {};
	for (const field of fields) {
		if (field.kind === "toggle") {
			values[field.id] = await ctx.ui.confirm(`${field.label}?`, `${field.help ?? ""}\nCurrently ${field.value ? "yes" : "no"}.`);
			continue;
		}
		const shown = field.value || field.empty || "empty";
		const answer = await ctx.ui.input(`${field.label} [${shown}] — enter keeps it`, field.value);
		if (answer === undefined) return null;
		values[field.id] = answer.trim() || field.value;
	}
	return values;
}

export async function runSetup(ctx: ExtensionContext, state: State): Promise<boolean> {
	if (!state.bare) {
		ctx.ui.notify("Not a bare checkout: nothing to set up.", "warning");
		return false;
	}
	const bare = state.bare;
	const current = state.config ?? buildRepoConfig(new Map(), bare.defaultBranch, state.settings);
	const fields = setupFields(current, bare.defaultBranch);
	const edited = await editForm(ctx, "Set up bare worktrees", fields);
	const values = edited === undefined ? await askFields(ctx, fields) : edited;
	if (!values) return false;

	const config = configFromForm(values, current, bare.defaultBranch);
	const sharedEnv = config.sharedEnv;
	await writeRepoConfig(bare.bareDir, config);
	state.config = buildRepoConfig(readRepoConfigValues(bare.bareDir), bare.defaultBranch, state.settings);
	state.configured = true;
	state.isProtected = compileProtected(bare.defaultBranch, state.config.protected);
	if (!existsSync(join(bare.root, sharedEnv))) ctx.ui.notify(`${sharedEnv} does not exist yet; create it and drop gitignored files in there.`, "warning");
	ctx.ui.notify(`Saved to ${join(bare.bareDir, "config")} [bare-worktrees]. Running doctor…`, "info");
	await runDoctor(ctx, state, true);
	return true;
}

async function runDoctor(ctx: ExtensionContext, state: State, fix: boolean) {
	const r = await doctor(state, fix);
	const lines: string[] = [];
	if (fix) lines.push(`Linked ${r.fixed.linked} files, pruned ${r.fixed.pruned} stale worktrees.`);
	for (const m of r.missingLinks) lines.push(`${m.worktree.name}: ${m.files.length} links missing`);
	for (const c of r.conflicts) lines.push(`${c.worktree.name}: real files in the way: ${c.files.join(", ")}`);
	for (const d of r.detached) lines.push(`${d.worktree.name}: detached HEAD${d.unpushed ? `, ${d.unpushed} unpushed commits` : ""}`);
	if (!fix) for (const p of r.prunable) lines.push(`${p.name}: directory missing (prunable)`);
	ctx.ui.notify(lines.length ? lines.join("\n") : "Everything is in order.", lines.length && !fix ? "warning" : "info");
}

async function runClean(ctx: ExtensionCommandContext, pi: ExtensionAPI, state: State) {
	if (!state.bare) return;
	ctx.ui.notify("Fetching with prune…", "info");
	try {
		await fetchPrune(state.bare);
	} catch (error) {
		fail(ctx, error);
		return;
	}
	const gone = new Set(await goneBranches(state.bare));
	const wts = refreshWorktrees(state);
	const candidates: { wt: Worktree; badges: string[]; dirty: boolean }[] = [];
	for (const wt of wts) {
		if (state.isProtected(wt.branch)) continue;
		const badges: string[] = [];
		if (wt.missing) badges.push("missing");
		else if (wt.branch && gone.has(wt.branch)) badges.push("gone");
		else continue;
		const dirty = !wt.missing && (await isDirty(wt.path));
		if (dirty) badges.push("dirty");
		candidates.push({ wt, badges, dirty });
	}
	if (!candidates.length) {
		await pruneWorktrees(state.bare);
		ctx.ui.notify("Nothing to clean.", "info");
		return;
	}
	const picked = await pickMany(
		ctx,
		"Remove worktrees",
		candidates.map((c) => ({ id: c.wt.path, label: c.wt.name, badges: c.badges, checked: !c.dirty })),
	);
	if (!picked) return;
	let removed = 0;
	for (const c of candidates) {
		if (!picked.includes(c.wt.path)) continue;
		try {
			await remove(pi, ctx, state, c.wt.path, { force: true, deleteBranch: true });
			removed++;
		} catch (error) {
			fail(ctx, error);
		}
	}
	ctx.ui.notify(`Removed ${removed} worktree${removed === 1 ? "" : "s"}.`, "info");
}

async function pickWorktree(ctx: ExtensionCommandContext, state: State): Promise<Worktree | null> {
	const wts = refreshWorktrees(state).filter((w) => !w.missing);
	if (!wts.length) {
		ctx.ui.notify("No worktrees yet. /wt new <branch>", "info");
		return null;
	}
	const labels = wts.map((w) => `${w.path === state.active?.path ? "● " : "  "}${w.branch ?? "(detached)"}${state.isProtected(w.branch) ? "  (protected)" : ""}`);
	const choice = await ctx.ui.select("Switch to worktree", labels);
	if (choice === undefined) return null;
	return wts[labels.indexOf(choice)] ?? null;
}

export function registerCommands(pi: ExtensionAPI, state: State, refresher: LiveRefresher): void {
	pi.registerCommand("wt", {
		description: "Bare-checkout worktrees: new, use, list, link, rm, clean, doctor, sync, setup, on, off",
		getArgumentCompletions(prefix) {
			const { positional } = parseArgs(prefix);
			const subcommands = ["new", "use", "list", "link", "rm", "clean", "doctor", "sync", "setup", "on", "off"];
			if (positional.length <= 1 && !prefix.endsWith(" ")) {
				return subcommands.filter((s) => s.startsWith(positional[0] ?? "")).map((s) => ({ value: s, label: s }));
			}
			if (["use", "rm"].includes(positional[0] ?? "") && state.bare) {
				const typed = positional[1] ?? "";
				return refreshWorktrees(state)
					.filter((w) => w.branch?.startsWith(typed))
					.map((w) => ({ value: `${positional[0]} ${w.branch}`, label: w.branch! }));
			}
			return null;
		},
		async handler(args, ctx) {
			const { positional, flags } = parseArgs(args);
			const sub = positional[0];

			if (!state.bare) {
				ctx.ui.notify("pi-bare-worktrees is inactive: this project is not a bare checkout (no .bare/ with core.bare=true above the cwd).", "warning");
				return;
			}
			if (!state.configured && sub !== "setup") {
				const go = await ctx.ui.confirm("pi-bare-worktrees is not configured for this repo", "Run the setup wizard now?");
				if (!go) return;
				if (!(await runSetup(ctx, state))) return;
				if (!sub) return;
			}

			try {
				switch (sub) {
					case undefined: {
						const wt = await pickWorktree(ctx, state);
						if (!wt) return;
						await use(pi, ctx, state, wt.path);
						await switchSessionTo(ctx, state, wt.path);
						refresher.schedule(ctx);
						return;
					}
					case "new": {
						const branch = positional[1];
						if (!branch) return ctx.ui.notify("Usage: /wt new <branch> [--from <ref>] [--move]", "error");
						const from = flags.get("from");
						const r = await create(pi, ctx, state, branch, { ...(typeof from === "string" ? { from } : {}), ...(flags.has("move") ? { move: true } : {}) });
						ctx.ui.notify(`Created ${r.worktree.name}: ${r.links.linked.length} env files linked${r.links.conflicts.length ? `, ${r.links.conflicts.length} conflicts` : ""}${r.moved ? ", changes moved" : ""}.`, "info");
						for (const p of r.postCreate) if (p.code) ctx.ui.notify(`post-create failed (${p.code}): ${p.command}\n${p.output}`, "warning");
						await switchSessionTo(ctx, state, r.worktree.path);
						refresher.schedule(ctx);
						return;
					}
					case "use": {
						const ref = positional[1];
						if (!ref) return ctx.ui.notify("Usage: /wt use <branch> [--move]", "error");
						const r = await use(pi, ctx, state, ref, flags.has("move") ? { move: true } : {});
						await switchSessionTo(ctx, state, r.worktree.path);
						refresher.schedule(ctx);
						return;
					}
					case "list": {
						const lines = refreshWorktrees(state).map((w) => `${w.path === state.active?.path ? "●" : " "} ${w.branch ?? "(detached)"}${state.isProtected(w.branch) ? "  ro" : ""}${w.missing ? "  missing" : ""}`);
						ctx.ui.notify(lines.join("\n") || "No worktrees.", "info");
						return;
					}
					case "link": {
						if (!state.active) return ctx.ui.notify("No active worktree.", "warning");
						const r = ensureLinks(state, state.active.path);
						ctx.ui.notify(r ? `Linked ${r.linked.length}, kept ${r.kept.length}${r.conflicts.length ? `, conflicts: ${r.conflicts.join(", ")}` : ""}.` : "All links present.", "info");
						refresher.schedule(ctx);
						return;
					}
					case "rm": {
						const ref = positional[1];
						if (!ref) return ctx.ui.notify("Usage: /wt rm <branch> [--force] [--branch]", "error");
						const wt = findWorktree(state, ref);
						if (!wt) return ctx.ui.notify(`No worktree for '${ref}'.`, "error");
						const ok = await ctx.ui.confirm(`Remove worktree ${wt.name}?`, `${wt.path}${flags.has("branch") ? "\nThe branch will be deleted too." : ""}`);
						if (!ok) return;
						const wasActive = state.active?.path === wt.path;
						const r = await remove(pi, ctx, state, ref, { force: flags.has("force"), deleteBranch: flags.has("branch") });
						ctx.ui.notify(`Removed ${r.removed.name}${r.branchDeleted ? " and its branch" : ""}.`, "info");
						if (wasActive) {
							const fallback = worktreeForPath(state.worktrees, state.cwd) ?? state.worktrees.find((w) => w.branch === state.bare!.defaultBranch) ?? null;
							if (fallback) {
								activate(pi, ctx, state, fallback);
								await switchSessionTo(ctx, state, fallback.path);
							}
						}
						return;
					}
					case "clean":
						await runClean(ctx, pi, state);
						return;
					case "doctor":
						await runDoctor(ctx, state, flags.has("fix"));
						refresher.schedule(ctx);
						return;
					case "sync": {
						if (!state.active) return ctx.ui.notify("No active worktree.", "warning");
						if (!isRouted(state)) return ctx.ui.notify(`Session already runs in ${state.active.path}.`, "info");
						if (!(await switchSessionTo(ctx, state, state.active.path))) ctx.ui.notify("Could not switch the session; tools stay routed.", "warning");
						return;
					}
					case "setup":
						await runSetup(ctx, state);
						return;
					case "on":
						setEnforcement(pi, ctx, state, "on");
						ctx.ui.notify("Enforcement on: protected branches are read-only.", "info");
						return;
					case "off": {
						const ok = await ctx.ui.confirm("Turn enforcement off for this session?", "The agent may then edit protected branches directly.");
						if (!ok) return;
						setEnforcement(pi, ctx, state, "off");
						ctx.ui.notify("Enforcement off for this session.", "warning");
						return;
					}
					default:
						ctx.ui.notify(USAGE, "info");
				}
			} catch (error) {
				if (error instanceof WorktreeError) fail(ctx, error);
				else throw error;
			} finally {
				publish(pi, ctx, state);
			}
		},
	});
}
