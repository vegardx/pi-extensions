/**
 * Gate diagnostics for the two auto-loop re-entry paths (#149, #138).
 *
 * Both call sites in `index.ts` historically silently `return`-ed at
 * the first failed predicate, leaving the user with an agent that
 * stopped without a visible reason. These helpers replace the implicit
 * early-returns with a discriminated decision so the call site can:
 *
 *   1. emit a single `notify("info")` naming the gate that tripped, and
 *   2. fork into the matching recovery path when one exists.
 *
 * Pure: no session-manager / pi access. Inputs are whatever the call
 * site can cheaply gather from `modeState` plus the loaded plan. Tests
 * exercise the gates directly without spinning up a session.
 */

import {
	type ResumeAfterCompactionInput,
	shouldResumeAfterCompaction,
} from "./compaction.js";

export type AgentEndGate =
	| "no-mode-state"
	| "stage-not-executing"
	| "no-tasks"
	| "no-deliverables"
	| "deliverables-incomplete";

export interface AgentEndCompletionInput {
	/** Live `modeState`. Null when no plan is bound (fresh session). */
	modeState: { mode: string; stage: string } | null | undefined;
	/** Number of tasks on the active phase (0 when no active phase). */
	taskCount: number;
	/** Number of deliverable-kind tasks on the active phase. */
	deliverableCount: number;
	/** Number of deliverables NOT yet toggled done. */
	deliverablesRemaining: number;
}

export type AgentEndDecision =
	| { proceed: true }
	| {
			proceed: false;
			gate: AgentEndGate;
			/** True when this gate is "interesting" for diagnostics — i.e. the
			 *  user is in auto/ask mode mid-phase but something stopped the
			 *  auto-loop from firing. Trivial gates (no plan, plan mode) are
			 *  silent so the notify channel doesn't get spammed. */
			diagnostic: boolean;
	  };

/**
 * Decide whether `agent_end` should advance into the exec-complete /
 * auto-loop path.
 *
 * Mirrors the gate stack in `pi.on("agent_end", …)` (index.ts). Each
 * rejection carries a stable `gate` name so the call site can emit a
 * consistent `auto-loop: stopped at <gate>` notify.
 */
export function diagnoseAgentEndCompletion(
	input: AgentEndCompletionInput,
): AgentEndDecision {
	const ms = input.modeState;
	if (!ms) return { proceed: false, gate: "no-mode-state", diagnostic: false };
	if (ms.stage !== "executing") {
		// `executing` is the only stage where completion fires. Other
		// stages (idle / awaiting-choice / fixing / exec-complete) belong
		// to other handlers — silent.
		return {
			proceed: false,
			gate: "stage-not-executing",
			diagnostic: false,
		};
	}
	if (input.taskCount === 0) {
		// In auto/ask + executing with zero tasks is unusual — the agent
		// shouldn't have entered executing without any plan content.
		// Diagnostic-worthy.
		return { proceed: false, gate: "no-tasks", diagnostic: true };
	}
	if (input.deliverableCount === 0) {
		// All-notes phase — never auto-completes by design. Diagnostic so
		// the user knows the phase needs at least one deliverable.
		return { proceed: false, gate: "no-deliverables", diagnostic: true };
	}
	if (input.deliverablesRemaining > 0) {
		// Normal mid-phase state — agent finished a turn but more work
		// remains. Silent: this is the common case, every turn that isn't
		// the final one trips this gate.
		return {
			proceed: false,
			gate: "deliverables-incomplete",
			diagnostic: false,
		};
	}
	return { proceed: true };
}

export type CompactionResumeGate =
	| "compact-failed"
	| "stage-at-entry-not-executing"
	| "stage-drifted"
	| "mode-drifted"
	| "no-remaining-tasks";

export type CompactionResumeDecision =
	| { resume: true }
	| {
			resume: false;
			gate: CompactionResumeGate;
			/** True when the active phase had work left and the auto-loop
			 *  should still recover. Drives the fallback re-entry path
			 *  (compactPhaseSlice → runExecCompletePath) when drift to
			 *  `exec-complete` happened mid-compaction. */
			driftedToExecComplete: boolean;
	  };

/**
 * Wrap {@link shouldResumeAfterCompaction} with a per-gate reason so
 * the call site can:
 *
 *   - emit a clear `auto-loop: skipped (<gate>)` notify when an
 *     unexpected gate tripped, and
 *   - fork into the agent_end exec-complete fallback path when the
 *     reason is specifically "stage drifted to exec-complete during
 *     compaction" (#138 fallback).
 *
 * Order of gate evaluation matches `shouldResumeAfterCompaction` so
 * the boolean result is identical (verified by tests).
 */
export function diagnoseResumeAfterCompaction(
	input: ResumeAfterCompactionInput,
): CompactionResumeDecision {
	if (!shouldResumeAfterCompaction(input)) {
		// Replay the gate stack to identify which one fired.
		if (!input.compacted) {
			return {
				resume: false,
				gate: "compact-failed",
				driftedToExecComplete: false,
			};
		}
		if (input.stageAtEntry !== "executing") {
			return {
				resume: false,
				gate: "stage-at-entry-not-executing",
				driftedToExecComplete: false,
			};
		}
		if (input.currentStage !== "executing") {
			return {
				resume: false,
				gate: "stage-drifted",
				// exec-complete drift: agent_end flipped stage mid-compaction
				// but the auto-loop kick may not have survived the async gap.
				driftedToExecComplete: input.currentStage === "exec-complete",
			};
		}
		if (input.modeAtEntry !== input.currentMode) {
			return {
				resume: false,
				gate: "mode-drifted",
				driftedToExecComplete: false,
			};
		}
		return {
			resume: false,
			gate: "no-remaining-tasks",
			driftedToExecComplete: false,
		};
	}
	return { resume: true };
}

/**
 * Abort reasons the non-interactive `/commit` step can report. Mirrors
 * the `RunCommitResult.abortReason` union in `pi-ext-commit/core`. Kept
 * as a local copy so this pure module stays self-contained (no
 * cross-extension value import) and testable in isolation.
 */
export type CommitAbortReason =
	| "not-git"
	| "clean-tree"
	| "no-branch"
	| "unsafe-branch"
	| "user-cancelled"
	| "deferred-to-review"
	| "no-commits"
	| "agent-no-pr-output";

export interface CommitAbortInput {
	/** Whether `/commit` actually committed (and pushed). */
	ran: boolean;
	/** Set only when `ran === false`. */
	abortReason?: CommitAbortReason;
}

export type CommitAbortDecision =
	| { action: "ship" }
	| { action: "halt"; reason: string };

/**
 * Decide what the auto-loop should do after the per-phase commit step.
 *
 * The historical guard threw on *any* abort except `clean-tree`, which
 * dropped the loop into the agent_end fallback picker and halted auto
 * progression. The bug: when the agent committed/pushed/PR'd a phase
 * out-of-band, the non-interactive `/commit` legitimately had nothing
 * new to do and reported `no-commits` (HEAD never advanced) — a
 * non-fatal "nothing to commit" that nonetheless killed the run.
 *
 * Fix: treat every "nothing new to commit" outcome as ship-eligible and
 * let `doShip` be the arbiter. `doShip` already reconciles an existing
 * out-of-band PR (probe by branch) or pushes + creates one, and the
 * caller's post-ship `status === "active"` guard catches the case where
 * shipping genuinely couldn't establish a PR. Only abort reasons that
 * shipping cannot recover from halt the loop.
 */
export function diagnoseCommitAbort(
	input: CommitAbortInput,
): CommitAbortDecision {
	// A real commit happened — proceed to ship as usual.
	if (input.ran) return { action: "ship" };

	switch (input.abortReason) {
		// No staged changes — tests-only phase, or work landed in earlier
		// commits. Always shippable (historical whitelisted behaviour).
		case "clean-tree":
		// HEAD didn't advance: the phase was already committed (and likely
		// pushed/PR'd) out-of-band. doShip reconciles the existing PR or
		// pushes + creates one. THIS is the bypass-recovery path.
		case "no-commits":
		// Commit succeeded but the agent never emitted the PR sentinels;
		// the PR layer is doShip's job anyway, so ship it.
		case "agent-no-pr-output":
			return { action: "ship" };

		// Genuine blockers — shipping cannot recover. Halt with a reason.
		case "not-git":
			return { action: "halt", reason: "not inside a git repository" };
		case "no-branch":
			return {
				action: "halt",
				reason: "could not resolve current branch (detached HEAD?)",
			};
		case "unsafe-branch":
			return {
				action: "halt",
				reason: "unsafe branch (default branch or bad name) — branch first",
			};
		case "user-cancelled":
			return { action: "halt", reason: "commit was cancelled" };
		case "deferred-to-review":
			return { action: "halt", reason: "commit deferred to /review" };
		default:
			return {
				action: "halt",
				reason: `commit aborted (${input.abortReason ?? "unknown"})`,
			};
	}
}
