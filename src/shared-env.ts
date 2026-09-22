import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface LinkReport {
	/** Links created or re-pointed. */
	linked: string[];
	/** Links already correct. */
	kept: string[];
	/** Real files in the way; left untouched. */
	conflicts: string[];
}

/** Every regular file under `sharedDir`, as paths relative to it. */
export function listSharedFiles(sharedDir: string): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(relative(sharedDir, full));
		}
	};
	walk(sharedDir);
	return files.sort();
}

/**
 * Mirror every file under `sharedDir` as a symlink at the same relative
 * path inside `worktree`. Existing symlinks are re-pointed, real files are
 * reported as conflicts and left alone.
 */
export function linkSharedEnv(sharedDir: string, worktree: string): LinkReport {
	const report: LinkReport = { linked: [], kept: [], conflicts: [] };
	for (const rel of listSharedFiles(sharedDir)) {
		const source = join(sharedDir, rel);
		const target = join(worktree, rel);
		let existing: ReturnType<typeof lstatSync> | undefined;
		try {
			existing = lstatSync(target);
		} catch {
			existing = undefined;
		}
		if (existing) {
			if (!existing.isSymbolicLink()) {
				report.conflicts.push(rel);
				continue;
			}
			if (readlinkSync(target) === source) {
				report.kept.push(rel);
				continue;
			}
			unlinkSync(target);
		}
		try {
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(source, target);
			report.linked.push(rel);
		} catch {
			report.conflicts.push(rel);
		}
	}
	return report;
}

/** Shared files with no correct link in `worktree`. lstat only, no writes. */
export function missingLinks(sharedDir: string, worktree: string): string[] {
	const missing: string[] = [];
	for (const rel of listSharedFiles(sharedDir)) {
		const target = join(worktree, rel);
		try {
			const st = lstatSync(target);
			if (st.isSymbolicLink() && readlinkSync(target) === join(sharedDir, rel)) continue;
			if (!st.isSymbolicLink()) continue; // a real file counts as deliberate
		} catch {
			// not there
		}
		missing.push(rel);
	}
	return missing;
}

/** Copy `paths` (relative) from `fromWorktree` into `toWorktree`, skipping what does not exist. */
export function copyExtras(fromWorktree: string, toWorktree: string, paths: readonly string[]): string[] {
	const copied: string[] = [];
	for (const rel of paths) {
		const source = join(fromWorktree, rel);
		const target = join(toWorktree, rel);
		if (!existsSync(source) || existsSync(target)) continue;
		try {
			mkdirSync(dirname(target), { recursive: true });
			cpSync(source, target, { recursive: true, dereference: false });
			copied.push(rel);
		} catch {
			// best effort; report only what succeeded
		}
	}
	return copied;
}
