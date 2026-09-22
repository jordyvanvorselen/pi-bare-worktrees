import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { create, doctor, ensureLinks, refreshWorktrees, remove, use, WorktreeError } from "./operations.ts";
import type { State } from "./state.ts";
import { activeIsProtected, isRouted, snapshot } from "./state.ts";
import type { LiveRefresher } from "./types.ts";

export const TOOL_NAME = "worktree";

const params = Type.Object({
	action: StringEnum(["create", "use", "list", "status", "link", "remove", "doctor"] as const),
	branch: Type.Optional(Type.String({ description: "Branch name. Required for create, use and remove." })),
	from: Type.Optional(Type.String({ description: "Base ref for a new branch. Defaults to the configured base branch." })),
	move: Type.Optional(Type.Boolean({ description: "Carry uncommitted changes from the current worktree into the target." })),
	force: Type.Optional(Type.Boolean({ description: "remove: discard uncommitted changes and delete the branch." })),
});

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

function describeActive(state: State): string {
	const s = snapshot(state);
	if (!s.root) return "Not inside a bare checkout.";
	if (!s.active) return `Active: none (at root ${s.root}, read-only).`;
	const flags = [s.active.protected ? "protected, read-only" : "writable", s.routed ? "tools routed here" : "session cwd"];
	return `Active: ${s.active.branch ?? "(detached)"} at ${s.active.path} (${flags.join(", ")}).`;
}

export function registerWorktreeTool(pi: ExtensionAPI, state: State, refresher: LiveRefresher): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Worktree",
		description:
			"Manage git worktrees in this bare checkout. Call create before the first code change when the active branch is protected; " +
			"after create or use, every other tool runs inside that worktree. Never use cd, git worktree, git checkout or git switch for this.",
		promptSnippet: "Create, switch, list and repair git worktrees (one directory per branch)",
		promptGuidelines: [
			"Call worktree create with a branch named from the task before editing on a protected branch.",
			"Use worktree use to enter an existing worktree instead of cd.",
		],
		parameters: params,
		async execute(_id, input, _signal, _onUpdate, ctx) {
			try {
				switch (input.action) {
					case "create": {
						if (!input.branch) return text("create needs a branch name.");
						const r = await create(pi, ctx, state, input.branch, { ...(input.from ? { from: input.from } : {}), ...(input.move ? { move: true } : {}) });
						refresher.schedule(ctx);
						const lines = [
							`Created worktree ${r.worktree.name} at ${r.worktree.path} (${r.origin === "new" ? `new branch off ${r.base}` : r.origin === "remote" ? "tracking origin" : "existing branch"}).`,
							`Shared env: ${r.links.linked.length} linked, ${r.links.kept.length} kept${r.links.conflicts.length ? `, conflicts: ${r.links.conflicts.join(", ")}` : ""}.`,
						];
						if (r.copied.length) lines.push(`Copied: ${r.copied.join(", ")}.`);
						if (r.moved) lines.push("Uncommitted changes were moved into the new worktree.");
						for (const p of r.postCreate) lines.push(`post-create \`${p.command}\` exited ${p.code}${p.code ? `:\n${p.output}` : ""}`);
						lines.push("All tools now run inside this worktree. Continue with the task.");
						return text(lines.join("\n"));
					}
					case "use": {
						if (!input.branch) return text("use needs a branch name.");
						const r = await use(pi, ctx, state, input.branch, input.move ? { move: true } : {});
						refresher.schedule(ctx);
						return text(
							`Active worktree is now ${r.worktree.name} at ${r.worktree.path}${state.isProtected(r.worktree.branch) ? " (protected, read-only)" : ""}.` +
								(r.links?.linked.length ? ` Linked ${r.links.linked.length} shared env files.` : "") +
								(r.moved ? " Uncommitted changes were moved along." : ""),
						);
					}
					case "list": {
						const wts = refreshWorktrees(state);
						const lines = wts.map((w) => {
							const marks = [
								w.path === state.active?.path ? "active" : "",
								state.isProtected(w.branch) ? "protected" : "",
								w.branch === null ? "detached" : "",
								w.missing ? "missing" : "",
							].filter(Boolean);
							return `${w.branch ?? "(detached)"}\t${w.path}${marks.length ? `\t[${marks.join(", ")}]` : ""}`;
						});
						return text(lines.length ? lines.join("\n") : "No worktrees.");
					}
					case "status":
						return text(
							`${describeActive(state)} Enforcement ${state.enforcement}.` +
								(state.enforcement === "on" && activeIsProtected(state) ? " Create a worktree before making changes." : "") +
								(isRouted(state) ? ` Session cwd is ${state.cwd}; /wt sync moves the session there.` : ""),
						);
					case "link": {
						if (!state.active) return text("No active worktree.");
						const r = ensureLinks(state, state.active.path);
						refresher.schedule(ctx);
						return text(r ? `Linked ${r.linked.length}, kept ${r.kept.length}${r.conflicts.length ? `, conflicts: ${r.conflicts.join(", ")}` : ""}.` : "All shared env links present.");
					}
					case "remove": {
						if (!input.branch) return text("remove needs a branch name.");
						const r = await remove(pi, ctx, state, input.branch, { force: input.force ?? false, deleteBranch: input.force ?? false });
						return text(`Removed worktree ${r.removed.name}${r.branchDeleted ? " and deleted its branch" : ""}. ${describeActive(state)}`);
					}
					case "doctor": {
						const r = await doctor(state, true);
						const lines = [`Linked ${r.fixed.linked} files, pruned ${r.fixed.pruned} stale worktrees.`];
						for (const c of r.conflicts) lines.push(`Conflicts in ${c.worktree.name}: ${c.files.join(", ")}`);
						for (const d of r.detached) lines.push(`Detached HEAD: ${d.worktree.name}${d.unpushed ? ` (${d.unpushed} unpushed commits)` : ""}`);
						return text(lines.join("\n"));
					}
				}
			} catch (error) {
				if (error instanceof WorktreeError) return text(`worktree ${input.action} failed: ${error.message}`);
				throw error;
			}
		},
	});
}
