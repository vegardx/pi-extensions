/**
 * Git worktree management for the phase/task plan system.
 *
 * Worktrees are bound to active work: a phase has a worktree only while
 * its status is `active` or `needs-attention`. They live at:
 *
 *   ../worktrees/<repo-name>/<plan-slug>/<phase-slug>/
 *
 * The repo-name segment scopes worktrees so that two repos sharing a
 * parent dir (and thus a `../worktrees/` directory) don't collide on
 * matching plan/phase slugs.
 *
 * Branches are kept forever — never auto-deleted by this module.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCommand, type ShellResult, workingTreeClean } from "../git.js";
import {
	type Plan,
	type Phase as PlanPhase,
	repoNameFromPath,
} from "./schema.js";

/**
 * Compute the absolute worktree path for a phase.
 *
 * `repo.path` is the repo's working dir. Worktree goes one level up at
 * `<parent>/worktrees/<repo-name>/<plan-slug>/<phase-id>/`.
 */
export function worktreePath(plan: Plan, phase: PlanPhase): string {
	const repoPath = resolve(plan.repo.path);
	const parent = dirname(repoPath);
	const repoName = repoNameFromPath(repoPath);
	return join(parent, "worktrees", repoName, plan.slug, phase.id);
}

/**
 * Create a worktree for a phase.
 *
 * If the branch is already checked out somewhere (typically the main
 * repo dir, after `git checkout -b`), reuse that location instead of
 * creating a new worktree — git refuses to check out the same branch
 * in two worktrees, and "the worktree for this phase" is just "wherever
 * the phase branch is currently checked out".
 *
 * Returns the absolute worktree path on success, or a failure result.
 */
export function createWorktree(
	plan: Plan,
	phase: PlanPhase,
	baseBranch: string,
): { ok: true; path: string } | { ok: false; error: string } {
	const repoPath = resolve(plan.repo.path);
	const path = worktreePath(plan, phase);

	if (existsSync(path)) {
		return { ok: true, path };
	}

	// If the branch is already checked out in some worktree (commonly the
	// main repo dir), reuse that path. git won't let us check out the
	// same branch twice anyway.
	const existingWorktree = findCheckoutOf(repoPath, phase.branch);
	if (existingWorktree) {
		return { ok: true, path: existingWorktree };
	}

	// Ensure parent directory tree exists. `git worktree add` requires the
	// final dir to NOT exist but allows ancestors to.
	const parent = dirname(path);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

	// Does the branch already exist locally?
	const branchExists = runCommand(
		"git",
		["show-ref", "--verify", "--quiet", `refs/heads/${phase.branch}`],
		{ cwd: repoPath },
	).ok;

	const args = ["worktree", "add"];
	if (branchExists) {
		args.push(path, phase.branch);
	} else {
		args.push("-b", phase.branch, path, baseBranch);
	}

	const result = runCommand("git", args, { cwd: repoPath });
	if (!result.ok) {
		return {
			ok: false,
			error: `git worktree add failed: ${result.stderr.trim() || "unknown error"}`,
		};
	}
	return { ok: true, path };
}

/**
 * Find the existing worktree where `branch` is currently checked out,
 * or null if no worktree has it. Parses `git worktree list --porcelain`.
 */
function findCheckoutOf(repoPath: string, branch: string): string | null {
	const r = runCommand("git", ["worktree", "list", "--porcelain"], {
		cwd: repoPath,
	});
	if (!r.ok) return null;
	let currentWorktree: string | null = null;
	const target = `refs/heads/${branch}`;
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			currentWorktree = line.slice("worktree ".length).trim();
		} else if (line.startsWith("branch ") && currentWorktree) {
			const ref = line.slice("branch ".length).trim();
			if (ref === target) return currentWorktree;
		}
	}
	return null;
}

/**
 * Remove a worktree. Refuses if dirty unless `force` is true.
 *
 * Branches are never deleted by this function. The branch persists so
 * that the worktree can be re-created cheaply later (e.g. when a phase
 * comes back to `needs-attention`).
 */
export function removeWorktree(
	plan: Plan,
	phase: PlanPhase,
	options: { force?: boolean } = {},
): { ok: true } | { ok: false; error: string; reason?: "dirty" } {
	const path = worktreePath(plan, phase);
	if (!existsSync(path)) {
		return { ok: true };
	}

	if (!options.force && !workingTreeClean(path)) {
		return {
			ok: false,
			error: `worktree ${path} has uncommitted changes`,
			reason: "dirty",
		};
	}

	const repoPath = resolve(plan.repo.path);
	const args = ["worktree", "remove"];
	if (options.force) args.push("--force");
	args.push(path);

	const result = runCommand("git", args, { cwd: repoPath });
	if (!result.ok) {
		return {
			ok: false,
			error: `git worktree remove failed: ${result.stderr.trim()}`,
		};
	}
	return { ok: true };
}

/**
 * List all worktrees git knows about for a repo. Returns absolute paths.
 */
export function listWorktrees(repoPath: string): string[] {
	const r = runCommand("git", ["worktree", "list", "--porcelain"], {
		cwd: repoPath,
	});
	if (!r.ok) return [];
	const paths: string[] = [];
	for (const line of r.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			paths.push(line.slice("worktree ".length).trim());
		}
	}
	return paths;
}

/** True if a worktree exists at the canonical path for a phase. */
export function worktreeExists(plan: Plan, phase: PlanPhase): boolean {
	return existsSync(worktreePath(plan, phase));
}

/** Re-export for callers that want raw shell access to git. */
export type { ShellResult };
