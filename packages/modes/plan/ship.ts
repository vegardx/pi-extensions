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
import {
	effectiveTaskKind,
	type Plan,
	type Phase as PlanPhase,
} from "./schema.js";
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
	/**
	 * Set when /ship found an already-open PR for `phase.branch` and
	 * skipped the push + create steps. Used by callers to surface a
	 * "reconciled, nothing new shipped" notify rather than the usual
	 * "shipped" message.
	 */
	reconciled?: boolean;
}

export type RunShell = (
	command: string,
	args: readonly string[],
	opts?: { cwd?: string; stdin?: string },
) => ShellResult;

/**
 * Probe `gh` for an open PR whose head ref matches `branch`. Returns
 * the first match (or null). Soft-fail: any `gh` error or unparseable
 * stdout returns null so callers fall through to the normal create
 * path rather than masking unrelated failures.
 */
export function probeOpenPrForBranch(
	branch: string,
	cwd: string,
	run: RunShell = defaultRunCommand,
): { number: number; url: string } | null {
	const r = run(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"number,url",
			"--limit",
			"1",
		],
		{ cwd },
	);
	if (!r.ok) return null;
	try {
		const list = JSON.parse(r.stdout) as Array<{
			number?: number;
			url?: string;
		}>;
		const first = list[0];
		if (first && typeof first.number === "number") {
			return { number: first.number, url: first.url ?? "" };
		}
	} catch {
		// fall through
	}
	return null;
}

export type ProbedPrState = "open" | "merged" | "closed" | "unknown";

/**
 * Probe `gh pr view <number>` for the PR's current state. Returns
 * null on `gh` error so callers can decide whether to fall back to
 * a branch probe.
 */
export function probePrByNumber(
	prNumber: number,
	cwd: string,
	run: RunShell = defaultRunCommand,
): { state: ProbedPrState; url: string } | null {
	const r = run("gh", ["pr", "view", String(prNumber), "--json", "state,url"], {
		cwd,
	});
	if (!r.ok) return null;
	try {
		const data = JSON.parse(r.stdout) as { state?: string; url?: string };
		const raw = (data.state ?? "").toUpperCase();
		const state: ProbedPrState =
			raw === "OPEN"
				? "open"
				: raw === "MERGED"
					? "merged"
					: raw === "CLOSED"
						? "closed"
						: "unknown";
		return { state, url: data.url ?? "" };
	} catch {
		return null;
	}
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

	// Idempotency: if an open PR already exists for this branch, return
	// it instead of erroring with a duplicate `gh pr create` failure.
	// Covers the case where /ship is retried after a partial failure or
	// where the user shelled out to `gh pr create` directly mid-phase.
	const existing = probeOpenPrForBranch(phase.branch, path, run);
	if (existing) {
		return {
			ok: true,
			prNumber: existing.number,
			prUrl: existing.url,
			reconciled: true,
		};
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

	// Split phase tasks by kind. Deliverables are the unit of work the PR
	// is shipping; question / followUp / manual tasks are notes for the
	// reviewer (open questions, follow-up work to schedule, manual smoke
	// steps to run before merge). They live in their own sections so
	// reviewers can scan without parsing intent from prose.
	const deliverables = phase.tasks.filter(
		(t) => effectiveTaskKind(t) === "deliverable",
	);
	const followUps = phase.tasks.filter(
		(t) => effectiveTaskKind(t) === "followUp",
	);
	const questions = phase.tasks.filter(
		(t) => effectiveTaskKind(t) === "question",
	);
	const manuals = phase.tasks.filter((t) => effectiveTaskKind(t) === "manual");

	if (deliverables.length > 0) {
		lines.push("## What this phase ships", "");
		for (const t of deliverables) {
			lines.push(`- [${t.done ? "x" : " "}] ${t.title}`);
		}
		lines.push("");
	}

	if (followUps.length > 0) {
		lines.push(
			"## Reviewer follow-ups",
			"",
			"Out of scope for this PR — file as issues or fold into a later phase:",
			"",
		);
		for (const t of followUps) {
			lines.push(`- [${t.done ? "x" : " "}] ${t.title}`);
			if (t.body.trim()) {
				lines.push(
					...t.body
						.trim()
						.split("\n")
						.map((line) => `      ${line}`),
				);
			}
		}
		lines.push("");
	}

	if (questions.length > 0) {
		lines.push("## Open questions", "", "Please weigh in before merge:", "");
		for (const t of questions) {
			lines.push(`- ${t.title}`);
			if (t.body.trim()) {
				lines.push(
					...t.body
						.trim()
						.split("\n")
						.map((line) => `    ${line}`),
				);
			}
		}
		lines.push("");
	}

	if (manuals.length > 0) {
		lines.push(
			"## Manual verification",
			"",
			"Steps the reviewer should run locally before merging:",
			"",
		);
		for (const t of manuals) {
			lines.push(`- [${t.done ? "x" : " "}] ${t.title}`);
			if (t.body.trim()) {
				lines.push(
					...t.body
						.trim()
						.split("\n")
						.map((line) => `      ${line}`),
				);
			}
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
