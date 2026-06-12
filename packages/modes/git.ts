/**
 * Git helpers for the modes extension. Domain-specific operations
 * (branch management, worktree checks) that build on the shared
 * shell runner.
 */
export {
	DEFAULT_COMMAND_TIMEOUT_MS,
	nonInteractiveEnv,
	runCommand,
	runCommandAsync,
	type ShellResult,
} from "@vegardx/pi-extensions-shared/shell.js";

import {
	runCommand,
	runCommandAsync,
	type ShellResult,
} from "@vegardx/pi-extensions-shared/shell.js";

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

/**
 * Abortable `git pull --ff-only`. Network op — runs on the async runner
 * so a stalled fetch can't freeze the TUI and Esc can cancel it.
 */
export function pullFastForwardAsync(
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return runCommandAsync("git", ["pull", "--ff-only", "origin", branch], {
		cwd,
		signal,
	});
}

/**
 * Abortable `git push -u origin <branch>`. Network op — see
 * {@link pullFastForwardAsync}.
 */
export function pushBranchAsync(
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return runCommandAsync("git", ["push", "-u", "origin", branch], {
		cwd,
		signal,
	});
}

export function createBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", "-b", branch], { cwd });
}
