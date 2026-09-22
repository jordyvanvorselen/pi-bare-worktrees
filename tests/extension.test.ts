import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import ext from "../src/index.ts";
import { makeBareRepo } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(cwd: string) {
	const handlers: Record<string, Handler[]> = {};
	const tools: Record<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }> = {};
	let active = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"];
	const entries: unknown[] = [];
	const notices: string[] = [];
	const pi = {
		on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
		registerTool: (t: { name: string; execute: never }) => {
			tools[t.name] = t;
			active.push(t.name);
		},
		registerCommand: () => {},
		appendEntry: (t: string, d: unknown) => entries.push({ t, d }),
		getActiveTools: () => active,
		setActiveTools: (n: string[]) => {
			active = n;
		},
		events: { emit: () => {} },
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui: { setStatus: () => {}, notify: (m: string) => notices.push(m) },
		sessionManager: { getBranch: () => [] },
	};
	ext(pi as never);
	const fire = async (e: string, ev: object) => {
		let result: unknown;
		for (const h of handlers[e] ?? []) result = (await h(ev, ctx)) ?? result;
		return result as { block?: boolean; reason?: string } | undefined;
	};
	const call = (toolName: string, input: Record<string, unknown>) => fire("tool_call", { type: "tool_call", toolName, toolCallId: "t", input }).then((r) => ({ r, input }));
	return { fire, call, tools, ctx, entries, notices, isActive: () => active.includes("worktree") };
}

describe("extension wiring", () => {
	let repo: ReturnType<typeof makeBareRepo>;
	before(() => {
		repo = makeBareRepo();
	});
	after(() => repo.cleanup());

	it("blocks writes on main, creates a worktree through the tool, then routes and allows", async () => {
		const h = harness(join(repo.root, "main"));
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.isActive(), true);

		const blocked = await h.call("edit", { path: "README.md" });
		assert.match(blocked.r?.reason ?? "", /worktree\(\{action:"create"/);

		const result = await h.tools.worktree!.execute("id", { action: "create", branch: "feat/routed" }, undefined, undefined, h.ctx);
		assert.match(result.content[0]!.text, /Created worktree feat\/routed/);

		const edit = await h.call("edit", { path: "README.md" });
		assert.equal(edit.r, undefined, "writes in the new worktree pass");
		assert.equal(edit.input.path, join(repo.root, "feat", "routed", "README.md"), "relative paths are rewritten into the worktree");

		const bash = await h.call("bash", { command: "git commit -am x" });
		assert.equal(bash.r, undefined);
		assert.equal(bash.input.command, `cd '${join(repo.root, "feat", "routed")}'\ngit commit -am x`);

		const grep = await h.call("grep", { pattern: "hi" });
		assert.equal(grep.input.path, join(repo.root, "feat", "routed"), "cwd-default tools get the worktree as path");

		const mainWrite = await h.call("write", { path: join(repo.root, "main", "x.txt"), content: "" });
		assert.match(mainWrite.r?.reason ?? "", /protected/, "absolute writes into main stay blocked");

		const sw = await h.call("bash", { command: "git switch main" });
		assert.match(sw.r?.reason ?? "", /worktree tool/);

		const sub = await h.call("subagent", { agent: "worker", task: "x" });
		assert.equal(sub.input.cwd, join(repo.root, "feat", "routed"));
	});

	it("turns itself off outside a bare checkout and warns once at startup", async () => {
		const h = harness(repo.root.replace(/\/repo$/, ""));
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.isActive(), false);
		assert.equal(h.notices.length, 1);
		assert.match(h.notices[0]!, /not a bare checkout/);
		const edit = await h.call("edit", { path: "x" });
		assert.equal(edit.r, undefined);
	});

	it("restores the active worktree and enforcement from session entries", async () => {
		const h = harness(join(repo.root, "main"));
		h.ctx.sessionManager.getBranch = () =>
			[
				{ type: "custom", customType: "bare-worktrees", data: { active: { branch: "feat/routed", path: join(repo.root, "feat", "routed") } } },
				{ type: "custom", customType: "bare-worktrees", data: { enforcement: "off" } },
			] as never;
		await h.fire("session_start", { type: "session_start", reason: "resume" });
		const opts = { sections: {} as Record<string, string>, toolGuidelines: {} as Record<string, string[]> };
		await h.fire("before_agent_start", { systemPromptOptions: opts });
		assert.match(opts.sections.worktrees ?? "", /Active worktree: feat\/routed/);
		assert.match(opts.sections.worktrees ?? "", /enforcement OFF/);
		const commit = await h.call("bash", { command: "git commit -m x" });
		assert.equal(commit.r, undefined);
		assert.match(commit.input.command as string, /^cd /, "routing still applies with enforcement off");
	});
});
