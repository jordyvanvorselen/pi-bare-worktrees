import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRepoConfig, DEFAULT_SETTINGS, isConfigured, parseConfigSection } from "../src/config.ts";

const sample = `[core]
	bare = true
[bare-worktrees]
	sharedEnv = .shared-env
	protected = release/*
	protected = "hotfix/*"
	fetchBeforeCreate = yes
	postCreate = yarn install --immutable
[remote "origin"]
	url = git@github.com:x/y.git
`;

describe("parseConfigSection", () => {
	it("reads only the bare-worktrees section, keys lower-cased", () => {
		const values = parseConfigSection(sample);
		assert.deepEqual(values.get("sharedenv"), [".shared-env"]);
		assert.equal(values.has("bare"), false);
		assert.equal(values.has("url"), false);
	});
	it("keeps multi-valued keys in order and strips quotes", () => {
		assert.deepEqual(parseConfigSection(sample).get("protected"), ["release/*", "hotfix/*"]);
	});
	it("keeps the whole value after the first equals sign", () => {
		assert.deepEqual(parseConfigSection(sample).get("postcreate"), ["yarn install --immutable"]);
	});
});

describe("buildRepoConfig", () => {
	it("falls back to defaults and the bare HEAD branch", () => {
		const config = buildRepoConfig(new Map(), "develop", DEFAULT_SETTINGS);
		assert.equal(config.baseBranch, "develop");
		assert.equal(config.branchTemplate, "feat/{slug}");
		assert.deepEqual(config.protected, ["release/*"]);
		assert.equal(config.autoLink, true);
	});
	it("parses booleans loosely, like git", () => {
		const config = buildRepoConfig(parseConfigSection(sample), "main", DEFAULT_SETTINGS);
		assert.equal(config.fetchBeforeCreate, true);
	});
	it("prefers global defaults over built-ins, and repo values over both", () => {
		const settings = { ...DEFAULT_SETTINGS, defaults: { branchTemplate: "task/{slug}", sharedEnv: ".env-shared" } };
		const config = buildRepoConfig(parseConfigSection(sample), "main", settings);
		assert.equal(config.branchTemplate, "task/{slug}");
		assert.equal(config.sharedEnv, ".shared-env");
	});
	it("treats sharedEnv presence as the setup marker", () => {
		assert.equal(isConfigured(parseConfigSection(sample)), true);
		assert.equal(isConfigured(new Map()), false);
	});
});
