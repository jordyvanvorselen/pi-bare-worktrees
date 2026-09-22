import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBash, compileProtected, renderBranch, shellQuote, slugify, validateBranchName } from "../src/policy.ts";

describe("compileProtected", () => {
	const isProtected = compileProtected("main", ["release/*", "hotfix/?.?"]);

	it("protects the default branch", () => assert.equal(isProtected("main"), true));
	it("protects glob matches across slashes", () => assert.equal(isProtected("release/5.2.0"), true));
	it("treats ? as one character", () => {
		assert.equal(isProtected("hotfix/1.2"), true);
		assert.equal(isProtected("hotfix/1.22"), false);
	});
	it("leaves feature branches writable", () => assert.equal(isProtected("feat/login"), false));
	it("never protects a detached head", () => assert.equal(isProtected(null), false));
});

describe("classifyBash", () => {
	const kind = (cmd: string) => classifyBash(cmd)?.kind ?? null;

	it("blocks git worktree and branch switching always", () => {
		assert.equal(kind("git worktree add ../x feat/x"), "worktree-switch");
		assert.equal(kind("git switch main"), "worktree-switch");
		assert.equal(kind("git checkout -b feat/x"), "worktree-switch");
		assert.equal(kind("git -C ../main checkout main"), "worktree-switch");
	});
	it("allows checkout that only restores files", () => {
		assert.equal(kind("git checkout -- src/a.ts"), null);
		assert.equal(kind("git checkout HEAD~1 -- src/a.ts"), null);
	});
	it("classifies git history mutations", () => {
		assert.equal(kind("git commit -m x"), "git-mutation");
		assert.equal(kind("git add -A && git commit -m x"), "git-mutation");
		assert.equal(kind("git stash pop"), "git-mutation");
		assert.equal(kind("git push origin HEAD"), "git-mutation");
	});
	it("leaves read-only git alone", () => {
		assert.equal(kind("git status"), null);
		assert.equal(kind("git log --oneline -5"), null);
		assert.equal(kind("git diff main...HEAD"), null);
		assert.equal(kind("git stash list"), null);
		assert.equal(kind("git branch -a"), null);
	});
	it("classifies in-tree file writers", () => {
		assert.equal(kind("rm -rf build"), "file-mutation");
		assert.equal(kind("sed -i '' 's/a/b/' x.ts"), "file-mutation");
		assert.equal(kind("echo hi > out.txt"), "file-mutation");
		assert.equal(kind("cat a >> b"), "file-mutation");
		assert.equal(kind("mkdir -p tmp"), "file-mutation");
	});
	it("does not flag builds, tests and harmless redirects", () => {
		assert.equal(kind("mvn -q test 2>/dev/null"), null);
		assert.equal(kind("yarn test 2>&1 | tail -20"), null);
		assert.equal(kind("ls -la"), null);
		assert.equal(kind("grep -rn foo src"), null);
		assert.equal(kind("npm run build"), null);
	});
	it("ignores redirects inside a heredoc body", () => {
		assert.equal(kind("cat <<'EOF'\na > b\nEOF"), null);
	});
	it("names the offending fragment", () => {
		assert.equal(classifyBash("git commit -m x")?.match, "git commit");
	});
});

describe("branch naming", () => {
	it("slugifies task text", () => {
		assert.equal(slugify("Fix login redirect (HSHCD-123)"), "fix-login-redirect-hshcd-123");
		assert.equal(slugify("  Ünïcode & symbols!  "), "unicode-symbols");
	});
	it("renders the template", () => assert.equal(renderBranch("feat/{slug}", "x"), "feat/x"));
	it("validates ref names", () => {
		assert.equal(validateBranchName("feat/x"), null);
		assert.notEqual(validateBranchName(""), null);
		assert.notEqual(validateBranchName("feat/.hidden"), null);
		assert.notEqual(validateBranchName("a..b"), null);
		assert.notEqual(validateBranchName("has space"), null);
		assert.notEqual(validateBranchName("-lead"), null);
		assert.notEqual(validateBranchName("x.lock"), null);
	});
});

describe("shellQuote", () => {
	it("quotes single quotes safely", () => assert.equal(shellQuote("it's"), `'it'\\''s'`));
});
