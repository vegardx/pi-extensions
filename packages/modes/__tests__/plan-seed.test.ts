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
				"- Phase `p-1` [active] — First: do the thing     ← THIS PHASE",
				"",
				"You are working on Phase `p-1`. Only execute its deliverables. When",
				"all deliverables are done, run `/ship` — do NOT start the next phase.",
				"Notes are reviewer-facing and surface in the PR body; do not tick them.",
				"",
				"Route commit/push/PR work through `/commit` and `/ship` so plan state stays in sync.",
				"Don't shell out to `git commit`, `git push`, or `gh pr create` directly while a phase is active —",
				"those bypass the plan's prNumber/status tracking. If you already did, run `/sync` to reconcile.",
			].join("\n"),
		);
	});

	it("inlines deliverables under the active phase with their done state", () => {
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
		expect(out).toContain(
			"  Deliverables (your work; tick each as you finish):",
		);
		expect(out).toContain("    - [ ] first task");
		expect(out).toContain("    - [x] second task");
		expect(out).not.toContain("  Notes (informational");
	});

	it("renders non-deliverable tasks in a Notes section, not the deliverables list", () => {
		const phase = makePhase({
			id: "p-1",
			status: "active",
			tasks: [
				{
					id: "d",
					title: "core change",
					body: "",
					done: false,
					kind: "deliverable",
					createdAt: "x",
					updatedAt: "x",
				},
				{
					id: "q",
					title: "Drop legacy v1?",
					body: "",
					done: false,
					kind: "question",
					createdAt: "x",
					updatedAt: "x",
				},
				{
					id: "m",
					title: "Smoke test",
					body: "",
					done: false,
					kind: "manual",
					createdAt: "x",
					updatedAt: "x",
				},
				{
					id: "f",
					title: "Index by branch",
					body: "",
					done: false,
					kind: "followUp",
					createdAt: "x",
					updatedAt: "x",
				},
			],
		});
		const plan = makePlan([phase]);
		const out = renderPlanSeed(plan, phase);
		expect(out).toContain(
			"  Deliverables (your work; tick each as you finish):",
		);
		expect(out).toContain("    - [ ] core change");
		expect(out).toContain("  Notes (informational; not for you to tick):");
		expect(out).toContain("    - [?] Drop legacy v1? (question)");
		expect(out).toContain("    - [!] Smoke test (manual)");
		expect(out).toContain("    - [~] Index by branch (followUp)");
		// Notes section uses kind markers, not done checkboxes.
		expect(out).not.toContain("    - [ ] Drop legacy v1?");
	});

	it("renders plan-level follow-ups in their own block when present", () => {
		const phase = makePhase({ id: "p-1", status: "active" });
		const plan: Plan = {
			...makePlan([phase]),
			followUps: [
				{
					id: "pf",
					title: "Cross-cutting note",
					body: "",
					done: false,
					kind: "followUp",
					createdAt: "x",
					updatedAt: "x",
				},
			],
		};
		const out = renderPlanSeed(plan, phase);
		expect(out).toContain("Plan-level follow-ups (not gating any phase):");
		expect(out).toContain("  - [~] Cross-cutting note (followUp)");
	});

	it("omits the plan-level follow-ups block when followUps is empty", () => {
		const phase = makePhase({ id: "p-1", status: "active" });
		const plan = makePlan([phase]);
		const out = renderPlanSeed(plan, phase);
		expect(out).not.toContain("Plan-level follow-ups");
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
		expect(out).toContain(
			"- Phase `p-1` [shipped] PR #42 — Done one: shipped goal",
		);
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
