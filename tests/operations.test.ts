import assert from "node:assert/strict";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildRepoConfig, DEFAULT_SETTINGS } from "../src/config.ts";
import { create, doctor, remove, use, WorktreeError } from "../src/operations.ts";
import { compileProtected } from "../src/policy.ts";
import { findBareRoot, listWorktrees } from "../src/repo.ts";
import type { State } from "../src/state.ts";
import { ENTRY_TYPE } from "../src/state.ts";
import { makeBareRepo, sh } from "./helpers.ts";

function fakePi() {
	const entries: { type: string; data: unknown }[] = [];
	const events: { name: string; data: unknown }[] = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		events: { emit: (name: string, data: unknown) => events.push({ name, data }) },
	};
	return { pi: pi as never, entries, events };
}

const ctx = { hasUI: false, ui: { setStatus() {} } } as never;

describe("operations", () => {
	let repo: ReturnType<typeof makeBareRepo>;
	let state: State;
	before(() => {
		repo = makeBareRepo();
		const bare = findBareRoot(repo.root)!;
		const config = buildRepoConfig(new Map(), bare.defaultBranch, DEFAULT_SETTINGS);
		config.postCreate = ["echo created > .post-create"];
		state = {
			settings: DEFAULT_SETTINGS,
			bare,
			config,
			configured: true,
			worktrees: listWorktrees(bare),
			active: null,
			cwd: join(repo.root, "main"),
			enforcement: "on",
			isProtected: compileProtected("main", config.protected),
			live: null,
		};
		state.active = state.worktrees[0]!;
	});
	after(() => repo.cleanup());

	it("creates a worktree, links shared env, runs post-create, activates and records it", async () => {
		const { pi, entries, events } = fakePi();
		const r = await create(pi, ctx, state, "feat/one");
		assert.equal(r.worktree.path, join(repo.root, "feat", "one"));
		assert.deepEqual(r.links.linked, [".env", "app/.env"]);
		assert.equal(lstatSync(join(r.worktree.path, "app", ".env")).isSymbolicLink(), true);
		assert.equal(r.postCreate[0]?.code, 0);
		assert.equal(existsSync(join(r.worktree.path, ".post-create")), true);
		assert.equal(state.active?.branch, "feat/one");
		assert.deepEqual(entries.at(-1), { type: ENTRY_TYPE, data: { active: { branch: "feat/one", path: r.worktree.path } } });
		assert.equal(events.at(-1)?.name, "bare-worktrees:changed");
	});

	it("refuses a duplicate and an invalid name", async () => {
		const { pi } = fakePi();
		await assert.rejects(create(pi, ctx, state, "feat/one"), WorktreeError);
		await assert.rejects(create(pi, ctx, state, "bad name"), WorktreeError);
	});

	it("moves uncommitted changes with --move", async () => {
		const { pi } = fakePi();
		writeFileSync(join(state.active!.path, "wip.txt"), "wip\n");
		const r = await create(pi, ctx, state, "feat/two", { move: true });
		assert.equal(r.moved, true);
		assert.equal(existsSync(join(r.worktree.path, "wip.txt")), true);
		assert.equal(existsSync(join(repo.root, "feat", "one", "wip.txt")), false);
	});

	it("switches with use and re-links when links are missing", async () => {
		const { pi } = fakePi();
		sh(join(repo.root, "feat", "one"), "rm", [".env"]);
		const r = await use(pi, ctx, state, "feat/one");
		assert.equal(state.active?.branch, "feat/one");
		assert.deepEqual(r.links?.linked, [".env"]);
	});

	it("refuses to remove a dirty worktree without force, and a protected one at all", async () => {
		const { pi } = fakePi();
		await assert.rejects(remove(pi, ctx, state, "feat/two"), /uncommitted/);
		await assert.rejects(remove(pi, ctx, state, "main"), /protected/);
	});

	it("removes with force, deletes the branch, and falls back to the cwd worktree", async () => {
		const { pi } = fakePi();
		await use(pi, ctx, state, "feat/two");
		const r = await remove(pi, ctx, state, "feat/two", { force: true, deleteBranch: true });
		assert.equal(r.branchDeleted, true);
		assert.equal(existsSync(join(repo.root, "feat", "two")), false);
		assert.equal(state.active?.branch, "main");
		assert.equal(sh(state.bare!.bareDir, "git", ["branch", "--list", "feat/two"]), "");
	});

	it("doctor links every worktree that misses links and reports detached heads", async () => {
		sh(join(repo.root, "feat", "one"), "rm", ["app/.env"]);
		sh(join(repo.root, "feat", "one"), "git", ["checkout", "-q", "--detach"]);
		const dry = await doctor(state, false);
		assert.deepEqual(
			dry.missingLinks.map((m) => [m.worktree.name, m.files]),
			[["feat/one", ["app/.env"]], ["main", [".env", "app/.env"]]],
			"main was created by git in the fixture and never linked",
		);
		assert.deepEqual(dry.detached.map((d) => d.worktree.name), ["feat/one"]);
		const fixed = await doctor(state, true);
		assert.equal(fixed.fixed.linked, 3);
		assert.deepEqual((await doctor(state, false)).missingLinks, []);
	});
});
