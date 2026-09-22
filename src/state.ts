import type { RepoConfig, Settings } from "./config.ts";
import type { BareRoot, Worktree } from "./repo.ts";

/** Session entry customType used for persisted state. */
export const ENTRY_TYPE = "bare-worktrees";

export type EntryData = { active: { branch: string | null; path: string } | null } | { enforcement: "on" | "off" };

export interface LiveStatus {
	dirty: boolean;
	ahead: number;
	behind: number;
	gone: boolean;
	missingLinks: number;
}

export interface State {
	settings: Settings;
	/** Null when the session is not inside a bare checkout. */
	bare: BareRoot | null;
	config: RepoConfig | null;
	configured: boolean;
	worktrees: Worktree[];
	/** Worktree every tool call runs in. Null at the root or outside any worktree. */
	active: Worktree | null;
	/** The session's real cwd, as Pi sees it. */
	cwd: string;
	enforcement: "on" | "off";
	isProtected: (branch: string | null) => boolean;
	live: LiveStatus | null;
}

/** True when tool calls must be rewritten to run in `active` instead of `cwd`. */
export function isRouted(state: State): boolean {
	return state.active !== null && state.active.path !== state.cwd;
}

/** Protection applies to protected branches and to the root directory itself. */
export function activeIsProtected(state: State): boolean {
	if (!state.bare) return false;
	if (!state.active) return true;
	return state.isProtected(state.active.branch);
}

/** Snapshot published on the shared event bus for footers and other extensions. */
export interface PublicSnapshot {
	root: string | null;
	active: { branch: string | null; path: string; name: string; protected: boolean } | null;
	enforcement: "on" | "off";
	routed: boolean;
	live: LiveStatus | null;
}

export function snapshot(state: State): PublicSnapshot {
	return {
		root: state.bare?.root ?? null,
		active: state.active
			? { branch: state.active.branch, path: state.active.path, name: state.active.name, protected: state.isProtected(state.active.branch) }
			: null,
		enforcement: state.enforcement,
		routed: isRouted(state),
		live: state.live,
	};
}
