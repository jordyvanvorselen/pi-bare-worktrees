/**
 * Pure rules: which branches are read-only, which bash commands mutate,
 * how a branch name is derived. No I/O, so every tool call stays cheap.
 */

export function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

export function compileProtected(defaultBranch: string, patterns: readonly string[]): (branch: string | null) => boolean {
	const regexes = patterns.map(globToRegExp);
	return (branch) => {
		if (branch === null) return false;
		if (branch === defaultBranch) return true;
		return regexes.some((r) => r.test(branch));
	};
}

export type BashKind = "worktree-switch" | "git-mutation" | "file-mutation";

export interface BashClassification {
	kind: BashKind;
	/** The fragment that triggered the classification, for the block reason. */
	match: string;
}

// `git checkout <branch>` and `git switch` change which branch a worktree
// holds and break the "path equals branch" rule. `git checkout -- <file>`
// and `git checkout <ref> -- <file>` only restore files and stay allowed.
const WORKTREE_SWITCH = /\bgit\s+(?:-C\s+\S+\s+)?(?:worktree\s+(?:add|remove|move|prune|lock|unlock)|switch\b(?![^\n;&|]*\s--\s)|checkout\b(?![^\n;&|]*\s--(?:\s|$)))/;

const GIT_MUTATION = /\bgit\s+(?:-C\s+\S+\s+)?(?:commit|merge|rebase|reset|push|pull|cherry-pick|revert|am|apply|restore|clean|rm|mv|add|stash\s+(?:pop|apply|drop)|tag|branch\s+(?:-[dDmM]|--delete|--move))\b/;

// Common in-tree writers. Redirects to /dev/null and to absolute paths
// outside the tree are fine; those are filtered by the caller.
const FILE_MUTATION = /(?:^|[\s;&|(])(?:rm|mv|cp|touch|mkdir|rmdir|ln|chmod|chown|truncate|tee|install|patch)\s|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|(?:^|[^<>|&\d])>{1,2}\s*(?!\/dev\/null|&)/m;

export function classifyBash(command: string): BashClassification | null {
	const stripped = stripQuotedHeredocs(command);
	const sw = WORKTREE_SWITCH.exec(stripped);
	if (sw) return { kind: "worktree-switch", match: sw[0].trim() };
	const gm = GIT_MUTATION.exec(stripped);
	if (gm) return { kind: "git-mutation", match: gm[0].trim() };
	const fm = FILE_MUTATION.exec(stripped);
	if (fm) return { kind: "file-mutation", match: fm[0].trim() };
	return null;
}

function stripQuotedHeredocs(command: string): string {
	// Heredoc bodies are data, not commands: drop them so `cat <<EOF` with
	// a `>` inside does not read as a redirect.
	return command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1\s*$/gm, "<<HEREDOC");
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "");
}

export function renderBranch(template: string, slug: string): string {
	return template.replace(/\{slug\}/g, slug);
}

const INVALID_REF = /(^|\/)\.|\.\.|[\s~^:?*[\\]|\/\/|\/$|\.lock$|^@$|@\{|^-/;

export function validateBranchName(branch: string): string | null {
	if (!branch) return "branch name is empty";
	if (INVALID_REF.test(branch)) return `'${branch}' is not a valid git branch name`;
	return null;
}

/** Quote for POSIX sh single-quoted string. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
