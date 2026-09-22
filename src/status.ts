import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { isDirty, upstreamStatus } from "./repo.ts";
import { missingLinks } from "./shared-env.ts";
import type { State } from "./state.ts";
import { activeIsProtected, isRouted, snapshot } from "./state.ts";

/** Footer status key. Powerline and other bars read it via `statusKey: "wt"`. */
export const STATUS_KEY = "wt";
/** Event bus topic with a `PublicSnapshot` payload. */
export const EVENT_CHANGED = "bare-worktrees:changed";

export function statusText(state: State): string | undefined {
	if (!state.bare) return undefined;
	if (state.enforcement === "off") return "wt off";
	if (!state.active) return "⌂ root · ro";
	const parts: string[] = [];
	const name = state.active.branch ?? "detached";
	parts.push(activeIsProtected(state) ? `⌂ ${name} · ro` : `⎇ ${name}`);
	if (isRouted(state)) parts.push("↪");
	const live = state.live;
	if (live) {
		if (live.dirty) parts.push("●");
		if (live.gone) parts.push("gone");
		else if (live.ahead || live.behind) parts.push(`${live.ahead ? `↑${live.ahead}` : ""}${live.behind ? `↓${live.behind}` : ""}`);
		if (live.missingLinks) parts.push(`⚠${live.missingLinks} links`);
	}
	return parts.join(" ");
}

export function publish(pi: ExtensionAPI, ctx: ExtensionContext, state: State): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusText(state));
	pi.events.emit(EVENT_CHANGED, snapshot(state));
}

/**
 * Refresh dirty/ahead/behind/links in the background. Runs at most one
 * probe at a time; a newer request supersedes an older one, and a result
 * for a worktree that is no longer active is dropped.
 */
export function createLiveRefresher(pi: ExtensionAPI, state: State) {
	let generation = 0;
	let timer: NodeJS.Timeout | null = null;

	const run = async (ctx: ExtensionContext) => {
		const gen = ++generation;
		const active = state.active;
		if (!active || !state.bare) {
			state.live = null;
			publish(pi, ctx, state);
			return;
		}
		const sharedDir = state.config ? join(state.bare.root, state.config.sharedEnv) : null;
		const [dirty, upstream] = await Promise.all([isDirty(active.path), upstreamStatus(active.path)]);
		if (gen !== generation || state.active !== active) return;
		state.live = {
			dirty,
			ahead: upstream?.ahead ?? 0,
			behind: upstream?.behind ?? 0,
			gone: upstream?.gone ?? false,
			missingLinks: sharedDir ? missingLinks(sharedDir, active.path).length : 0,
		};
		publish(pi, ctx, state);
	};

	return {
		/** Debounced; several triggers in a row cost one probe. */
		schedule(ctx: ExtensionContext, delayMs = 150) {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void run(ctx);
			}, delayMs);
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = null;
			generation++;
		},
	};
}
