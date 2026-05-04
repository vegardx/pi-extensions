import { spawnSync } from "node:child_process";

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
): ShellResult {
	const r = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		shell: false,
		env: process.env,
	});
	const exitCode = typeof r.status === "number" ? r.status : -1;
	return {
		ok: exitCode === 0,
		stdout: (r.stdout ?? "").toString(),
		stderr: (r.stderr ?? "").toString(),
		exitCode,
	};
}

export function isGitRepo(cwd: string): boolean {
	return run("git", ["rev-parse", "--is-inside-work-tree"], cwd).ok;
}

export function detectDefaultBranch(cwd: string): string | null {
	const head = run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
	if (head.ok) {
		const match = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		if (
			run(
				"git",
				["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
				cwd,
			).ok
		) {
			return candidate;
		}
	}
	return null;
}

/** Diff of unstaged + staged. Empty string when the tree is clean. */
export function getWorkingDiff(cwd: string): string {
	const r = run("git", ["diff", "HEAD"], cwd);
	return r.ok ? r.stdout : "";
}

export function getStagedDiff(cwd: string): string {
	const r = run("git", ["diff", "--cached"], cwd);
	return r.ok ? r.stdout : "";
}

/**
 * `git diff <default>...HEAD` — all commits on the current branch that
 * aren't on the default. Empty when there are none.
 */
export function getBranchDiff(cwd: string, defaultBranch: string): string {
	const r = run("git", ["diff", `${defaultBranch}...HEAD`], cwd);
	return r.ok ? r.stdout : "";
}

/**
 * `git diff -- <path>` for each path, concatenated. Pure convenience —
 * callers pass already-validated paths.
 */
export function getFileDiff(cwd: string, paths: readonly string[]): string {
	const r = run("git", ["diff", "HEAD", "--", ...paths], cwd);
	return r.ok ? r.stdout : "";
}

/** Lines of `git ls-files`, filtered to non-empty. */
export function listTrackedFiles(cwd: string): string[] {
	const r = run("git", ["ls-files"], cwd);
	if (!r.ok) return [];
	return r.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

/** Unique file paths touched by a unified diff. */
export function filesInDiff(diff: string): string[] {
	const files = new Set<string>();
	for (const line of diff.split("\n")) {
		if (!line.startsWith("diff --git ")) continue;
		// `diff --git a/path b/path` — take the b/ side, it's the new file.
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
	const r = run("git", args, cwd);
	if (!r.ok) return { changedFiles: 0, additions: 0, deletions: 0 };
	const text = r.stdout.trim();
	// " 3 files changed, 42 insertions(+), 7 deletions(-)"
	const files = Number(text.match(/(\d+) files? changed/)?.[1] ?? "0");
	const adds = Number(text.match(/(\d+) insertions?\(\+\)/)?.[1] ?? "0");
	const dels = Number(text.match(/(\d+) deletions?\(-\)/)?.[1] ?? "0");
	return { changedFiles: files, additions: adds, deletions: dels };
}
