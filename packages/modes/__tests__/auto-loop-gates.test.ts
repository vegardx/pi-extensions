/**
 * Regression tests for the auto-loop gate-diagnostic helpers (#149, #138).
 *
 * These cover the pure decision functions — no pi/session-manager access.
 * The goal is to pin the exact gate that fires in each failure mode so a
 * future refactor can't accidentally re-silence the path.
 */

import {
	type AgentEndCompletionInput,
	type CompactionResumeDecision,
	diagnoseAgentEndCompletion,
	diagnoseCommitAbort,
	diagnoseResumeAfterCompaction,
} from "../plan/auto-loop-gates.js";
import { shouldResumeAfterCompaction } from "../plan/compaction.js";
import { readyPhases, WORKTREE_STATUSES } from "../plan/schema.js";

// ---- diagnoseAgentEndCompletion -----------------------------------------

const EXECUTING_MS = {
	mode: "auto" as const,
	stage: "executing" as const,
};

const BASE_AGENT: AgentEndCompletionInput = {
	modeState: EXECUTING_MS,
	taskCount: 2,
	deliverableCount: 2,
	deliverablesRemaining: 0,
};

describe("diagnoseAgentEndCompletion", () => {
	it("proceeds when all deliverables are done", () => {
		expect(diagnoseAgentEndCompletion(BASE_AGENT)).toEqual({ proceed: true });
	});

	it("gate: no-mode-state — silent, not diagnostic", () => {
		const d = diagnoseAgentEndCompletion({ ...BASE_AGENT, modeState: null });
		expect(d).toMatchObject({
			proceed: false,
			gate: "no-mode-state",
			diagnostic: false,
		});
	});

	it("gate: stage-not-executing — silent (other stages have their own handlers)", () => {
		const d = diagnoseAgentEndCompletion({
			...BASE_AGENT,
			modeState: { mode: "auto", stage: "exec-complete" },
		});
		expect(d).toMatchObject({
			proceed: false,
			gate: "stage-not-executing",
			diagnostic: false,
		});
	});

	it("gate: no-tasks — diagnostic (unusual: executing with zero tasks)", () => {
		const d = diagnoseAgentEndCompletion({
			...BASE_AGENT,
			taskCount: 0,
			deliverableCount: 0,
		});
		expect(d).toMatchObject({
			proceed: false,
			gate: "no-tasks",
			diagnostic: true,
		});
	});

	it("gate: no-deliverables — diagnostic (all-notes phase can never auto-complete)", () => {
		const d = diagnoseAgentEndCompletion({
			...BASE_AGENT,
			deliverableCount: 0,
		});
		expect(d).toMatchObject({
			proceed: false,
			gate: "no-deliverables",
			diagnostic: true,
		});
	});

	it("gate: deliverables-incomplete — silent (normal mid-phase state)", () => {
		const d = diagnoseAgentEndCompletion({
			...BASE_AGENT,
			deliverablesRemaining: 1,
		});
		expect(d).toMatchObject({
			proceed: false,
			gate: "deliverables-incomplete",
			diagnostic: false,
		});
	});

	it("proceeds with ask mode too", () => {
		const d = diagnoseAgentEndCompletion({
			...BASE_AGENT,
			modeState: { mode: "ask", stage: "executing" },
		});
		expect(d).toEqual({ proceed: true });
	});
});

// ---- diagnoseResumeAfterCompaction ---------------------------------------

const BASE_COMPACTION = {
	compacted: true,
	stageAtEntry: "executing" as string | null | undefined,
	modeAtEntry: "auto" as string | null | undefined,
	currentStage: "executing" as string | null | undefined,
	currentMode: "auto" as string | null | undefined,
	remainingTaskCount: 1,
};

describe("diagnoseResumeAfterCompaction", () => {
	it("resumes when all gates pass", () => {
		expect(diagnoseResumeAfterCompaction(BASE_COMPACTION)).toEqual({
			resume: true,
		});
	});

	it("gate: compact-failed — driftedToExecComplete=false", () => {
		const d = diagnoseResumeAfterCompaction({
			...BASE_COMPACTION,
			compacted: false,
		}) as Extract<CompactionResumeDecision, { resume: false }>;
		expect(d.resume).toBe(false);
		expect(d.gate).toBe("compact-failed");
		expect(d.driftedToExecComplete).toBe(false);
	});

	it("gate: stage-at-entry-not-executing — driftedToExecComplete=false", () => {
		const d = diagnoseResumeAfterCompaction({
			...BASE_COMPACTION,
			stageAtEntry: "idle",
		}) as Extract<CompactionResumeDecision, { resume: false }>;
		expect(d.gate).toBe("stage-at-entry-not-executing");
		expect(d.driftedToExecComplete).toBe(false);
	});

	it("gate: stage-drifted to exec-complete — driftedToExecComplete=true (#138 fallback path)", () => {
		const d = diagnoseResumeAfterCompaction({
			...BASE_COMPACTION,
			currentStage: "exec-complete",
		}) as Extract<CompactionResumeDecision, { resume: false }>;
		expect(d.gate).toBe("stage-drifted");
		expect(d.driftedToExecComplete).toBe(true);
	});

	it("gate: stage-drifted to other stage — driftedToExecComplete=false", () => {
		const d = diagnoseResumeAfterCompaction({
			...BASE_COMPACTION,
			currentStage: "idle",
		}) as Extract<CompactionResumeDecision, { resume: false }>;
		expect(d.gate).toBe("stage-drifted");
		expect(d.driftedToExecComplete).toBe(false);
	});

	it("gate: mode-drifted — driftedToExecComplete=false (user left auto)", () => {
		const d = diagnoseResumeAfterCompaction({
			...BASE_COMPACTION,
			currentMode: "hack",
		}) as Extract<CompactionResumeDecision, { resume: false }>;
		expect(d.gate).toBe("mode-drifted");
		expect(d.driftedToExecComplete).toBe(false);
	});

	it("gate: no-remaining-tasks — driftedToExecComplete=false", () => {
		const d = diagnoseResumeAfterCompaction({
			...BASE_COMPACTION,
			remainingTaskCount: 0,
		}) as Extract<CompactionResumeDecision, { resume: false }>;
		expect(d.gate).toBe("no-remaining-tasks");
		expect(d.driftedToExecComplete).toBe(false);
	});

	it("diagnose result is consistent with shouldResumeAfterCompaction for all gate permutations", () => {
		// Verify the two functions never disagree — diagnoseResumeAfterCompaction
		// must return resume=true iff shouldResumeAfterCompaction returns true.
		const cases = [
			BASE_COMPACTION,
			{ ...BASE_COMPACTION, compacted: false },
			{ ...BASE_COMPACTION, stageAtEntry: "idle" },
			{ ...BASE_COMPACTION, currentStage: "exec-complete" },
			{ ...BASE_COMPACTION, currentStage: "idle" },
			{ ...BASE_COMPACTION, currentMode: "hack" },
			{ ...BASE_COMPACTION, remainingTaskCount: 0 },
			{ ...BASE_COMPACTION, remainingTaskCount: -1 },
		];
		for (const c of cases) {
			const diag = diagnoseResumeAfterCompaction(c);
			const orig = shouldResumeAfterCompaction(c);
			expect(diag.resume).toBe(orig);
		}
	});
});

// ---------------------------------------------------------------------------
// no-tasks gate: no-active-phase vs empty-active-phase sub-cases
//
// The agent_end handler (index.ts) differentiates these two scenarios after
// diagnoseAgentEndCompletion returns gate=="no-tasks":
//
//   1. activePhase(plan) === null  (no phase in WORKTREE_STATUSES)
//      → auto mode: try readyPhases() + auto-advance via doImplement
//      → ask  mode: fall through to the warning
//
//   2. activePhase(plan) !== null but phase has zero tasks
//      → always: emit the warning with the phase id
//
// Because activePhase() and doImplement are unexported closures the handler
// path can't be unit-tested here directly. These tests pin the helper
// functions that drive the decision so a refactor can't silently break them.
// ---------------------------------------------------------------------------

function makePlan(
	phases: Array<{ id: string; status: string; tasks?: unknown[] }>,
) {
	return {
		slug: "test",
		title: "Test",
		repo: { path: "/tmp" },
		phases: phases.map((p) => ({
			...p,
			title: p.id,
			goal: p.id,
			branch: `feat/${p.id}`,
			dependsOn: [],
			tasks: p.tasks ?? [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

describe("no-tasks gate sub-cases — discriminating predicates", () => {
	it("WORKTREE_STATUSES contains 'active' (activePhase truthy when a phase is active)", () => {
		// Pins the statuses that make activePhase() return non-null so a
		// schema change doesn't silently break the auto-advance guard.
		expect(WORKTREE_STATUSES).toContain("active");
	});

	it("readyPhases returns planned phases with no deps (auto-advance candidates)", () => {
		const plan = makePlan([
			{ id: "a", status: "planned" },
			{ id: "b", status: "planned" },
		]);
		const ready = readyPhases(
			plan as unknown as Parameters<typeof readyPhases>[0],
		);
		expect(ready.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("readyPhases is empty when all phases are shipped (no auto-advance candidate)", () => {
		const plan = makePlan([
			{ id: "a", status: "shipped" },
			{ id: "b", status: "shipped" },
		]);
		expect(
			readyPhases(plan as unknown as Parameters<typeof readyPhases>[0]),
		).toHaveLength(0);
	});

	it("readyPhases excludes an active phase (WORKTREE_STATUS) — not a candidate", () => {
		// A phase in a WORKTREE_STATUS is already running; it must not be
		// returned as an auto-advance candidate.
		const plan = makePlan([
			{ id: "a", status: "active" },
			{ id: "b", status: "planned" },
		]);
		const ids = readyPhases(
			plan as unknown as Parameters<typeof readyPhases>[0],
		).map((p) => p.id);
		expect(ids).not.toContain("a");
		expect(ids).toContain("b");
	});

	it("no-tasks gate is diagnostic (not silent) — auto-advance or warning will fire", () => {
		const d = diagnoseAgentEndCompletion({
			...BASE_AGENT,
			taskCount: 0,
			deliverableCount: 0,
		});
		expect(d).toMatchObject({
			proceed: false,
			gate: "no-tasks",
			diagnostic: true,
		});
	});
});

// ---- diagnoseCommitAbort ------------------------------------------------

describe("diagnoseCommitAbort", () => {
	it("ships when a real commit happened", () => {
		expect(diagnoseCommitAbort({ ran: true })).toEqual({ action: "ship" });
	});

	it("ships on clean-tree (tests-only / no staged changes)", () => {
		expect(
			diagnoseCommitAbort({ ran: false, abortReason: "clean-tree" }),
		).toEqual({ action: "ship" });
	});

	// Regression: the bypassed-ship bug. The agent committed/pushed/PR'd
	// the phase out-of-band, so /commit found HEAD unchanged and reported
	// `no-commits`. The old guard threw here and halted the whole auto run
	// (phase left active, prNumber unset). It MUST stay ship-eligible so
	// doShip can reconcile the existing PR and the loop advances. Do not
	// re-silence this path.
	it("ships on no-commits (out-of-band bypass recovery)", () => {
		expect(
			diagnoseCommitAbort({ ran: false, abortReason: "no-commits" }),
		).toEqual({ action: "ship" });
	});

	it("ships on agent-no-pr-output (PR layer is doShip's job)", () => {
		expect(
			diagnoseCommitAbort({ ran: false, abortReason: "agent-no-pr-output" }),
		).toEqual({ action: "ship" });
	});

	it.each([
		"not-git",
		"no-branch",
		"unsafe-branch",
		"user-cancelled",
		"deferred-to-review",
	] as const)("halts with a reason on %s", (abortReason) => {
		const d = diagnoseCommitAbort({ ran: false, abortReason });
		expect(d.action).toBe("halt");
		if (d.action === "halt") {
			expect(d.reason.length).toBeGreaterThan(0);
		}
	});
});
