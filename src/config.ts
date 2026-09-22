import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { git } from "./git.ts";

/** Git config section in `<bare>/config` that holds per-repo settings. */
export const CONFIG_SECTION = "bare-worktrees";

/** Per-repo configuration, read from the bare repo's config file. */
export interface RepoConfig {
	/** Directory under the root mirrored into every worktree as symlinks. */
	sharedEnv: string;
	/** Base for new branches. Defaults to the bare HEAD. */
	baseBranch: string;
	/** Glob patterns of read-only branches, in addition to the base branch. */
	protected: string[];
	/** Branch name template for new work; `{slug}` is replaced by the task slug. */
	branchTemplate: string;
	/** Run `git fetch --prune` before creating a worktree. */
	fetchBeforeCreate: boolean;
	/** Paths copied (not linked) from the base worktree into a new one. */
	copy: string[];
	/** Commands run inside a new worktree after creation. */
	postCreate: string[];
	/** Re-link shared env on session start when links are missing. */
	autoLink: boolean;
}

/** Global settings in `<agentDir>/pi-bare-worktrees.json`. */
export interface Settings {
	/** Warn at startup when the project is not a bare checkout. */
	warnWhenNotBare: boolean;
	/** Add the `<worktrees>` section to the system prompt. */
	systemPrompt: boolean;
	/** Optional template file that replaces the built-in section text. */
	systemPromptFile?: string;
	/** Defaults applied when a repo has no value for a key. */
	defaults?: Partial<RepoConfig>;
}

export const DEFAULT_SETTINGS: Settings = {
	warnWhenNotBare: true,
	systemPrompt: true,
};

export const DEFAULT_REPO_CONFIG: Omit<RepoConfig, "baseBranch"> = {
	sharedEnv: ".shared-env",
	protected: ["release/*"],
	branchTemplate: "feat/{slug}",
	fetchBeforeCreate: false,
	copy: [],
	postCreate: [],
	autoLink: true,
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function settingsPath(): string {
	return join(agentDir(), "pi-bare-worktrees.json");
}

export function loadSettings(): Settings {
	const path = settingsPath();
	if (!existsSync(path)) return DEFAULT_SETTINGS;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

/**
 * Parse the `[bare-worktrees]` section of a git config file into a
 * multi-map. Keys are lower-cased, like git does. Only this section is
 * read, so includes and conditionals are ignored on purpose.
 */
export function parseConfigSection(content: string, section = CONFIG_SECTION): Map<string, string[]> {
	const values = new Map<string, string[]>();
	let inSection = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[")) {
			inSection = line.toLowerCase() === `[${section.toLowerCase()}]`;
			continue;
		}
		if (!inSection) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		let value = line.slice(eq + 1).trim();
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			value = value.slice(1, -1).replace(/\\(.)/g, "$1");
		}
		const list = values.get(key) ?? [];
		list.push(value);
		values.set(key, list);
	}
	return values;
}

function bool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return /^(true|yes|on|1)$/i.test(value);
}

/** True when the repo has been through `/wt setup` (or was configured by hand). */
export function isConfigured(values: Map<string, string[]>): boolean {
	return values.has("sharedenv");
}

export function buildRepoConfig(values: Map<string, string[]>, defaultBranch: string, settings: Settings): RepoConfig {
	const d = { ...DEFAULT_REPO_CONFIG, ...settings.defaults };
	const one = (key: string): string | undefined => values.get(key)?.at(-1);
	const many = (key: string): string[] | undefined => values.get(key);
	return {
		sharedEnv: one("sharedenv") ?? d.sharedEnv,
		baseBranch: one("basebranch") ?? d.baseBranch ?? defaultBranch,
		protected: many("protected") ?? d.protected,
		branchTemplate: one("branchtemplate") ?? d.branchTemplate,
		fetchBeforeCreate: bool(one("fetchbeforecreate"), d.fetchBeforeCreate),
		copy: many("copy") ?? d.copy,
		postCreate: many("postcreate") ?? d.postCreate,
		autoLink: bool(one("autolink"), d.autoLink),
	};
}

export function readRepoConfigValues(bareDir: string): Map<string, string[]> {
	try {
		return parseConfigSection(readFileSync(join(bareDir, "config"), "utf8"));
	} catch {
		return new Map();
	}
}

/** Write the config through git so quoting and locking stay correct. */
export async function writeRepoConfig(bareDir: string, config: RepoConfig): Promise<void> {
	const file = join(bareDir, "config");
	const set = async (key: string, value: string) => {
		await git(bareDir, ["config", "--file", file, `${CONFIG_SECTION}.${key}`, value]);
	};
	const setAll = async (key: string, values: string[]) => {
		await git(bareDir, ["config", "--file", file, "--unset-all", `${CONFIG_SECTION}.${key}`]);
		for (const v of values) await git(bareDir, ["config", "--file", file, "--add", `${CONFIG_SECTION}.${key}`, v]);
	};
	await set("sharedEnv", config.sharedEnv);
	await set("baseBranch", config.baseBranch);
	await setAll("protected", config.protected);
	await set("branchTemplate", config.branchTemplate);
	await set("fetchBeforeCreate", String(config.fetchBeforeCreate));
	await setAll("copy", config.copy);
	await setAll("postCreate", config.postCreate);
	await set("autoLink", String(config.autoLink));
}
