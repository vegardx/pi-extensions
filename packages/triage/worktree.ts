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

// ---- Branch → worktree lookup ---------------------------------------

/**
 * Find the worktree path that currently has `branch` checked out, or
 * `null` if the branch is not checked out in any worktree of `repoRoot`.
 *
 * Parses `git worktree list --porcelain`. Records are separated by
 * blank lines; each record starts with a `worktree <path>` line. A
 * record may then contain `HEAD <sha>`, `bare`, `branch <ref>`,
 * `detached`, `locked [<reason>]`, or `prunable [<reason>]`. We only
 * care about records whose `branch` line matches the requested branch.
 */
export function findWorktreeForBranch(
	repoRoot: string,
	branch: string,
): string | null {
	const out = run("git", ["worktree", "list", "--porcelain"], repoRoot).stdout;
	return parseWorktreeList(out, branch);
}

/**
 * Pure parser for `git worktree list --porcelain` output.
 * Exported for tests; not part of the public API contract.
 *
 * Records flagged `prunable` are skipped — their on-disk path is gone
 * (e.g. someone `rm -rf`'d the directory) and `git worktree prune`
 * just hasn't run yet. Returning that path would make every
 * follow-up `git status` fail and look like "uncommitted changes".
 */
export function parseWorktreeList(
	porcelain: string,
	branch: string,
): string | null {
	const target = `branch refs/heads/${branch}`;
	interface Record {
		path: string | null;
		branchLine: string | null;
		prunable: boolean;
	}
	const records: Record[] = [];
	let current: Record | null = null;
	const finalize = () => {
		if (current) records.push(current);
		current = null;
	};
	for (const rawLine of porcelain.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") {
			finalize();
			continue;
		}
		if (line.startsWith("worktree ")) {
			finalize();
			current = {
				path: line.slice("worktree ".length),
				branchLine: null,
				prunable: false,
			};
			continue;
		}
		if (!current) continue;
		if (line.startsWith("branch ")) {
			current.branchLine = line;
		} else if (line === "prunable" || line.startsWith("prunable ")) {
			current.prunable = true;
		}
	}
	finalize();

	for (const r of records) {
		if (r.prunable) continue;
		if (r.path && r.branchLine === target) return r.path;
	}
	return null;
}

/**
 * `true` when the working tree at `wtPath` has no staged, unstaged, or
 * untracked changes. Uses `git status --porcelain` so the check is
 * locale-independent.
 */
function isWorktreeClean(wtPath: string): boolean {
	const r = run("git", ["status", "--porcelain"], wtPath);
	return r.ok && r.stdout === "";
}

// ---- Lifecycle -------------------------------------------------------

export interface TriageWorktree {
	/** Absolute path to the worktree the sub-agent should use. */
	path: string;
	/**
	 * `true` when we adopted a pre-existing worktree (do NOT remove it
	 * during cleanup); `false` when we created it ourselves.
	 */
	reused: boolean;
}

/**
 * Resolve a worktree to use for `pr.headRefName`.
 *
 * Policy: if the branch is already checked out somewhere — main
 * checkout, leftover triage worktree, /develop park-path, ad-hoc — we
 * adopt that worktree iff it has no uncommitted changes. A dirty
 * pre-existing worktree throws so the caller can skip the PR with a
 * clear message instead of risking the agent committing the user's WIP.
 *
 * Otherwise we fetch the branch (if needed) and create a fresh
 * worktree at the canonical triage path.
 *
 * The branch must already exist remotely (PR branches always do).
 */
export function createTriageWorktree(
	pr: PrInfo,
	repoRoot: string,
): TriageWorktree {
	// Adopt an existing worktree if one already holds this branch. This
	// is the single source of truth — `existsSync(canonical)` would miss
	// branches checked out elsewhere (main, /develop, ad-hoc) and would
	// false-positive on a stale directory whose branch is no longer ours.
	const existing = findWorktreeForBranch(repoRoot, pr.headRefName);
	if (existing) {
		// Defence in depth against `git worktree list` racing with manual
		// `rm -rf`. The parser already filters `prunable` records, but a
		// directory deleted *between* `list` and our use here would still
		// look live. Treat a missing path as "no existing worktree" — prune
		// the stale entry so the next `worktree add` doesn't trip on it.
		if (!existsSync(existing)) {
			run("git", ["worktree", "prune"], repoRoot);
		} else {
			if (!isWorktreeClean(existing)) {
				throw new Error(
					`Branch ${pr.headRefName} is checked out at ${existing} with uncommitted changes — stash or commit, then re-run`,
				);
			}
			return { path: existing, reused: true };
		}
	}

	const wtPath = triageWorktreePath(repoRoot, pr.headRefName);
	mkdirSync(dirname(wtPath), { recursive: true });

	// Fetch the branch locally if it isn't present yet.
	const hasBranch = run(
		"git",
		["show-ref", "--verify", "--quiet", `refs/heads/${pr.headRefName}`],
		repoRoot,
	).ok;

	if (!hasBranch) {
		// Use <remote>:<local> refspec so the fetch also creates the local
		// tracking branch. Plain `fetch origin <branch>` only updates
		// FETCH_HEAD; `git worktree add <path> <branch>` then fails because
		// the local branch doesn't exist yet.
		run(
			"git",
			["fetch", "origin", `${pr.headRefName}:${pr.headRefName}`],
			repoRoot,
		);
	}

	const r = run(
		"git",
		// `--` prevents branch names starting with `-` from being
		// misinterpreted as flags.
		["worktree", "add", wtPath, "--", pr.headRefName],
		repoRoot,
	);

	if (!r.ok) {
		throw new Error(
			`Failed to create worktree for PR #${pr.number} (${pr.headRefName}): ${r.stderr}`,
		);
	}

	return { path: wtPath, reused: false };
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
