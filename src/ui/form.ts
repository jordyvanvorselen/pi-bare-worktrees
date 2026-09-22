import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface TextField {
	kind: "text";
	id: string;
	label: string;
	/** Prefilled value; the user edits it in place. */
	value: string;
	/** One-line explanation shown while the field has focus. */
	help?: string;
	/** Shown dim when the value is empty, e.g. "none". */
	empty?: string;
}

export interface ToggleField {
	kind: "toggle";
	id: string;
	label: string;
	value: boolean;
	help?: string;
}

export type FormField = TextField | ToggleField;
export type FormValues = Record<string, string | boolean>;

/** Minimal slice of the host theme, so tests can pass a plain object. */
export interface FormTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	inverse(text: string): string;
}

export type FormAction = "continue" | "submit" | "cancel";

const PRINTABLE = /^[^\u0000-\u001f\u007f]+$/u;

/**
 * Keyboard state for a single-screen form. Values start at their defaults and
 * are edited in place, so Enter alone accepts everything. Kept free of
 * rendering so the key handling can be tested without a terminal.
 */
export class FormModel {
	readonly fields: FormField[];
	index = 0;
	/** Caret position inside the focused text field. */
	cursor: number;

	constructor(fields: FormField[]) {
		this.fields = fields.map((f) => ({ ...f }));
		this.cursor = this.focused?.kind === "text" ? this.focused.value.length : 0;
	}

	get focused(): FormField | undefined {
		return this.fields[this.index];
	}

	values(): FormValues {
		const out: FormValues = {};
		for (const f of this.fields) out[f.id] = f.kind === "text" ? f.value.trim() : f.value;
		return out;
	}

	private move(delta: number) {
		const next = this.index + delta;
		if (next < 0 || next >= this.fields.length) return;
		this.index = next;
		const field = this.focused;
		this.cursor = field?.kind === "text" ? field.value.length : 0;
	}

	handleInput(data: string): FormAction {
		if (matchesKey(data, Key.escape)) return "cancel";
		if (matchesKey(data, Key.ctrl("s"))) return "submit";
		if (matchesKey(data, Key.enter)) {
			if (this.index === this.fields.length - 1) return "submit";
			this.move(1);
			return "continue";
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
			this.move(-1);
			return "continue";
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
			this.move(1);
			return "continue";
		}
		const field = this.focused;
		if (!field) return "continue";
		if (field.kind === "toggle") {
			if (data === " " || matchesKey(data, Key.left) || matchesKey(data, Key.right)) field.value = !field.value;
			return "continue";
		}
		this.editText(field, data);
		return "continue";
	}

	private editText(field: TextField, data: string) {
		const set = (value: string, cursor: number) => {
			field.value = value;
			this.cursor = Math.max(0, Math.min(cursor, value.length));
		};
		if (matchesKey(data, Key.left)) return void (this.cursor = Math.max(0, this.cursor - 1));
		if (matchesKey(data, Key.right)) return void (this.cursor = Math.min(field.value.length, this.cursor + 1));
		if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) return void (this.cursor = 0);
		if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) return void (this.cursor = field.value.length);
		if (matchesKey(data, Key.ctrl("u"))) return set("", 0);
		if (matchesKey(data, Key.ctrl("w"))) {
			const head = field.value.slice(0, this.cursor).replace(/\S*\s*$/, "");
			return set(head + field.value.slice(this.cursor), head.length);
		}
		if (matchesKey(data, Key.backspace)) {
			if (!this.cursor) return;
			return set(field.value.slice(0, this.cursor - 1) + field.value.slice(this.cursor), this.cursor - 1);
		}
		if (matchesKey(data, Key.delete)) return set(field.value.slice(0, this.cursor) + field.value.slice(this.cursor + 1), this.cursor);
		if (!PRINTABLE.test(data)) return;
		set(field.value.slice(0, this.cursor) + data + field.value.slice(this.cursor), this.cursor + data.length);
	}

	render(width: number, theme: FormTheme, title: string): string[] {
		const labelWidth = Math.max(...this.fields.map((f) => f.label.length)) + 2;
		const valueWidth = Math.max(8, width - labelWidth - 5);
		const lines = [theme.fg("accent", theme.bold(` ${title}`)), theme.fg("dim", " ↑↓ field · type to edit · enter next · ctrl+s save · esc cancel"), ""];
		this.fields.forEach((field, i) => {
			const active = i === this.index;
			const pointer = active ? theme.fg("accent", "› ") : "  ";
			const label = (active ? theme.fg("text", field.label) : theme.fg("muted", field.label)) + " ".repeat(labelWidth - field.label.length);
			lines.push(truncateToWidth(`${pointer}${label}${this.renderValue(field, active, theme, valueWidth)}`, width));
		});
		const help = this.focused?.help;
		if (help) lines.push("", theme.fg("dim", ` ${truncateToWidth(help, Math.max(8, width - 2))}`));
		return lines;
	}

	private renderValue(field: FormField, active: boolean, theme: FormTheme, valueWidth: number): string {
		if (field.kind === "toggle") {
			const text = field.value ? "[x] yes" : "[ ] no";
			return active ? theme.fg("accent", text) + theme.fg("dim", "  space toggles") : theme.fg(field.value ? "text" : "muted", text);
		}
		if (!active) return field.value ? theme.fg("muted", truncateToWidth(field.value, valueWidth)) : theme.fg("dim", field.empty ?? "none");
		const start = Math.max(0, this.cursor - valueWidth + 1);
		const view = field.value.slice(start, start + valueWidth);
		const at = this.cursor - start;
		const caret = theme.inverse(view[at] ?? " ");
		const body = theme.fg("text", view.slice(0, at)) + caret + theme.fg("text", view.slice(at + 1));
		return field.value ? body : body + theme.fg("dim", field.empty ?? "none");
	}
}

/**
 * Show `fields` as one editable screen. Resolves with the edited values, null
 * when the user cancels, or undefined when the host has no TUI to draw on
 * (RPC and print modes), so the caller can fall back to prompts.
 */
export async function editForm(ctx: ExtensionContext, title: string, fields: FormField[]): Promise<FormValues | null | undefined> {
	const model = new FormModel(fields);
	const result = await ctx.ui.custom<FormValues | null>(
		(tui, theme, _kb, done) => ({
			render: (width: number) => model.render(width, theme, title),
			invalidate() {},
			handleInput(data: string) {
				const action = model.handleInput(data);
				if (action === "cancel") return done(null);
				if (action === "submit") return done(model.values());
				tui.requestRender();
			},
		}),
		{ overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
	);
	return result;
}
