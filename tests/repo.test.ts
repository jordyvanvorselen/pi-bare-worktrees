import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { addWorktree, findBareRoot, goneBranches, listWorktrees, removeWorktree, worktreeForPath, worktreePath } from "../src/repo.ts";
import { linkSharedEnv, missingLinks } from "../src/shared-env.ts";
import { makeBareRepo, sh } from "./helpers.ts";

describe("bare repo layout", () => {
	let repo: ReturnType<typeof makeBareRepo>;
	before(() => {
		repo = makeBareRepo();
	});
	after(() => repo.cleanup());

	it("finds the root from any worktree depth without spawning git", () => {
		const found = findBareRoot(join(repo.root, "main"));
		assert.equal(found?.root, repo.root);
		assert.equal(found?.bareDir, join(repo.root, ".bare"));
		assert.equal(found?.defaultBranch, "main");
		assert.equal(findBareRoot(repo.root)?.root, repo.root);
	});

	it("returns null outside a bare layout", () => {
		assert.equal(findBareRoot("/"), null);
	});

	it("lists worktrees from the bare metadata", () => {
		const bare = findBareRoot(repo.root)!;
		const wts = listWorktrees(bare);
		assert.deepEqual(wts.map((w) => [w.name, w.branch, w.missing]), [["main", "main", false]]);
	});

	it("adds an existing local, a remote-only, and a new branch at <root>/<branch>", async () => {
		const bare = findBareRoot(repo.root)!;
		const remote = await addWorktree(bare, "feat/remote-only");
		assert.equal(remote.origin, "remote");
		assert.equal(remote.path, join(repo.root, "feat", "remote-only"));

		const fresh = await addWorktree(bare, "feat/new-thing");
		assert.equal(fresh.origin, "new");
		assert.equal(fresh.base, "main");

		sh(join(repo.root, ".bare"), "git", ["branch", "chore/local", "main"]);
		const local = await addWorktree(bare, "chore/local");
		assert.equal(local.origin, "local");

		const names = listWorktrees(bare).map((w) => w.name);
		assert.deepEqual(names, ["chore/local", "feat/new-thing", "feat/remote-only", "main"]);
	});

	it("resolves the deepest worktree for a path", () => {
		const bare = findBareRoot(repo.root)!;
		const wts = listWorktrees(bare);
		assert.equal(worktreeForPath(wts, join(repo.root, "feat", "new-thing", "src", "x.ts"))?.branch, "feat/new-thing");
		assert.equal(worktreeForPath(wts, join(repo.root, "feat"))?.branch, undefined);
		assert.equal(worktreeForPath(wts, repo.root), null);
	});

	it("marks a worktree whose directory was deleted as missing", async () => {
		const bare = findBareRoot(repo.root)!;
		rmSync(worktreePath(bare, "chore/local"), { recursive: true });
		const wt = listWorktrees(bare).find((w) => w.name === "chore/local");
		assert.equal(wt?.missing, true);
	});

	it("reports branches whose upstream is gone", async () => {
		const bare = findBareRoot(repo.root)!;
		sh(repo.origin, "git", ["branch", "-D", "feat/remote-only"]);
		sh(bare.bareDir, "git", ["fetch", "--prune", "-q", "origin"]);
		assert.deepEqual(await goneBranches(bare), ["feat/remote-only"]);
	});

	it("removes a worktree", async () => {
		const bare = findBareRoot(repo.root)!;
		await removeWorktree(bare, worktreePath(bare, "feat/remote-only"), false);
		assert.equal(existsSync(worktreePath(bare, "feat/remote-only")), false);
	});
});

describe("shared env links", () => {
	let repo: ReturnType<typeof makeBareRepo>;
	before(() => {
		repo = makeBareRepo();
	});
	after(() => repo.cleanup());

	it("mirrors every file as an absolute symlink at the same relative path", () => {
		const shared = join(repo.root, ".shared-env");
		const wt = join(repo.root, "main");
		const report = linkSharedEnv(shared, wt);
		assert.deepEqual(report.linked, [".env", "app/.env"]);
		assert.equal(readlinkSync(join(wt, "app", ".env")), join(shared, "app", ".env"));
		assert.deepEqual(missingLinks(shared, wt), []);
	});

	it("is idempotent and re-points stale links", () => {
		const shared = join(repo.root, ".shared-env");
		const wt = join(repo.root, "main");
		assert.deepEqual(linkSharedEnv(shared, wt).linked, []);
		rmSync(join(wt, ".env"));
		sh(wt, "ln", ["-s", "/nowhere", ".env"]);
		assert.deepEqual(missingLinks(shared, wt), [".env"]);
		assert.deepEqual(linkSharedEnv(shared, wt).linked, [".env"]);
	});

	it("never clobbers a real file", () => {
		const shared = join(repo.root, ".shared-env");
		const wt = join(repo.root, "main");
		rmSync(join(wt, ".env"));
		writeFileSync(join(wt, ".env"), "MINE=1\n");
		const report = linkSharedEnv(shared, wt);
		assert.deepEqual(report.conflicts, [".env"]);
		assert.equal(lstatSync(join(wt, ".env")).isSymbolicLink(), false);
		assert.deepEqual(missingLinks(shared, wt), [], "a deliberate real file is not reported as missing");
	});
});
