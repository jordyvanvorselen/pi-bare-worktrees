import { execFile } from "node:child_process";

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Run git with `args` in `cwd`. Never throws on a non-zero exit; callers
 * decide what a failure means. Output is trimmed.
 */
export function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
			(error, stdout, stderr) => {
				const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
					? ((error as { code: number }).code)
					: error
						? 1
						: 0;
				resolve({ stdout: String(stdout).trim(), stderr: String(stderr).trim(), code });
			},
		);
	});
}

/** Run git and throw with stderr when it fails. */
export async function gitOrThrow(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
	const result = await git(cwd, args, timeoutMs);
	if (result.code !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed (${result.code})`);
	}
	return result.stdout;
}
