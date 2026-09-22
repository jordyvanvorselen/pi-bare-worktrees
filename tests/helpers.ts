import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sh(cwd: string, cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Build `<root>/.bare` with a `main` worktree, an `origin` remote, and a
 * `.shared-env` holding two files. Returns the root; caller removes it.
 */
export function makeBareRepo(): { root: string; origin: string; cleanup: () => void } {
	const base = mkdtempSync(join(tmpdir(), "pi-bare-wt-"));
	const origin = join(base, "origin.git");
	const root = join(base, "repo");
	const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
	const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();

	// seed origin with one commit on main
	const seed = join(base, "seed");
	mkdirSync(seed);
	g(seed, "init", "-q", "-b", "main");
	writeFileSync(join(seed, "README.md"), "hi\n");
	writeFileSync(join(seed, ".gitignore"), ".env\n");
	g(seed, "add", ".");
	g(seed, "commit", "-q", "-m", "init");
	g(seed, "branch", "feat/remote-only");
	g(base, "clone", "-q", "--bare", seed, origin);

	// bare layout
	mkdirSync(root);
	g(root, "clone", "-q", "--bare", origin, ".bare");
	g(join(root, ".bare"), "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
	// a bare clone copies every branch locally; drop the extra one so it is remote-only
	g(join(root, ".bare"), "branch", "-D", "feat/remote-only");
	g(join(root, ".bare"), "fetch", "-q", "origin");
	g(join(root, ".bare"), "worktree", "add", "-q", join(root, "main"), "main");

	mkdirSync(join(root, ".shared-env", "app"), { recursive: true });
	writeFileSync(join(root, ".shared-env", ".env"), "TOP=1\n");
	writeFileSync(join(root, ".shared-env", "app", ".env"), "APP=1\n");

	return { root: realpathSync(root), origin, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
