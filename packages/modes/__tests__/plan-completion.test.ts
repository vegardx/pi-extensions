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

	it("is false while any phase is non-terminal-ish (active/planned/needs-attention)", () => {
		for (const status of ["active", "planned", "needs-attention"] as const) {
			expect(
				isPlanComplete(
					makePlan([
						makePhase({ id: "p-1", status: "shipped" }),
						makePhase({ id: "p-2", status }),
					]),
				),
			).toBe(false);
		}
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

	it("is true when every phase is shipped/abandoned/in-review", () => {
		// /ship leaves phases at `in-review` until the PR is merged. Without
		// counting in-review here, the completion prompt + PR sweep never
		// fire on the auto path.
		expect(
			isPlanComplete(
				makePlan([
					makePhase({ id: "p-1", status: "shipped" }),
					makePhase({ id: "p-2", status: "in-review" }),
				]),
			),
		).toBe(true);
		expect(
			isPlanComplete(makePlan([makePhase({ id: "p-1", status: "in-review" })])),
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

	it("returns a three-option prompt when every phase is terminal", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "shipped" })]);
		const out = buildCompletionPrompt(plan, true);
		expect(out).not.toBeNull();
		expect(out?.title).toContain("complete");
		expect(out?.title).toContain("shipped or abandoned");
		expect(out?.options).toHaveLength(3);
	});

	it("returns a prompt with in-review wording when phases are still at review", () => {
		// Auto-mode flow: /ship leaves the last phase at in-review. The
		// prompt fires now (so the PR sweep can flag CI/review feedback)
		// even though the phase isn't strictly terminal yet.
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "in-review" }),
		]);
		const out = buildCompletionPrompt(plan, true);
		expect(out).not.toBeNull();
		expect(out?.title).toContain("in review");
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
