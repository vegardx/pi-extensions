/**
 * End-of-plan PR sweep: query `gh pr view` for every shipped phase's
 * PR and summarise CI + review state in one shot.
 *
 * The auto-loop never pauses between phases for review — feedback
 * arrives async on whatever timeline the reviewer keeps. The sweep is
 * the moment to surface that backlog so the user can address it
 * before starting a new plan.
 *
 * Pure logic (parsing, summary rendering, "first PR with feedback"
 * selection) lives here so it can be unit-tested without spawning
 * `gh`. The async sweep driver takes a `runShell` injection seam for
 * the same reason.
 */

import type { ShellResult } from "../git.js";
import { runCommand as defaultRunCommand } from "../git.js";
import type { Plan } from "./schema.js";

export type PrState = "merged" | "open" | "closed" | "unknown";

export type CiState = "green" | "pending" | "red" | "none" | "error";

export interface PrSweepResult {
	phaseId: string;
	prNumber: number;
	/** Raw `state` from gh, plus `merged: true` collapses to "merged". */
	state: PrState;
	/** Aggregated from `statusCheckRollup` rows. */
	ci: CiState;
	/** Raw `reviewDecision` from gh: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / null. */
	reviewDecision: string | null;
	/** Count of unresolved review-thread comments (best-effort). */
	unresolvedComments: number;
	/** Set when gh failed; rendering should mark the row as ⚠ unknown. */
	error?: string;
}

interface RawPrJson {
	state?: string;
	merged?: boolean;
	statusCheckRollup?: Array<{
		conclusion?: string | null;
		state?: string | null;
	}>;
	reviewDecision?: string | null;
	reviews?: Array<{
		state?: string | null;
		body?: string | null;
	}>;
}

/**
 * Parse a single `gh pr view --json …` payload into the structured
 * sweep result. Tolerant of missing / partial fields — gh's schema is
 * not strictly stable, and the sweep is read-only diagnostics.
 */
export function parsePrJson(
	phaseId: string,
	prNumber: number,
	raw: unknown,
): PrSweepResult {
	const j = (raw ?? {}) as RawPrJson;
	const state: PrState = j.merged
		? "merged"
		: j.state === "OPEN"
			? "open"
			: j.state === "CLOSED"
				? "closed"
				: "unknown";

	const checks = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : [];
	const ci: CiState = (() => {
		if (checks.length === 0) return "none";
		let red = 0;
		let pending = 0;
		let green = 0;
		for (const c of checks) {
			const conc = (c.conclusion ?? "").toUpperCase();
			const st = (c.state ?? "").toUpperCase();
			if (conc === "FAILURE" || conc === "TIMED_OUT" || conc === "CANCELLED") {
				red++;
			} else if (conc === "SUCCESS" || st === "SUCCESS") {
				green++;
			} else if (st === "PENDING" || st === "QUEUED" || st === "IN_PROGRESS") {
				pending++;
			}
		}
		if (red > 0) return "red";
		if (pending > 0) return "pending";
		if (green > 0) return "green";
		return "none";
	})();

	// "Unresolved comments" — gh's JSON shape doesn't expose review-thread
	// resolution state directly. As a best-effort proxy, count reviews
	// whose state is COMMENTED or CHANGES_REQUESTED. False positives are
	// preferable to false negatives here: the sweep is meant to flag PRs
	// needing attention, not to be authoritative.
	const unresolvedComments = Array.isArray(j.reviews)
		? j.reviews.filter((r) => {
				const st = (r.state ?? "").toUpperCase();
				return st === "COMMENTED" || st === "CHANGES_REQUESTED";
			}).length
		: 0;

	return {
		phaseId,
		prNumber,
		state,
		ci,
		reviewDecision: j.reviewDecision ?? null,
		unresolvedComments,
	};
}

const STATE_GLYPH: Record<PrState, string> = {
	merged: "✓",
	open: "·",
	closed: "✗",
	unknown: "?",
};

const CI_LABEL: Record<CiState, string> = {
	green: "CI green",
	pending: "CI pending",
	red: "CI failing",
	none: "no CI",
	error: "CI unknown",
};

/**
 * Render the sweep as a list of lines suitable for a single notify()
 * call. Each phase gets one row.
 */
export function summarisePrSweep(results: readonly PrSweepResult[]): string {
	if (results.length === 0) return "PR sweep: no phases with PRs.";
	const rows = results.map((r) => {
		if (r.error) {
			return `  ${r.phaseId.padEnd(28)} PR #${r.prNumber}  ⚠ gh: ${r.error}`;
		}
		const flags: string[] = [];
		if (r.state === "merged") flags.push("merged");
		else flags.push(r.state);
		flags.push(CI_LABEL[r.ci]);
		if (r.reviewDecision === "CHANGES_REQUESTED") {
			flags.push("CHANGES_REQUESTED");
		} else if (r.reviewDecision === "APPROVED") {
			flags.push("approved");
		} else if (r.reviewDecision === "REVIEW_REQUIRED") {
			flags.push("review required");
		}
		if (r.unresolvedComments > 0) {
			flags.push(
				`${r.unresolvedComments} unresolved comment${r.unresolvedComments === 1 ? "" : "s"}`,
			);
		}
		return `  ${STATE_GLYPH[r.state]} ${r.phaseId.padEnd(26)} PR #${r.prNumber}  ${flags.join(", ")}`;
	});
	return ["Plan complete — PR sweep:", ...rows].join("\n");
}

/**
 * Pick the first PR that's likely to need attention, in priority
 * order: red CI > changes requested > unresolved comments > pending
 * CI > review required. Returns null when nothing flags.
 */
export function pickFirstWithFeedback(
	results: readonly PrSweepResult[],
): PrSweepResult | null {
	const score = (r: PrSweepResult): number => {
		if (r.error) return 0;
		if (r.state === "merged") return 0;
		if (r.ci === "red") return 5;
		if (r.reviewDecision === "CHANGES_REQUESTED") return 4;
		if (r.unresolvedComments > 0) return 3;
		if (r.ci === "pending") return 2;
		if (r.reviewDecision === "REVIEW_REQUIRED") return 1;
		return 0;
	};
	let best: PrSweepResult | null = null;
	let bestScore = 0;
	for (const r of results) {
		const s = score(r);
		if (s > bestScore) {
			bestScore = s;
			best = r;
		}
	}
	return best;
}

export type RunShell = (
	command: string,
	args: readonly string[],
	opts?: { cwd?: string },
) => ShellResult;

export interface SweepInput {
	cwd: string;
	plan: Pick<Plan, "phases">;
	run?: RunShell;
}

/**
 * Drive the sweep: for every phase with a `prNumber`, call `gh pr
 * view`. Soft-fail per phase — one PR's broken state doesn't kill the
 * whole sweep.
 *
 * Returns null when no phase has a PR (don't bother rendering an
 * empty sweep) or when the first `gh` call fails with the
 * "command-not-found" pattern (caller should warn once and skip).
 */
export async function runEndOfPlanPrSweep(
	input: SweepInput,
): Promise<PrSweepResult[] | null> {
	const phasesWithPr = input.plan.phases.filter(
		(p): p is typeof p & { prNumber: number } =>
			typeof p.prNumber === "number" && p.prNumber > 0,
	);
	if (phasesWithPr.length === 0) return null;

	const run: RunShell = input.run ?? defaultRunCommand;

	const results: PrSweepResult[] = [];
	for (const phase of phasesWithPr) {
		const r = run(
			"gh",
			[
				"pr",
				"view",
				String(phase.prNumber),
				"--json",
				"state,merged,statusCheckRollup,reviewDecision,reviews",
			],
			{ cwd: input.cwd },
		);
		if (!r.ok) {
			const errLine = r.stderr.trim().split("\n")[0] || "gh failed";
			// The first phase's gh call is also our probe for `gh` being
			// installed. If it fails with command-not-found we abort the
			// sweep entirely so the caller can render a single warning
			// instead of N broken rows.
			if (
				results.length === 0 &&
				/command not found|no such file|gh: not found/i.test(errLine)
			) {
				return null;
			}
			results.push({
				phaseId: phase.id,
				prNumber: phase.prNumber,
				state: "unknown",
				ci: "error",
				reviewDecision: null,
				unresolvedComments: 0,
				error: errLine,
			});
			continue;
		}
		try {
			const parsed = JSON.parse(r.stdout) as unknown;
			results.push(parsePrJson(phase.id, phase.prNumber, parsed));
		} catch (err) {
			results.push({
				phaseId: phase.id,
				prNumber: phase.prNumber,
				state: "unknown",
				ci: "error",
				reviewDecision: null,
				unresolvedComments: 0,
				error: `parse error: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	return results;
}
