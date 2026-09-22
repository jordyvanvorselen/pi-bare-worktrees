import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface PickerItem {
	id: string;
	label: string;
	/** Short badges shown after the label, e.g. "dirty", "gone". */
	badges?: string[];
	checked: boolean;
}

/**
 * Checkbox list overlay. Space toggles, `a` selects all, `n` none, Enter
 * confirms, Esc cancels. Resolves with the checked ids or null.
 */
export function pickMany(ctx: ExtensionContext, title: string, items: PickerItem[]): Promise<string[] | null> {
	const state = items.map((i) => ({ ...i }));
	let cursor = 0;
	return ctx.ui.custom<string[] | null>(
		(tui, theme, _kb, done) => {
			const render = (width: number): string[] => {
				const lines: string[] = [];
				lines.push(theme.fg("accent", ` ${title}`));
				lines.push(theme.fg("dim", " space toggle · a all · n none · enter confirm · esc cancel"));
				lines.push("");
				state.forEach((item, index) => {
					const box = item.checked ? theme.fg("accent", "[x]") : theme.fg("dim", "[ ]");
					const pointer = index === cursor ? theme.fg("accent", "› ") : "  ";
					const badges = item.badges?.length ? " " + item.badges.map((b) => theme.fg("warning", b)).join(" ") : "";
					const label = index === cursor ? theme.fg("text", item.label) : theme.fg("muted", item.label);
					lines.push(truncateToWidth(`${pointer}${box} ${label}${badges}`, width));
				});
				lines.push("");
				lines.push(theme.fg("dim", ` ${state.filter((i) => i.checked).length} of ${state.length} selected`));
				return lines;
			};
			return {
				render,
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) return done(null);
					if (matchesKey(data, Key.enter)) return done(state.filter((i) => i.checked).map((i) => i.id));
					if (matchesKey(data, Key.up) || data === "k") cursor = Math.max(0, cursor - 1);
					else if (matchesKey(data, Key.down) || data === "j") cursor = Math.min(state.length - 1, cursor + 1);
					else if (data === " ") {
						const item = state[cursor];
						if (item) item.checked = !item.checked;
					} else if (data === "a") for (const i of state) i.checked = true;
					else if (data === "n") for (const i of state) i.checked = false;
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "70%" } },
	);
}
