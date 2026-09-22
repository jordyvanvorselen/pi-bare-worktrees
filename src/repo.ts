import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { git, gitOrThrow } from "./git.ts";

/** A bare repo plus the directory its worktrees live in. */
export interface BareRoot {
	/** Directory that contains the bare repo and every worktree. */
	root: string;
	/** The bare repo itself, e.g. `<root>/.bare`. */
	bareDir: string;
	/** Branch the bare HEAD points to. */
	defaultBranch: string;
}

export interface Worktree {
	/** Absolute path. */
	path: string;
	/** Branch name, or null for a detached HEAD. */
	branch: string | null;
	/** Path relative to the root, which by convention equals the branch. */
	name: string;
	/** True when the directory is gone and `git worktree prune` would drop it. */
	missing: boolean;
}

const BARE_DIR_NAMES = [".bare"];

// With `extensions.worktreeConfig` git moves `core.bare` into `config.worktree`.
function readBareConfigFlag(bareDir: string): boolean {
	for (const file of ["config", "config.worktree"]) {
		try {
			if (/^\s*bare\s*=\s*true\s*$/im.test(readFileSync(join(bareDir, file), "utf8"))) return true;
		} catch {
			// try the next file
		}
	}
	return false;
}

function isBareDir(dir: string): boolean {
	return existsSync(join(dir, "HEAD")) && readBareConfigFlag(dir);
}

/**
 * Walk up from `cwd` until a directory holds a bare repo in `.bare/`.
 * Filesystem only, no git process, so it is safe to call on every session start.
 */
export function findBareRoot(cwd: string): BareRoot | null {
	let dir = canonical(cwd);
	for (;;) {
		for (const name of BARE_DIR_NAMES) {
			const bareDir = join(dir, name);
			if (isBareDir(bareDir)) {
				return { root: dir, bareDir, defaultBranch: readDefaultBranch(bareDir) };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Resolve symlinks so paths compare equal to what git writes in its metadata (macOS `/var` → `/private/var`). */
export function canonical(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

export function readDefaultBranch(bareDir: string): string {
	try {
		const head = readFileSync(join(bareDir, "HEAD"), "utf8").trim();
		const match = /^ref: refs\/heads\/(.+)$/.exec(head);
		if (match?.[1]) return match[1];
	} catch {
		// fall through
	}
	return "main";
}

function readHeadBranch(gitDir: string): string | null {
	try {
		const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
		const match = /^ref: refs\/heads\/(.+)$/.exec(head);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

export function relativeName(root: string, path: string): string {
	const prefix = root.endsWith(sep) ? root : root + sep;
	return path.startsWith(prefix) ? path.slice(prefix.length).split(sep).join("/") : path;
}

/**
 * List worktrees by reading `<bare>/worktrees/<id>/{gitdir,HEAD}` directly.
 * Same data `git worktree list --porcelain` reports, without spawning git.
 */
export function listWorktrees(bare: BareRoot): Worktree[] {
	const dir = join(bare.bareDir, "worktrees");
	let ids: string[];
	try {
		ids = readdirSync(dir);
	} catch {
		return [];
	}
	const result: Worktree[] = [];
	for (const id of ids) {
		const entry = join(dir, id);
		let gitdir: string;
		try {
			gitdir = readFileSync(join(entry, "gitdir"), "utf8").trim();
		} catch {
			continue;
		}
		// gitdir points at `<worktree>/.git`
		const path = resolve(dirname(gitdir));
		const missing = !existsSync(gitdir);
		result.push({ path, branch: readHeadBranch(entry), name: relativeName(bare.root, path), missing });
	}
	result.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

/** Deepest worktree whose path contains `path`, or null. */
export function worktreeForPath(worktrees: readonly Worktree[], path: string): Worktree | null {
	const target = resolve(path);
	let best: Worktree | null = null;
	for (const wt of worktrees) {
		if (target === wt.path || target.startsWith(wt.path + sep)) {
			if (!best || wt.path.length > best.path.length) best = wt;
		}
	}
	return best;
}

export function isInsideRoot(bare: BareRoot, path: string): boolean {
	const target = resolve(path);
	return target === bare.root || target.startsWith(bare.root + sep);
}

export function worktreePath(bare: BareRoot, branch: string): string {
	return join(bare.root, ...branch.split("/"));
}

async function refExists(bare: BareRoot, ref: string): Promise<boolean> {
	const r = await git(bare.bareDir, ["show-ref", "--verify", "--quiet", ref]);
	return r.code === 0;
}

export type BranchOrigin = "local" | "remote" | "new";

/**
 * Check out `branch` at `<root>/<branch>`: an existing branch as-is, a
 * remote-only branch tracking origin, a new one off `from`.
 */
export async function addWorktree(bare: BareRoot, branch: string, from?: string): Promise<{ path: string; origin: BranchOrigin; base: string | undefined }> {
	const path = worktreePath(bare, branch);
	if (existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0) {
		throw new Error(`${path} already exists and is not empty`);
	}
	if (await refExists(bare, `refs/heads/${branch}`)) {
		await gitOrThrow(bare.bareDir, ["worktree", "add", path, branch]);
		return { path, origin: "local", base: undefined };
	}
	if (await refExists(bare, `refs/remotes/origin/${branch}`)) {
		await gitOrThrow(bare.bareDir, ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]);
		return { path, origin: "remote", base: `origin/${branch}` };
	}
	const base = from ?? bare.defaultBranch;
	await gitOrThrow(bare.bareDir, ["worktree", "add", "-b", branch, path, base]);
	return { path, origin: "new", base };
}

export async function removeWorktree(bare: BareRoot, path: string, force: boolean): Promise<void> {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(path);
	await gitOrThrow(bare.bareDir, args);
}

export async function pruneWorktrees(bare: BareRoot): Promise<void> {
	await git(bare.bareDir, ["worktree", "prune"]);
}

export async function deleteBranch(bare: BareRoot, branch: string, force: boolean): Promise<boolean> {
	const r = await git(bare.bareDir, ["branch", force ? "-D" : "-d", branch]);
	return r.code === 0;
}

export async function fetchPrune(bare: BareRoot): Promise<void> {
	await gitOrThrow(bare.bareDir, ["fetch", "--prune", "--quiet", "origin"], 120_000);
}

export async function isDirty(path: string): Promise<boolean> {
	const r = await git(path, ["status", "--porcelain", "--no-renames"], 10_000);
	return r.code === 0 && r.stdout.length > 0;
}

export interface Upstream {
	ahead: number;
	behind: number;
	gone: boolean;
}

export async function upstreamStatus(path: string): Promise<Upstream | null> {
	const r = await git(path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], 10_000);
	if (r.code !== 0) {
		// No upstream, or the upstream ref was deleted after a prune.
		const cfg = await git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 10_000);
		return cfg.code === 0 ? null : (cfg.stderr.includes("no upstream") ? null : { ahead: 0, behind: 0, gone: true });
	}
	const [ahead = "0", behind = "0"] = r.stdout.split(/\s+/);
	return { ahead: Number(ahead), behind: Number(behind), gone: false };
}

/** Local branches whose upstream was deleted on the remote. */
export async function goneBranches(bare: BareRoot): Promise<string[]> {
	const out = await gitOrThrow(bare.bareDir, ["for-each-ref", "--format=%(refname:short)\t%(upstream:track)", "refs/heads"]);
	const gone: string[] = [];
	for (const line of out.split("\n")) {
		const [name, track] = line.split("\t");
		if (name && track === "[gone]") gone.push(name);
	}
	return gone;
}

/** Commits on HEAD that no other ref reaches; used to warn before dropping a detached worktree. */
export async function unpushedCommitCount(path: string): Promise<number> {
	const r = await git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes", "--branches"], 10_000);
	return r.code === 0 ? Number(r.stdout) || 0 : 0;
}

export async function stashPush(path: string): Promise<boolean> {
	const r = await git(path, ["stash", "push", "--include-untracked", "--quiet", "-m", "pi-bare-worktrees --move"]);
	return r.code === 0 && !/No local changes/i.test(r.stdout + r.stderr);
}

export async function stashPop(path: string): Promise<void> {
	await gitOrThrow(path, ["stash", "pop", "--quiet"]);
}
