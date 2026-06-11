import type { Deliverable as Phase, Plan } from "../plan/schema.js";
import { renderPlanSeed } from "../plan/seed.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = "2024-01-01T00:00:00.000Z";
	return {
		type: "deliverable" as const,
		id: "p-x",
		title: "Title",
		body: "Goal",
		status: "planned",
		branch: "feat/p-x",
		children: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePlan(nodes: Phase[]): Plan {
	const now = "2024-01-01T00:00:00.000Z";
	return {
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/tmp/repo" },
		nodes,
		createdAt: now,
		updatedAt: now,
	};
}

describe("renderPlanSeed", () => {
	it("renders a minimal plan with one active phase and no tasks", () => {
		const phase = makePhase({
			type: "deliverable" as const,
			id: "p-1",
			title: "First",
			body: "do the thing",
			status: "active",
		});
		const plan = makePlan([phase]);
		expect(renderPlanSeed(plan, phase)).toBe(
			[
				"## Plan: Test Plan (slug: test-plan)",
				"- Deliverable `p-1` [active] — First: do the thing     ← THIS PHASE",
				"",
				"You are working on deliverable `p-1`. Only execute its tasks. When",
				"all tasks are done, run `/ship` — do NOT start the next deliverable.",
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
			body: "G",
			status: "active",
			children: [
				{
					type: "work-item" as const,
					id: "t-a",
					title: "first task",
					body: "body",
					done: false,
					createdAt: "x",
					updatedAt: "x",
				},
				{
					type: "work-item" as const,
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
		expect(out).toContain("  Tasks (your work; tick each as you finish):");
		expect(out).toContain("    - [ ] first task");
		expect(out).toContain("    - [x] second task");
		expect(out).not.toContain("  Notes (informational");
	});

	it("renders non-deliverable tasks in a Notes section, not the deliverables list", () => {
		const phase = makePhase({
			id: "p-1",
			status: "active",
			children: [
				{
					type: "work-item" as const,
					id: "d",
					title: "core change",
					body: "",
					done: false,
					kind: "task",
					createdAt: "x",
					updatedAt: "x",
				},
				{
					type: "work-item" as const,
					id: "q",
					title: "Drop legacy v1?",
					body: "",
					done: false,
					kind: "question",
					createdAt: "x",
					updatedAt: "x",
				},
				{
					type: "work-item" as const,
					id: "m",
					title: "Smoke test",
					body: "",
					done: false,
					kind: "manual",
					createdAt: "x",
					updatedAt: "x",
				},
				{
					type: "work-item" as const,
					id: "f",
					title: "Index by branch",
					body: "",
					done: false,
					kind: "followup",
					createdAt: "x",
					updatedAt: "x",
				},
			],
		});
		const plan = makePlan([phase]);
		const out = renderPlanSeed(plan, phase);
		expect(out).toContain("  Tasks (your work; tick each as you finish):");
		expect(out).toContain("    - [ ] core change");
		expect(out).toContain("  Notes (informational; not for you to tick):");
		expect(out).toContain("    - [?] Drop legacy v1? (question)");
		expect(out).toContain("    - [!] Smoke test (manual)");
		expect(out).toContain("    - [~] Index by branch (followup)");
		// Notes section uses kind markers, not done checkboxes.
		expect(out).not.toContain("    - [ ] Drop legacy v1?");
	});

	it("renders plan-level follow-ups in their own block when present", () => {
		const phase = makePhase({ id: "p-1", status: "active" });
		const base = makePlan([phase]);
		const plan: Plan = {
			...base,
			nodes: [
				...base.nodes,
				{
					type: "work-item" as const,
					id: "pf",
					title: "Cross-cutting note",
					body: "",
					done: false,
					kind: "followup",
					createdAt: "x",
					updatedAt: "x",
				},
			],
		};
		const out = renderPlanSeed(plan, phase);
		expect(out).toContain(
			"Plan-level loose items (not gating any deliverable):",
		);
		expect(out).toContain("  - [~] Cross-cutting note (followup)");
	});

	it("omits the plan-level follow-ups block when followUps is empty", () => {
		const phase = makePhase({ id: "p-1", status: "active" });
		const plan = makePlan([phase]);
		const out = renderPlanSeed(plan, phase);
		expect(out).not.toContain("Plan-level follow-ups");
	});

	it("includes shipped phases' Summary blocks when present", () => {
		const shipped = makePhase({
			type: "deliverable" as const,
			id: "p-1",
			title: "Done one",
			body: "shipped goal",
			status: "shipped",
			prNumber: 42,
			summary: "## What shipped\nfoo\n## Don't repeat\nbar baz",
		});
		const active = makePhase({
			type: "deliverable" as const,
			id: "p-2",
			title: "Now",
			body: "current goal",
			status: "active",
		});
		const plan = makePlan([shipped, active]);
		const out = renderPlanSeed(plan, active);
		expect(out).toContain(
			"- Deliverable `p-1` [shipped] PR #42 — Done one: shipped goal",
		);
		expect(out).toContain("  Summary:");
		expect(out).toContain("    ## What shipped");
		expect(out).toContain("    foo");
		expect(out).toContain("    ## Don't repeat");
	});

	it("omits the Summary block for shipped phases without a summary", () => {
		const shipped = makePhase({
			type: "deliverable" as const,
			id: "p-1",
			title: "Done",
			body: "g",
			status: "shipped",
			prNumber: 1,
			// no summary
		});
		const active = makePhase({
			type: "deliverable" as const,
			id: "p-2",
			title: "Now",
			body: "g",
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

	it("renders pre/post phases with kind marker and manual checklist", () => {
		const pre = makePhase({
			id: "pre",
			title: "Preflight",
			lifecycle: "pre",
			branch: "",
			children: [
				{
					type: "work-item" as const,
					id: "t1",
					title: "rename secret",
					body: "",
					done: false,
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				},
			],
		});
		const active = makePhase({ id: "r1", status: "active" });
		const plan = makePlan([pre, active]);
		const out = renderPlanSeed(plan, active);
		expect(out).toContain("`pre` [pre]");
		expect(out).toContain(
			"Preflight (manual; user ticks before regular phases proceed)",
		);
		expect(out).toContain("[!] rename secret");
	});

	it("renders post phase as Handover checklist", () => {
		const active = makePhase({ id: "r1", status: "active" });
		const post = makePhase({
			id: "post",
			title: "Handover",
			lifecycle: "post",
			branch: "",
			children: [
				{
					type: "work-item" as const,
					id: "t1",
					title: "deploy",
					body: "",
					done: true,
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				},
			],
		});
		const out = renderPlanSeed(makePlan([active, post]), active);
		expect(out).toContain("`post` [post]");
		expect(out).toContain(
			"Handover (manual; user completes after last regular phase ships)",
		);
		// Done items still show [x].
		expect(out).toContain("[x] deploy");
	});
});
