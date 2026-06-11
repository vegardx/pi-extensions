import type {
	Deliverable as Phase,
	DeliverableStatus as PhaseStatus,
	Plan,
} from "../plan/schema.js";
import {
	STEERING_CLASSIFIER,
	shouldInjectSteeringClassifier,
} from "../plan/steering.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		type: "deliverable" as const,
		id: "p-active",
		title: "Active phase",
		body: "ship something",
		status: "active",
		branch: "feat/p-active",
		children: [
			{
				type: "work-item" as const,
				id: "t-one",
				title: "First task",
				body: "",
				done: true,
				createdAt: now,
				updatedAt: now,
			},
			{
				type: "work-item" as const,
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

function makePlan(nodes: Phase[]): Plan {
	const now = new Date().toISOString();
	return {
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/tmp/repo" },
		nodes,
		createdAt: now,
		updatedAt: now,
	};
}

describe("STEERING_CLASSIFIER", () => {
	it("does not embed phase or task identifiers (cache stability)", () => {
		expect(STEERING_CLASSIFIER).not.toMatch(/p-\w+/);
		expect(STEERING_CLASSIFIER).not.toMatch(/t-\w+/);
	});

	it("references the plan tool rather than embedding the plan", () => {
		// Anchor to the specific 'consult plan' instruction so the rename
		// coverage doesn't silently regress on a generic "plan" match.
		expect(STEERING_CLASSIFIER).toContain("consult plan");
	});

	it("lists the four routing options", () => {
		expect(STEERING_CLASSIFIER).toContain("task(update");
		expect(STEERING_CLASSIFIER).toContain("task(add");
		expect(STEERING_CLASSIFIER).toContain("phase(add");
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

	it("returns true for ask mode too — same preamble path as auto", () => {
		expect(
			shouldInjectSteeringClassifier({
				text: "also add retry-with-jitter",
				source: "interactive",
				mode: "ask",
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

	it("returns false when the in-flight phase has zero tasks defined", () => {
		// The auto-mode preamble in `before_agent_start` short-circuits when
		// there are no active tasks, so the classifier would have nowhere to
		// attach — keep the gate aligned with what actually fires.
		expect(
			shouldInjectSteeringClassifier({
				text: "hi",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase({ children: [] })]),
			}),
		).toBe(false);
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
			children: [
				{
					type: "work-item" as const,
					id: "t-one",
					title: "First",
					body: "",
					done: true,
					createdAt: "",
					updatedAt: "",
				},
				{
					type: "work-item" as const,
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

type SteeringMode = "plan" | "auto" | "ask" | "hack";
