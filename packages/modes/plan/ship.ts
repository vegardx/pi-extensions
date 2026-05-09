/**
 * Ship a phase: commit (only if `autoCommit` is set), push, open PR.
 * Refuses on dirty trees by default.
 *
 * On success the caller is responsible for flipping `phase.status` to
 * `in-review` and persisting `phase.prNumber`.
 */

import {
	runCommand as defaultRunCommand,
	workingTreeClean as defaultWorkingTreeClean,
	type ShellResult,
} from "../git.js";
import type { Plan, Phase as PlanPhase } from "./schema.js";
import { effectiveWorktreePath } from "./worktree.js";

export interface ShipOptions {
	/** Open PR as draft instead of ready-for-review. Default false. */
	draft?: boolean;
	/** Override commit message; default is derived from phase. */
	commitMessage?: string;
	/** Skip dirty-tree refusal — auto-commit pending changes. */
	autoCommit?: boolean;
	/** Injection seam for tests. Defaults to the real runCommand. */
	run?: (
		command: string,
		args: readonly string[],
		opts?: { cwd?: string; stdin?: string },
	) => ShellResult;
	/** Injection seam for tests. Defaults to the real workingTreeClean. */
	isClean?: (cwd: string) => boolean;
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
 * Operates in the phase's actual worktree (`phase.worktreePath`),
 * falling back to the canonical path. Caller is responsible for
 * flipping the phase status to `in-review` and persisting `prNumber`
 * on success.
 */
export async function shipPhase(
	plan: Plan,
	phase: PlanPhase,
	options: ShipOptions = {},
): Promise<ShipResult> {
	const run = options.run ?? defaultRunCommand;
	const isClean = options.isClean ?? defaultWorkingTreeClean;
	const path = effectiveWorktreePath(plan, phase);

	if (!isClean(path)) {
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
		const stage = run("git", ["add", "-A"], { cwd: path });
		if (!stage.ok) {
			return { ok: false, error: `git add -A failed: ${stage.stderr.trim()}` };
		}
		const commit = run("git", ["commit", "-m", message], { cwd: path });
		if (!commit.ok) {
			return {
				ok: false,
				error: `git commit failed: ${commit.stderr.trim()}`,
			};
		}
	}

	const push = run("git", ["push", "-u", "origin", phase.branch], {
		cwd: path,
	});
	if (!push.ok) {
		return { ok: false, error: `git push failed: ${push.stderr.trim()}` };
	}

	const prArgs = [
		"pr",
		"create",
		"--title",
		phase.title,
		"--body",
		renderPrBody(plan, phase),
		"--head",
		phase.branch,
	];
	if (options.draft) prArgs.push("--draft");

	const create = run("gh", prArgs, { cwd: path });
	if (!create.ok) {
		return {
			ok: false,
			error: `gh pr create failed: ${create.stderr.trim()}`,
		};
	}
	const parsed = parsePrCreateOutput(create.stdout);
	if (!parsed) {
		return {
			ok: false,
			error: `gh pr create returned unexpected output: ${create.stdout.trim()}`,
		};
	}
	return { ok: true, prNumber: parsed.number, prUrl: parsed.url };
}

/**
 * Parse `gh pr create`'s stdout into a structured result. The expected
 * output is a URL like `https://github.com/owner/repo/pull/42` plus
 * possibly leading log lines. Exported for testing.
 */
export function parsePrCreateOutput(
	stdout: string,
): { number: number; url: string } | null {
	const url = stdout.match(/https?:\/\/\S+/)?.[0] ?? "";
	const numberMatch = stdout.match(/\/pull\/(\d+)/);
	if (!numberMatch) return null;
	const number = Number.parseInt(numberMatch[1], 10);
	if (!Number.isFinite(number)) return null;
	return { number, url };
}

/** Render a PR body for a phase. Exported for testing. */
export function renderPrBody(plan: Plan, phase: PlanPhase): string {
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
