/**
 * Git worktree management for the phase/task plan system.
 *
 * Worktrees are bound to active work: a phase has a worktree only while
 * its status is `active` or `needs-attention`. The canonical location is:
 *
 *   <parent-of-repo>/worktrees/<repo-name>/<plan-slug>/<phase-id>/
 *
 * But the *actual* path is whatever `phase.worktreePath` says — in
 * particular, when /implement first activates a phase the branch is
 * checked out in the main repo dir, so `phase.worktreePath` points
 * there and this module reuses it instead of trying to create a second
 * worktree (git would refuse anyway).
 *
 * Branches are kept forever — never auto-deleted by this module.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCommand, workingTreeClean } from "../git.js";
import {
	type Plan,
	type Deliverable as PlanPhase,
	repoNameFromPath,
} from "./schema.js";

/**
 * Compute the canonical worktree path for a phase. Used as the target
 * when no checkout exists yet; once a phase has `worktreePath` set,
 * callers should prefer that over recomputing this.
 */
export function worktreePath(plan: Plan, phase: PlanPhase): string {
	const repoPath = resolve(plan.repo.path);
	const parent = dirname(repoPath);
	const repoName = repoNameFromPath(repoPath);
	return join(parent, "worktrees", repoName, plan.slug, phase.id);
}

/**
 * The path where this phase's branch currently lives. Prefer the
 * persisted `phase.worktreePath`; fall back to the canonical path.
 */
export function effectiveWorktreePath(plan: Plan, phase: PlanPhase): string {
	return phase.worktreePath ?? worktreePath(plan, phase);
}

/**
 * Create a worktree for a phase.
 *
 * If the branch is already checked out somewhere (typically the main
 * repo dir, after `git checkout -b`), reuse that location — git refuses
 * to check out the same branch in two worktrees.
 *
 * Returns the resolved path and a `created` flag. `created: false`
 * means we reused an existing checkout and did not run `git worktree
 * add`. Callers should persist `phase.worktreePath = result.path` and
 * use `created` to decide whether to surface a "worktree ready"
 * notification.
 */
export function createWorktree(
	plan: Plan,
	phase: PlanPhase,
	baseBranch: string,
): { ok: true; path: string; created: boolean } | { ok: false; error: string } {
	const repoPath = resolve(plan.repo.path);
	const canonical = worktreePath(plan, phase);

	// Groupings and lifecycle checklists have no branch; nothing to
	// check out. /implement refuses them before getting here, so this
	// is a defensive guard.
	const branch = phase.branch;
	if (!branch) {
		return {
			ok: false,
			error: `deliverable \`${phase.id}\` has no branch — groupings and lifecycle checklists don't get worktrees`,
		};
	}

	if (existsSync(canonical)) {
		return { ok: true, path: canonical, created: false };
	}

	// If the branch is already checked out in some worktree (commonly the
	// main repo dir), reuse that path.
	const existing = findCheckoutOf(repoPath, branch);
	if (existing) {
		return { ok: true, path: existing, created: false };
	}

	// Ensure parent directory tree exists.
	const parent = dirname(canonical);
	if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

	const branchExists = runCommand(
		"git",
		["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
		{ cwd: repoPath },
	).ok;

	const args = ["worktree", "add"];
	if (branchExists) {
		args.push(canonical, branch);
	} else {
		args.push("-b", branch, canonical, baseBranch);
	}

	const result = runCommand("git", args, { cwd: repoPath });
	if (!result.ok) {
		return {
			ok: false,
			error: `git worktree add failed: ${result.stderr.trim() || "unknown error"}`,
		};
	}
	return { ok: true, path: canonical, created: true };
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
 * Remove a worktree. Refuses if dirty unless `force` is true. Refuses
 * if the path is the main worktree (git rejects that anyway, but we
 * surface a friendlier message).
 *
 * Uses `phase.worktreePath` if set, else the canonical path.
 *
 * Branches are never deleted.
 */
export function removeWorktree(
	plan: Plan,
	phase: PlanPhase,
	options: { force?: boolean } = {},
): { ok: true } | { ok: false; error: string; reason?: "dirty" | "main" } {
	const path = effectiveWorktreePath(plan, phase);
	if (!existsSync(path)) {
		return { ok: true };
	}

	const repoPath = resolve(plan.repo.path);
	if (resolve(path) === repoPath) {
		// The branch is checked out in the main worktree. We can't
		// `git worktree remove` it; the user would need to switch
		// branches manually.
		return {
			ok: false,
			error: `phase branch is checked out in the main worktree at ${path}; switch branches before pruning`,
			reason: "main",
		};
	}

	if (!options.force && !workingTreeClean(path)) {
		return {
			ok: false,
			error: `worktree ${path} has uncommitted changes`,
			reason: "dirty",
		};
	}

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
 * True if this phase has an existing on-disk worktree. Checks the
 * persisted `phase.worktreePath` first; falls back to the canonical
 * path so that an unmigrated plan still resolves correctly.
 */
export function worktreeExists(plan: Plan, phase: PlanPhase): boolean {
	return existsSync(effectiveWorktreePath(plan, phase));
}
