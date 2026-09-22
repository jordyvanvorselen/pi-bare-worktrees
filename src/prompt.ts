import { existsSync, readFileSync, statSync } from "node:fs";
import type { State } from "./state.ts";
import { activeIsProtected, isRouted } from "./state.ts";

export const SECTION_NAME = "worktrees";

/**
 * Placeholders a custom template may use: {root} {active} {activePath}
 * {state} {branchTemplate} {baseBranch} {protected}.
 */
export const DEFAULT_TEMPLATE = `Repo root: {root} (bare checkout, one directory per branch, managed by pi-bare-worktrees)
Active worktree: {active} at {activePath} — {state}
Rules:
- Every code change happens in its own worktree. Before the first edit, write, or mutating shell command while the active worktree is protected, call worktree({action:"create", branch:"…"}). Derive the branch from the task using the template {branchTemplate}, for example {example}. Do not ask for permission to create it; just do it and continue.
- After create or use, every tool runs inside that worktree. Relative paths resolve there. Never run cd into another worktree, never run git worktree, git checkout <branch> or git switch yourself: the worktree tool owns that.
- Reading, searching, building and testing on a protected branch is fine.
- Subagents you spawn inherit the active worktree. Do not pass a different cwd unless the user asks.
- If the user explicitly wants to work on the protected branch, ask them to run /wt off.`;

export function renderSection(state: State): string {
	const template = customTemplate(state) ?? DEFAULT_TEMPLATE;
	const protectedNow = activeIsProtected(state);
	const stateText = state.enforcement === "off"
		? "enforcement OFF for this session, writes allowed anywhere"
		: protectedNow
			? "PROTECTED, read-only until you create a worktree"
			: isRouted(state)
				? "writable, tools are routed here"
				: "writable";
	const branchTemplate = state.config?.branchTemplate ?? "feat/{slug}";
	return template
		.replace(/\{root\}/g, state.bare?.root ?? "")
		.replace(/\{active\}/g, state.active?.branch ?? (state.active ? "(detached)" : "(root, no worktree)"))
		.replace(/\{activePath\}/g, state.active?.path ?? state.cwd)
		.replace(/\{state\}/g, stateText)
		.replace(/\{branchTemplate\}/g, branchTemplate)
		.replace(/\{example\}/g, branchTemplate.replace("{slug}", "fix-login-redirect"))
		.replace(/\{baseBranch\}/g, state.config?.baseBranch ?? state.bare?.defaultBranch ?? "main")
		.replace(/\{protected\}/g, [state.bare?.defaultBranch ?? "main", ...(state.config?.protected ?? [])].join(", "));
}

let cachedTemplate: { path: string; mtime: number; text: string } | null = null;

function customTemplate(state: State): string | null {
	const path = state.settings.systemPromptFile;
	if (!path || !existsSync(path)) return null;
	try {
		const { mtimeMs } = statSync(path);
		if (cachedTemplate && cachedTemplate.path === path && cachedTemplate.mtime === mtimeMs) return cachedTemplate.text;
		const text = readFileSync(path, "utf8");
		cachedTemplate = { path, mtime: mtimeMs, text };
		return text;
	} catch {
		return null;
	}
}

export function toolGuidelines(state: State): { worktree: string[]; edit?: string[]; write?: string[] } {
	const worktree = [
		"Use action create with a branch derived from the task before your first change on a protected branch.",
		"Use action use to move into a worktree that already exists; use list to see them.",
		"Do not fall back to git worktree, git checkout or cd for any of this.",
	];
	if (state.enforcement === "on" && activeIsProtected(state)) {
		const hint = ["The active branch is protected. Call worktree create first; this call will be blocked otherwise."];
		return { worktree, edit: hint, write: hint };
	}
	return { worktree };
}
