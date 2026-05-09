/**
 * /ship — commit, push, open PR, and flip phase status to in-review.
 *
 * Refuses if the worktree has uncommitted *user-edited* changes that
 * shouldn't be silently auto-committed. The "auto-commit" behaviour
 * applies only to changes the agent made: if there's anything else,
 * the user must resolve first (commit, stash, or discard).
 *
 * In practice we can't reliably tell agent-from-user changes, so we
 * follow a simpler rule: if `--ship-mark` was given (modes calls /ship
 * after the agent has finished its tasks), we commit everything that's
 * staged or modified under the agent's authority. If the user has
 * uncommitted changes outside of that we refuse.
 *
 * For now: refuse on any dirty tree, ask user to commit first via the
 * normal /commit skill. We can revisit auto-commit later.
 */

import { runCommand, type ShellResult, workingTreeClean } from "../git.js";
import type { Plan, Phase as PlanPhase } from "./schema.js";
import { worktreePath } from "./worktree.js";

export interface ShipOptions {
	/** Open PR as draft instead of ready-for-review. Default false. */
	draft?: boolean;
	/** Override commit message; default is derived from phase. */
	commitMessage?: string;
	/** Skip dirty-tree refusal — auto-commit pending changes. */
	autoCommit?: boolean;
}

export interface ShipResult {
	ok: boolean;
	prNumber?: number;
	prUrl?: string;
	error?: string;
}

/**
 * Ship a phase: ensure committed, push branch, open PR, return PR info.
 *
 * Caller is responsible for flipping the phase status (`in-review`) and
 * persisting the plan after this returns ok=true with a prNumber.
 */
export async function shipPhase(
	plan: Plan,
	phase: PlanPhase,
	options: ShipOptions = {},
): Promise<ShipResult> {
	const path = worktreePath(plan, phase);

	// Step 1: handle uncommitted changes.
	if (!workingTreeClean(path)) {
		if (!options.autoCommit) {
			return {
				ok: false,
				error:
					`worktree at ${path} has uncommitted changes — commit or stash before /ship` +
					` (or pass autoCommit to bundle them into a single commit)`,
			};
		}
		const message =
			options.commitMessage ?? `${phase.title}\n\nGoal: ${phase.goal}`;
		const stage = runCommand("git", ["add", "-A"], { cwd: path });
		if (!stage.ok) {
			return {
				ok: false,
				error: `git add -A failed: ${stage.stderr.trim()}`,
			};
		}
		const commit = runCommand("git", ["commit", "-m", message], { cwd: path });
		if (!commit.ok) {
			return {
				ok: false,
				error: `git commit failed: ${commit.stderr.trim()}`,
			};
		}
	}

	// Step 2: push the branch.
	const push = runCommand("git", ["push", "-u", "origin", phase.branch], {
		cwd: path,
	});
	if (!push.ok) {
		return {
			ok: false,
			error: `git push failed: ${push.stderr.trim()}`,
		};
	}

	// Step 3: open the PR.
	const prTitle = phase.title;
	const prBody = renderPrBody(plan, phase);
	const prArgs = [
		"pr",
		"create",
		"--title",
		prTitle,
		"--body",
		prBody,
		"--head",
		phase.branch,
	];
	if (options.draft) prArgs.push("--draft");

	const create = runCommand("gh", prArgs, { cwd: path });
	if (!create.ok) {
		return {
			ok: false,
			error: `gh pr create failed: ${create.stderr.trim()}`,
		};
	}
	const urlMatch = create.stdout.match(/\/pull\/(\d+)/);
	const num = urlMatch ? Number.parseInt(urlMatch[1], 10) : Number.NaN;
	const url = create.stdout.match(/https?:\/\/\S+/)?.[0] ?? "";

	if (!Number.isFinite(num)) {
		return {
			ok: false,
			error: `gh pr create returned unexpected output: ${create.stdout.trim()}`,
		};
	}
	return { ok: true, prNumber: num, prUrl: url };
}

function renderPrBody(plan: Plan, phase: PlanPhase): string {
	const lines: string[] = [];
	lines.push("## Goal", "", phase.goal || "_(no goal set)_", "");
	if (phase.tasks.length > 0) {
		lines.push("## Tasks", "");
		for (const t of phase.tasks) {
			lines.push(`- [${t.done ? "x" : " "}] ${t.title}`);
		}
		lines.push("");
	}
	if (phase.issueNumber) {
		lines.push(`Closes #${phase.issueNumber}`);
	}
	if (plan.parentIssueNumber && plan.parentIssueNumber !== phase.issueNumber) {
		lines.push(`Part of #${plan.parentIssueNumber}`);
	}
	return lines.join("\n");
}

/** Re-export for callers wanting raw shell types. */
export type { ShellResult };
