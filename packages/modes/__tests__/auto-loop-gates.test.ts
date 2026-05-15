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
	diagnoseResumeAfterCompaction,
} from "../plan/auto-loop-gates.js";
import { shouldResumeAfterCompaction } from "../plan/compaction.js";

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
