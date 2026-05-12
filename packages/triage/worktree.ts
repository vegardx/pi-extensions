/**
 * Worktree helpers for the triage extension.
 *
 * Each PR gets its own worktree so sub-agents can check out, fix,
 * commit, and push in parallel without blocking each other on the
 * main working tree.
 *
 * Path convention (mirrors modes):
 *   <parent-of-repo>/worktrees/<repo-name>/triage/<sanitized-branch>/
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface PrInfo {
	number: number;
	title: string;
	/** The PR's head branch name. */
	headRefName: string;
}

// ---- Internal shell helper -------------------------------------------

interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function run(cmd: string, args: string[], cwd: string): ShellResult {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		shell: false,
		env: process.env,
	});
	return {
		ok: (r.status ?? -1) === 0,
		stdout: (r.stdout ?? "").toString().trim(),
		stderr: (r.stderr ?? "").toString().trim(),
	};
}

// ---- Repo helpers ----------------------------------------------------

/**
 * Resolve the git repo root from any path inside it.
 * Returns null if `cwd` is not inside a git repo.
 */
export function getRepoRoot(cwd: string): string | null {
	const r = run("git", ["rev-parse", "--show-toplevel"], cwd);
	return r.ok ? r.stdout : null;
}

// ---- Path convention ------------------------------------------------

/**
 * Canonical worktree path for a triage session on `prBranch`.
 * Lives beside the repo, never inside it.
 */
export function triageWorktreePath(repoRoot: string, prBranch: string): string {
	const abs = resolve(repoRoot);
	const parent = dirname(abs);
	const repoName = basename(abs);
	// Sanitize branch name: keep alphanum, dot, hyphen, underscore.
	const safe = prBranch.replace(/[^a-zA-Z0-9._-]/g, "-");
	return join(parent, "worktrees", repoName, "triage", safe);
}

// ---- Lifecycle -------------------------------------------------------

/**
 * Create a worktree for `pr.headRefName` at the canonical triage path.
 * The branch must already exist remotely (PR branches always do).
 *
 * Returns the worktree path on success. Throws on failure.
 */
export function createTriageWorktree(pr: PrInfo, repoRoot: string): string {
	const wtPath = triageWorktreePath(repoRoot, pr.headRefName);

	if (existsSync(wtPath)) return wtPath;

	// Ensure the parent directory exists.
	mkdirSync(dirname(wtPath), { recursive: true });

	// Fetch the branch locally if it isn't present yet.
	const hasBranch = run(
		"git",
		["show-ref", "--verify", "--quiet", `refs/heads/${pr.headRefName}`],
		repoRoot,
	).ok;

	if (!hasBranch) {
		// Fetch from origin so we can check the branch out.
		run("git", ["fetch", "origin", pr.headRefName], repoRoot);
	}

	const r = run("git", ["worktree", "add", wtPath, pr.headRefName], repoRoot);

	if (!r.ok) {
		throw new Error(
			`Failed to create worktree for PR #${pr.number} (${pr.headRefName}): ${r.stderr}`,
		);
	}

	return wtPath;
}

/**
 * Remove the worktree at `wtPath`. Force-removes to handle any
 * uncommitted files left by a crashed sub-agent.
 *
 * Safe to call when the path doesn't exist.
 */
export function removeTriageWorktree(wtPath: string, repoRoot: string): void {
	if (!existsSync(wtPath)) return;
	// --force so dirty trees don't block cleanup.
	run("git", ["worktree", "remove", "--force", wtPath], repoRoot);
}
