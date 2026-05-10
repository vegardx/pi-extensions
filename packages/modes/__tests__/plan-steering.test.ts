import type { Phase, PhaseStatus, Plan } from "../plan/schema.js";
import {
	STEERING_CLASSIFIER,
	shouldInjectSteeringClassifier,
} from "../plan/steering.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		id: "p-active",
		title: "Active phase",
		goal: "ship something",
		status: "active",
		branch: "feat/p-active",
		tasks: [
			{
				id: "t-one",
				title: "First task",
				body: "",
				done: true,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "t-two",
				title: "Second task",
				body: "",
				done: false,
				createdAt: now,
				updatedAt: now,
			},
		],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePlan(phases: Phase[]): Plan {
	const now = new Date().toISOString();
	return {
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/tmp/repo" },
		phases,
		createdAt: now,
		updatedAt: now,
	};
}

describe("STEERING_CLASSIFIER", () => {
	it("does not embed phase or task identifiers (cache stability)", () => {
		expect(STEERING_CLASSIFIER).not.toMatch(/p-\w+/);
		expect(STEERING_CLASSIFIER).not.toMatch(/t-\w+/);
	});

	it("references plan_view rather than embedding the plan", () => {
		expect(STEERING_CLASSIFIER).toContain("plan_view");
	});

	it("lists the four routing options", () => {
		expect(STEERING_CLASSIFIER).toContain("plan_task(update");
		expect(STEERING_CLASSIFIER).toContain("plan_task(add");
		expect(STEERING_CLASSIFIER).toContain("plan_phase(add");
		expect(STEERING_CLASSIFIER).toContain("course correction");
	});
});

describe("shouldInjectSteeringClassifier", () => {
	it("returns true for an interactive auto-mode message with an in-flight phase", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "also add retry-with-jitter",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBe(true);
	});

	it("returns true when the in-flight phase is needs-attention", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "fix the off-by-one",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase({ status: "needs-attention" })]),
			}),
		).toBe(true);
	});

	it("returns true when the in-flight phase has zero tasks defined", () => {
		// Plan exists but not yet broken down — the agent should still
		// consider routing the message into a new task.
		expect(
			shouldInjectSteeringClassifier({
				text: "hi",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase({ tasks: [] })]),
			}),
		).toBe(true);
	});

	it.each<[SteeringMode | null]>([
		["plan"],
		["hack"],
		[null],
	])("returns false in %s", (mode) => {
		expect(
			shouldInjectSteeringClassifier({
				text: "anything",
				source: "interactive",
				mode,
				plan: makePlan([makePhase()]),
			}),
		).toBe(false);
	});

	it("returns false for extension-sourced messages", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "internal notification",
				source: "extension",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBe(false);
	});

	it("returns false for slash commands (incl. leading whitespace)", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "/ship",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBe(false);
		expect(
			shouldInjectSteeringClassifier({
				text: "  /skill:exa-search look up X",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBe(false);
	});

	it("returns false for empty / whitespace-only messages", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBe(false);
		expect(
			shouldInjectSteeringClassifier({
				text: "   \n  ",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBe(false);
	});

	it("returns false when no plan is present", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "do the thing",
				source: "interactive",
				mode: "auto",
				plan: null,
			}),
		).toBe(false);
	});

	it("returns false when no phase is in flight", () => {
		const allDone: PhaseStatus[] = ["planned", "shipped", "abandoned"];
		const phases = allDone.map((status, i) =>
			makePhase({ id: `p-${i}`, status }),
		);
		expect(
			shouldInjectSteeringClassifier({
				text: "do the thing",
				source: "interactive",
				mode: "auto",
				plan: makePlan(phases),
			}),
		).toBe(false);
	});

	it("returns false when the in-flight phase has tasks but all are done (awaiting /ship)", () => {
		const phase = makePhase({
			tasks: [
				{
					id: "t-one",
					title: "First",
					body: "",
					done: true,
					createdAt: "",
					updatedAt: "",
				},
				{
					id: "t-two",
					title: "Second",
					body: "",
					done: true,
					createdAt: "",
					updatedAt: "",
				},
			],
		});
		expect(
			shouldInjectSteeringClassifier({
				text: "any follow-up",
				source: "interactive",
				mode: "auto",
				plan: makePlan([phase]),
			}),
		).toBe(false);
	});
});

type SteeringMode = "plan" | "auto" | "hack";
