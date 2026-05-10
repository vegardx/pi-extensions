import {
	buildCompletionPrompt,
	decideFromCompletionChoice,
	isPlanComplete,
} from "../plan/completion.js";
import type { Phase, Plan } from "../plan/schema.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = "2024-01-01T00:00:00.000Z";
	return {
		id: "p-x",
		title: "T",
		goal: "G",
		status: "planned",
		branch: "feat/p-x",
		tasks: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePlan(phases: Phase[]): Plan {
	const now = "2024-01-01T00:00:00.000Z";
	return {
		slug: "test",
		title: "Test Plan",
		repo: { path: "/tmp" },
		phases,
		createdAt: now,
		updatedAt: now,
	};
}

describe("isPlanComplete", () => {
	it("is false for an empty plan", () => {
		expect(isPlanComplete(makePlan([]))).toBe(false);
	});

	it("is false while any phase is non-terminal", () => {
		expect(
			isPlanComplete(
				makePlan([
					makePhase({ id: "p-1", status: "shipped" }),
					makePhase({ id: "p-2", status: "active" }),
				]),
			),
		).toBe(false);
	});

	it("is true when every phase is shipped or abandoned", () => {
		expect(
			isPlanComplete(
				makePlan([
					makePhase({ id: "p-1", status: "shipped" }),
					makePhase({ id: "p-2", status: "abandoned" }),
				]),
			),
		).toBe(true);
	});
});

describe("buildCompletionPrompt", () => {
	it("returns null when no UI is available", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "shipped" })]);
		expect(buildCompletionPrompt(plan, false)).toBeNull();
	});

	it("returns null when the plan still has actionable phases", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "active" }),
		]);
		expect(buildCompletionPrompt(plan, true)).toBeNull();
	});

	it("returns a three-option prompt when the plan is complete", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "shipped" })]);
		const out = buildCompletionPrompt(plan, true);
		expect(out).not.toBeNull();
		expect(out?.title).toContain("complete");
		expect(out?.options).toHaveLength(3);
	});
});

describe("decideFromCompletionChoice", () => {
	it("undefined falls back to stay", () => {
		expect(decideFromCompletionChoice(undefined)).toEqual({ action: "stay" });
	});

	it("unknown string falls back to stay", () => {
		expect(decideFromCompletionChoice("nope")).toEqual({ action: "stay" });
	});

	it("decodes Start a new plan", () => {
		expect(
			decideFromCompletionChoice("Start a new plan (new planning session)"),
		).toEqual({ action: "newPlan" });
	});

	it("decodes Archive this plan", () => {
		expect(decideFromCompletionChoice("Archive this plan and stay")).toEqual({
			action: "archive",
		});
	});

	it("decodes Stay", () => {
		expect(decideFromCompletionChoice("Stay in this session")).toEqual({
			action: "stay",
		});
	});
});
