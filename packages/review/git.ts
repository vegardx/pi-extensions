/**
 * Git helpers for the review extension. Domain-specific operations
 * (diff extraction, file listing, stats) that build on the shared
 * shell runner.
 */

export type { ShellResult } from "@vegardx/pi-extensions-shared/shell.js";

import { runCommand } from "@vegardx/pi-extensions-shared/shell.js";

export function isGitRepo(cwd: string): boolean {
	return runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

export function detectDefaultBranch(cwd: string): string | null {
	const head = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
	});
	if (head.ok) {
		const match = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		if (
			runCommand(
				"git",
				["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
				{ cwd },
			).ok
		) {
			return candidate;
		}
	}
	return null;
}

/** Diff of unstaged + staged. Empty string when the tree is clean. */
export function getWorkingDiff(cwd: string): string {
	const r = runCommand("git", ["diff", "HEAD"], { cwd });
	return r.ok ? r.stdout : "";
}

/**
 * `git diff <default>...HEAD` — all commits on the current branch that
 * aren't on the default. Empty when there are none.
 */
export function getBranchDiff(cwd: string, defaultBranch: string): string {
	const r = runCommand("git", ["diff", `${defaultBranch}...HEAD`], { cwd });
	return r.ok ? r.stdout : "";
}

/** Unique file paths touched by a unified diff. */
export function filesInDiff(diff: string): string[] {
	const files = new Set<string>();
	for (const line of diff.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		const match = line.match(/\sb\/(.+)$/);
		if (match?.[1]) files.add(match[1]);
	}
	return [...files];
}

export function diffStat(
	cwd: string,
	diffRange?: string,
): {
	changedFiles: number;
	additions: number;
	deletions: number;
} {
	const args = diffRange
		? ["diff", "--shortstat", diffRange]
		: ["diff", "--shortstat", "HEAD"];
	const r = runCommand("git", args, { cwd });
	if (!r.ok) return { changedFiles: 0, additions: 0, deletions: 0 };
	const text = r.stdout.trim();
	const files = Number(text.match(/(\d+) files? changed/)?.[1] ?? "0");
	const adds = Number(text.match(/(\d+) insertions?\(\+\)/)?.[1] ?? "0");
	const dels = Number(text.match(/(\d+) deletions?\(-\)/)?.[1] ?? "0");
	return { changedFiles: files, additions: adds, deletions: dels };
}
