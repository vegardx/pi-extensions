import type { Phase, Plan } from "../plan/schema.js";
import { renderPlanSeed } from "../plan/seed.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = "2024-01-01T00:00:00.000Z";
	return {
		id: "p-x",
		title: "Title",
		goal: "Goal",
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
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/tmp/repo" },
		phases,
		createdAt: now,
		updatedAt: now,
	};
}

describe("renderPlanSeed", () => {
	it("renders a minimal plan with one active phase and no tasks", () => {
		const phase = makePhase({
			id: "p-1",
			title: "First",
			goal: "do the thing",
			status: "active",
		});
		const plan = makePlan([phase]);
		expect(renderPlanSeed(plan, phase)).toBe(
			[
				"## Plan: Test Plan (slug: test-plan)",
				"- `p-1` [active] — First: do the thing     ← THIS PHASE",
				"",
				"You are working on phase `p-1`. Only execute its tasks. When all",
				"tasks are done, run `/ship` — do NOT start the next phase.",
			].join("\n"),
		);
	});

	it("inlines tasks under the active phase with their done state", () => {
		const phase = makePhase({
			id: "p-1",
			title: "T",
			goal: "G",
			status: "active",
			tasks: [
				{
					id: "t-a",
					title: "first task",
					body: "body",
					done: false,
					createdAt: "x",
					updatedAt: "x",
				},
				{
					id: "t-b",
					title: "second task",
					body: "body",
					done: true,
					createdAt: "x",
					updatedAt: "x",
				},
			],
		});
		const plan = makePlan([phase]);
		const out = renderPlanSeed(plan, phase);
		expect(out).toContain("  Tasks:");
		expect(out).toContain("    - [ ] first task");
		expect(out).toContain("    - [x] second task");
	});

	it("includes shipped phases' Summary blocks when present", () => {
		const shipped = makePhase({
			id: "p-1",
			title: "Done one",
			goal: "shipped goal",
			status: "shipped",
			prNumber: 42,
			summary: "## What shipped\nfoo\n## Don't repeat\nbar baz",
		});
		const active = makePhase({
			id: "p-2",
			title: "Now",
			goal: "current goal",
			status: "active",
		});
		const plan = makePlan([shipped, active]);
		const out = renderPlanSeed(plan, active);
		expect(out).toContain("- `p-1` [shipped] PR #42 — Done one: shipped goal");
		expect(out).toContain("  Summary:");
		expect(out).toContain("    ## What shipped");
		expect(out).toContain("    foo");
		expect(out).toContain("    ## Don't repeat");
	});

	it("omits the Summary block for shipped phases without a summary", () => {
		const shipped = makePhase({
			id: "p-1",
			title: "Done",
			goal: "g",
			status: "shipped",
			prNumber: 1,
			// no summary
		});
		const active = makePhase({
			id: "p-2",
			title: "Now",
			goal: "g",
			status: "active",
		});
		const plan = makePlan([shipped, active]);
		expect(renderPlanSeed(plan, active)).not.toContain("Summary:");
	});

	it("only marks the active phase with ← THIS PHASE", () => {
		const phases = [
			makePhase({ id: "p-1", status: "shipped", prNumber: 1 }),
			makePhase({ id: "p-2", status: "active" }),
			makePhase({ id: "p-3", status: "planned" }),
		];
		const plan = makePlan(phases);
		const out = renderPlanSeed(plan, phases[1]);
		const marked = out
			.split("\n")
			.filter((line) => line.includes("← THIS PHASE"));
		expect(marked).toHaveLength(1);
		expect(marked[0]).toContain("`p-2`");
	});

	it("is byte-stable for stable input", () => {
		const phase = makePhase({ id: "p-1", status: "active" });
		const plan = makePlan([phase]);
		expect(renderPlanSeed(plan, phase)).toBe(renderPlanSeed(plan, phase));
	});
});
