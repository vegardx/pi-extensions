import { spawnSync } from "node:child_process";

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Thin wrapper around `spawnSync` tuned for git/gh commands: captures stdout
 * and stderr, never throws. Callers branch on `ok` / `exitCode`.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: { cwd?: string; stdin?: string } = {},
): ShellResult {
	const result = spawnSync(command, args, {
		cwd: opts.cwd,
		input: opts.stdin,
		encoding: "utf8",
		// Belt-and-braces: no shell interpolation, no env inheritance surprises.
		shell: false,
		env: process.env,
	});
	const exitCode = typeof result.status === "number" ? result.status : -1;
	return {
		ok: exitCode === 0,
		stdout: (result.stdout ?? "").toString(),
		stderr: (result.stderr ?? "").toString(),
		exitCode,
	};
}

/** `true` if `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
	return runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

/** Current branch or `null` on detached HEAD / bare repo. */
export function currentBranch(cwd: string): string | null {
	const r = runCommand("git", ["branch", "--show-current"], { cwd });
	if (!r.ok) return null;
	const trimmed = r.stdout.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the default branch from the remote's HEAD symbolic-ref, falling
 * back to `main` → `master` existence checks. Returns `null` if neither
 * approach pins down a branch.
 */
export function detectDefaultBranch(cwd: string): string | null {
	const head = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
	});
	if (head.ok) {
		const match = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		const exists = runCommand(
			"git",
			["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
			{ cwd },
		);
		if (exists.ok) return candidate;
	}
	return null;
}

/** `true` if the working tree is clean (no modified, staged, or untracked). */
export function workingTreeClean(cwd: string): boolean {
	const r = runCommand("git", ["status", "--porcelain"], { cwd });
	return r.ok && r.stdout.trim().length === 0;
}

/** Git-branch a name. No-throws — returns the raw shell result. */
export function checkoutBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", branch], { cwd });
}

export function pullFastForward(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["pull", "--ff-only", "origin", branch], { cwd });
}

export function createBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", "-b", branch], { cwd });
}

/** Wrapper around `git config` setting a branch-scoped key. */
export function setBranchConfig(
	cwd: string,
	branch: string,
	key: string,
	value: string,
): ShellResult {
	return runCommand("git", ["config", `branch.${branch}.${key}`, value], {
		cwd,
	});
}
