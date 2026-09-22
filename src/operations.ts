import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateBranchName } from "./policy.ts";
import {
	addWorktree,
	deleteBranch,
	fetchPrune,
	isDirty,
	listWorktrees,
	pruneWorktrees,
	removeWorktree,
	stashPop,
	stashPush,
	unpushedCommitCount,
	worktreeForPath,
	worktreePath,
	type BranchOrigin,
	type Worktree,
} from "./repo.ts";
import { copyExtras, linkSharedEnv, missingLinks, type LinkReport } from "./shared-env.ts";
import { ENTRY_TYPE, type EntryData, type State } from "./state.ts";
import { publish } from "./status.ts";

export class WorktreeError extends Error {}

export interface CreateResult {
	worktree: Worktree;
	origin: BranchOrigin;
	base: string | undefined;
	links: LinkReport;
	copied: string[];
	moved: boolean;
	postCreate: { command: string; code: number; output: string }[];
}

export interface DoctorReport {
	missingLinks: { worktree: Worktree; files: string[] }[];
	conflicts: { worktree: Worktree; files: string[] }[];
	detached: { worktree: Worktree; unpushed: number }[];
	prunable: Worktree[];
	fixed: { linked: number; pruned: number };
}

function requireBare(state: State) {
	if (!state.bare || !state.config) throw new WorktreeError("Not inside a bare checkout; pi-bare-worktrees is inactive here.");
	return { bare: state.bare, config: state.config };
}

export function sharedDir(state: State): string | null {
	if (!state.bare || !state.config) return null;
	const dir = join(state.bare.root, state.config.sharedEnv);
	return existsSync(dir) ? dir : null;
}

export function refreshWorktrees(state: State): Worktree[] {
	if (!state.bare) return [];
	state.worktrees = listWorktrees(state.bare);
	return state.worktrees;
}

function record(pi: ExtensionAPI, data: EntryData) {
	pi.appendEntry(ENTRY_TYPE, data);
}

/** Make `wt` the worktree every tool call targets. Persists to the session. */
export function activate(pi: ExtensionAPI, ctx: ExtensionContext, state: State, wt: Worktree | null): void {
	state.active = wt;
	state.live = null;
	record(pi, { active: wt ? { branch: wt.branch, path: wt.path } : null });
	publish(pi, ctx, state);
}

export function setEnforcement(pi: ExtensionAPI, ctx: ExtensionContext, state: State, value: "on" | "off"): void {
	state.enforcement = value;
	record(pi, { enforcement: value });
	publish(pi, ctx, state);
}

export function ensureLinks(state: State, worktree: string): LinkReport | null {
	const dir = sharedDir(state);
	if (!dir) return null;
	if (missingLinks(dir, worktree).length === 0) return null;
	return linkSharedEnv(dir, worktree);
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		execFile("/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error ? ((error as { code?: number }).code ?? 1) : 0;
			resolve({ code: typeof code === "number" ? code : 1, output: `${stdout}${stderr}`.trim().slice(-2000) });
		});
	});
}

export async function create(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	branch: string,
	options: { from?: string; move?: boolean; activate?: boolean } = {},
): Promise<CreateResult> {
	const { bare, config } = requireBare(state);
	const invalid = validateBranchName(branch);
	if (invalid) throw new WorktreeError(invalid);
	const existing = refreshWorktrees(state).find((w) => w.branch === branch || w.path === worktreePath(bare, branch));
	if (existing && !existing.missing) throw new WorktreeError(`Worktree for '${branch}' already exists at ${existing.path}. Use action "use".`);
	if (existing?.missing) await pruneWorktrees(bare);

	const moveFrom = options.move && state.active ? state.active.path : null;
	let moved = false;
	if (moveFrom) moved = await stashPush(moveFrom);

	if (config.fetchBeforeCreate) {
		try {
			await fetchPrune(bare);
		} catch {
			// offline is fine; create from local refs
		}
	}

	let added: Awaited<ReturnType<typeof addWorktree>>;
	try {
		added = await addWorktree(bare, branch, options.from ?? config.baseBranch);
	} catch (error) {
		if (moved && moveFrom) await stashPop(moveFrom).catch(() => undefined);
		throw new WorktreeError(error instanceof Error ? error.message : String(error));
	}

	const dir = sharedDir(state);
	const links: LinkReport = dir ? linkSharedEnv(dir, added.path) : { linked: [], kept: [], conflicts: [] };
	const baseWorktree = state.worktrees.find((w) => w.branch === config.baseBranch);
	const copied = baseWorktree ? copyExtras(baseWorktree.path, added.path, config.copy) : [];

	if (moved) await stashPop(added.path);

	const postCreate: CreateResult["postCreate"] = [];
	for (const command of config.postCreate) {
		const r = await runShell(command, added.path, 10 * 60_000);
		postCreate.push({ command, ...r });
	}

	const worktree = refreshWorktrees(state).find((w) => w.path === added.path) ?? {
		path: added.path,
		branch,
		name: branch,
		missing: false,
	};
	if (options.activate !== false) activate(pi, ctx, state, worktree);
	return { worktree, origin: added.origin, base: added.base, links, copied, moved, postCreate };
}

export function findWorktree(state: State, ref: string): Worktree | null {
	const wts = refreshWorktrees(state);
	return wts.find((w) => w.branch === ref) ?? wts.find((w) => w.name === ref) ?? wts.find((w) => w.path === ref) ?? null;
}

export async function use(pi: ExtensionAPI, ctx: ExtensionContext, state: State, ref: string, options: { move?: boolean } = {}): Promise<{ worktree: Worktree; links: LinkReport | null; moved: boolean }> {
	requireBare(state);
	const wt = findWorktree(state, ref);
	if (!wt || wt.missing) throw new WorktreeError(`No worktree for '${ref}'. Use action "list" to see them, or "create" to add one.`);
	let moved = false;
	if (options.move && state.active && state.active.path !== wt.path) {
		moved = await stashPush(state.active.path);
		if (moved) await stashPop(wt.path);
	}
	const links = ensureLinks(state, wt.path);
	activate(pi, ctx, state, wt);
	return { worktree: wt, links, moved };
}

export async function remove(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: State,
	ref: string,
	options: { force?: boolean; deleteBranch?: boolean } = {},
): Promise<{ removed: Worktree; branchDeleted: boolean }> {
	const { bare } = requireBare(state);
	const wt = findWorktree(state, ref);
	if (!wt) throw new WorktreeError(`No worktree for '${ref}'.`);
	if (state.isProtected(wt.branch)) throw new WorktreeError(`'${wt.branch}' is protected and cannot be removed.`);
	if (!wt.missing && !options.force && (await isDirty(wt.path))) {
		throw new WorktreeError(`'${wt.name}' has uncommitted changes. Pass force to discard them.`);
	}
	if (wt.missing) await pruneWorktrees(bare);
	else await removeWorktree(bare, wt.path, options.force ?? false);
	let branchDeleted = false;
	if (options.deleteBranch && wt.branch) branchDeleted = await deleteBranch(bare, wt.branch, options.force ?? false);
	refreshWorktrees(state);
	if (state.active?.path === wt.path) activate(pi, ctx, state, worktreeForPath(state.worktrees, state.cwd));
	else publish(pi, ctx, state);
	return { removed: wt, branchDeleted };
}

export async function doctor(state: State, fix: boolean): Promise<DoctorReport> {
	const { bare } = requireBare(state);
	const report: DoctorReport = { missingLinks: [], conflicts: [], detached: [], prunable: [], fixed: { linked: 0, pruned: 0 } };
	const dir = sharedDir(state);
	for (const wt of refreshWorktrees(state)) {
		if (wt.missing) {
			report.prunable.push(wt);
			continue;
		}
		if (dir) {
			const missing = missingLinks(dir, wt.path);
			if (missing.length) {
				if (fix) {
					const r = linkSharedEnv(dir, wt.path);
					report.fixed.linked += r.linked.length;
					if (r.conflicts.length) report.conflicts.push({ worktree: wt, files: r.conflicts });
				} else {
					report.missingLinks.push({ worktree: wt, files: missing });
				}
			}
		}
		if (wt.branch === null) report.detached.push({ worktree: wt, unpushed: await unpushedCommitCount(wt.path) });
	}
	if (fix && report.prunable.length) {
		await pruneWorktrees(bare);
		report.fixed.pruned = report.prunable.length;
		refreshWorktrees(state);
	}
	return report;
}
