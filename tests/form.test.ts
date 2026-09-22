import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configFromForm, setupFields } from "../src/commands.ts";
import { DEFAULT_REPO_CONFIG, type RepoConfig } from "../src/config.ts";
import { FormModel, type FormTheme } from "../src/ui/form.ts";

const ESC = "\x1b";
const ENTER = "\r";
const BACKSPACE = "\x7f";

const theme: FormTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => `[${text}]`,
};

const config: RepoConfig = { ...DEFAULT_REPO_CONFIG, baseBranch: "main" };

function model() {
	return new FormModel(setupFields(config, "main"));
}

describe("setup form", () => {
	it("shows the default value of every field, so enter alone keeps it", () => {
		const lines = model().render(80, theme, "Set up bare worktrees").join("\n");
		assert.match(lines, /Shared env directory\s+\.shared-env/, "the default shared env dir is visible");
		assert.match(lines, /Base branch\s+main/);
		assert.match(lines, /Branch template\s+feat\/\{slug\}/);
	});

	it("submits the prefilled defaults when the user only presses enter", () => {
		const form = model();
		let action = "continue";
		for (let i = 0; i < form.fields.length; i++) action = form.handleInput(ENTER);
		assert.equal(action, "submit");
		assert.deepEqual(configFromForm(form.values(), config, "main"), config);
	});

	it("edits the focused field in place and keeps the other defaults", () => {
		const form = model();
		form.handleInput(BACKSPACE);
		form.handleInput("v");
		assert.equal(form.values().sharedEnv, ".shared-env".slice(0, -1) + "v");
		assert.equal(form.values().baseBranch, "main");
	});

	it("clears a field with ctrl+u so a blank falls back to the current value", () => {
		const form = model();
		form.handleInput("\x15");
		assert.equal(form.values().sharedEnv, "");
		assert.equal(configFromForm(form.values(), config, "main").sharedEnv, ".shared-env");
	});

	it("toggles booleans with space instead of asking a separate question", () => {
		const form = model();
		const fetchIndex = form.fields.findIndex((f) => f.id === "fetchBeforeCreate");
		for (let i = 0; i < fetchIndex; i++) form.handleInput(ENTER);
		form.handleInput(" ");
		assert.equal(form.values().fetchBeforeCreate, true);
		form.handleInput(" ");
		assert.equal(form.values().fetchBeforeCreate, false);
	});

	it("saves from any field with ctrl+s and cancels with esc", () => {
		assert.equal(model().handleInput("\x13"), "submit");
		assert.equal(model().handleInput(ESC), "cancel");
	});

	it("splits list and command fields on save", () => {
		const values = { ...model().values(), protected: "release/*, hotfix/*", postCreate: "npm ci && npm run build", copy: ".idea" };
		const parsed = configFromForm(values, config, "main");
		assert.deepEqual(parsed.protected, ["release/*", "hotfix/*"]);
		assert.deepEqual(parsed.postCreate, ["npm ci", "npm run build"]);
		assert.deepEqual(parsed.copy, [".idea"]);
	});
});
