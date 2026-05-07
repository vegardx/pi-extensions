import {
	hydrateStepsFromBranch,
	type PlanStep,
	type PlanStepDetails,
	STEPS_CLEARED_ENTRY,
} from "../index.js";

function toolResult(
	steps: PlanStep[],
	nextId: number,
): {
	type: "message";
	message: { role: string; toolName: string; details: PlanStepDetails };
} {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "plan_step",
			details: { action: "add", steps, nextId },
		},
	};
}

function clearEntry(): { type: "custom"; customType: string } {
	return { type: "custom", customType: STEPS_CLEARED_ENTRY };
}

describe("hydrateStepsFromBranch", () => {
	it("returns empty when branch is empty", () => {
		const result = hydrateStepsFromBranch([]);
		expect(result.steps).toEqual([]);
		expect(result.nextStepId).toBe(1);
	});

	it("reconstructs steps from the last plan_step tool result", () => {
		const steps: PlanStep[] = [
			{ id: 1, text: "do thing", done: true },
			{ id: 2, text: "do other", done: false },
		];
		const branch = [toolResult(steps, 3)];
		const result = hydrateStepsFromBranch(branch);
		expect(result.steps).toEqual(steps);
		expect(result.nextStepId).toBe(3);
	});

	it("uses the LAST tool result when multiple exist", () => {
		const first: PlanStep[] = [{ id: 1, text: "a", done: false }];
		const second: PlanStep[] = [
			{ id: 1, text: "a", done: true },
			{ id: 2, text: "b", done: false },
		];
		const branch = [toolResult(first, 2), toolResult(second, 3)];
		const result = hydrateStepsFromBranch(branch);
		expect(result.steps).toEqual(second);
		expect(result.nextStepId).toBe(3);
	});

	it("returns empty when a clear entry follows the last tool result", () => {
		const steps: PlanStep[] = [{ id: 1, text: "done", done: true }];
		const branch = [toolResult(steps, 2), clearEntry()];
		const result = hydrateStepsFromBranch(branch);
		expect(result.steps).toEqual([]);
		expect(result.nextStepId).toBe(1);
	});

	it("ignores a clear entry that precedes a later tool result", () => {
		const steps: PlanStep[] = [{ id: 1, text: "new plan", done: false }];
		const branch = [
			toolResult([{ id: 1, text: "old", done: true }], 2),
			clearEntry(),
			toolResult(steps, 2),
		];
		const result = hydrateStepsFromBranch(branch);
		expect(result.steps).toEqual(steps);
		expect(result.nextStepId).toBe(2);
	});

	it("skips non-plan_step messages", () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "hi" } },
			{ type: "message", message: { role: "toolResult", toolName: "bash" } },
			toolResult([{ id: 1, text: "x", done: false }], 2),
		];
		const result = hydrateStepsFromBranch(branch);
		expect(result.steps).toHaveLength(1);
	});
});
