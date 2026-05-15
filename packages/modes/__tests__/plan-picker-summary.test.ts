/**
 * Unit tests for plan summary before picker (#158).
 *
 * Tests:
 *   (a) picker fires (non-bail) → planSummaryContent returns markdown
 *   (b) bail path → planSummaryContent returns null
 *   (c) Shift+Tab path is the same code path as (a) — tested here as
 *       "non-bail with plan" to document the equivalence.
 */

import { planSummaryContent, renderPlanSection } from "../plan/compaction.js";
import type { Plan } from "../plan/schema.js";

// Minimal Plan shape for testing — only fields consumed by the two helpers.
function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		slug: "test-plan",
		title: "Test Plan",
		planSessionPath: "/tmp/session",
		phases: [
			{
				id: "phase-a",
				title: "Phase A",
				goal: "Do A",
				status: "shipped",
				branch: "feat/phase-a",
				dependsOn: [],
				tasks: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				prNumber: 42,
			},
			{
				id: "phase-b",
				title: "Phase B",
				goal: "Do B",
				status: "active",
				branch: "feat/phase-b",
				dependsOn: ["phase-a"],
				tasks: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
			{
				id: "phase-c",
				title: "Phase C",
				goal: "Do C",
				status: "planned",
				branch: "feat/phase-c",
				dependsOn: ["phase-b"],
				tasks: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	} as unknown as Plan;
}

// ---- renderPlanSection ---------------------------------------------------

describe("renderPlanSection", () => {
	it("includes plan title and slug in the header", () => {
		const out = renderPlanSection(makePlan());
		expect(out).toContain("## Plan: Test Plan");
		expect(out).toContain("slug: test-plan");
	});

	it("lists each phase with id, status, title and goal", () => {
		const out = renderPlanSection(makePlan());
		expect(out).toContain("`phase-a` [shipped]");
		expect(out).toContain("Phase A: Do A");
		expect(out).toContain("`phase-b` [active]");
		expect(out).toContain("Phase B: Do B");
		expect(out).toContain("`phase-c` [planned]");
		expect(out).toContain("Phase C: Do C");
	});

	it("appends PR number when prNumber is set", () => {
		const out = renderPlanSection(makePlan());
		expect(out).toContain("PR #42");
		// phase-b has no prNumber — line should not include PR #
		const phaseB = out.split("\n").find((l) => l.includes("phase-b"));
		expect(phaseB).toBeDefined();
		expect(phaseB).not.toContain("PR #");
	});

	it("handles a plan with no phases", () => {
		const out = renderPlanSection(makePlan({ phases: [] }));
		expect(out).toBe("## Plan: Test Plan (slug: test-plan)");
	});
});

// ---- planSummaryContent --------------------------------------------------

describe("planSummaryContent", () => {
	const plan = makePlan();

	it("(a) picker fires (action=show) → returns markdown", () => {
		const result = planSummaryContent(plan, "show");
		expect(result).not.toBeNull();
		expect(result).toContain("## Plan:");
		expect(result).toContain("phase-a");
	});

	it("(b) bail path (action=bail) → returns null", () => {
		expect(planSummaryContent(plan, "bail")).toBeNull();
	});

	it("null plan → returns null regardless of viewAction", () => {
		expect(planSummaryContent(null, "show")).toBeNull();
		expect(planSummaryContent(undefined, "show")).toBeNull();
	});

	it("(c) Shift+Tab path is the same as non-bail — returns markdown", () => {
		// Shift+Tab eventually calls runPicker with view.action === "show".
		// This test documents that equivalence: the gate is purely on
		// view.action, not on how the user arrived at the picker.
		const result = planSummaryContent(plan, "show");
		expect(result).not.toBeNull();
	});

	it("content is the same as renderPlanSection for a given plan", () => {
		expect(planSummaryContent(plan, "show")).toBe(renderPlanSection(plan));
	});
});
