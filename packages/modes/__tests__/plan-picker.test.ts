import {
	buildPickerCopy,
	classifyImplementContext,
	planPickerView,
	shouldFirePicker,
	shouldOfferShiftTabPicker,
	snapshotPlanStructure,
} from "../plan/picker.js";
import type { Phase, PhaseStatus, Plan } from "../plan/schema.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		id: "p-one",
		title: "Phase one",
		goal: "ship something",
		status: "planned",
		branch: "feat/p-one",
		tasks: [],
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

describe("snapshotPlanStructure", () => {
	it("returns a stable string for null", () => {
		expect(snapshotPlanStructure(null)).toBe("null");
	});

	it("captures phase id, status, and task ids", () => {
		const plan = makePlan([
			makePhase({
				id: "p-one",
				status: "planned",
				tasks: [
					{
						id: "t-a",
						title: "A",
						body: "",
						done: false,
						createdAt: "",
						updatedAt: "",
					},
				],
			}),
		]);
		expect(snapshotPlanStructure(plan)).toBe(
			JSON.stringify({
				phases: [{ id: "p-one", status: "planned", taskIds: ["t-a"] }],
			}),
		);
	});

	it("ignores body changes (same shape => same snapshot)", () => {
		const a = makePlan([
			makePhase({
				goal: "original goal",
				tasks: [
					{
						id: "t-a",
						title: "A",
						body: "original body",
						done: false,
						createdAt: "",
						updatedAt: "",
					},
				],
			}),
		]);
		const b = makePlan([
			makePhase({
				goal: "rewritten goal",
				tasks: [
					{
						id: "t-a",
						title: "A",
						body: "rewritten body with much more detail",
						done: false,
						createdAt: "",
						updatedAt: "",
					},
				],
			}),
		]);
		expect(snapshotPlanStructure(a)).toBe(snapshotPlanStructure(b));
	});

	it("differs when a phase status changes", () => {
		const a = makePlan([makePhase({ status: "planned" })]);
		const b = makePlan([makePhase({ status: "active" })]);
		expect(snapshotPlanStructure(a)).not.toBe(snapshotPlanStructure(b));
	});

	it("differs when a phase is added", () => {
		const a = makePlan([makePhase({ id: "p-one" })]);
		const b = makePlan([
			makePhase({ id: "p-one" }),
			makePhase({ id: "p-two" }),
		]);
		expect(snapshotPlanStructure(a)).not.toBe(snapshotPlanStructure(b));
	});

	it("differs when a task is added to an existing phase", () => {
		const a = makePlan([makePhase({ tasks: [] })]);
		const b = makePlan([
			makePhase({
				tasks: [
					{
						id: "t-new",
						title: "new",
						body: "",
						done: false,
						createdAt: "",
						updatedAt: "",
					},
				],
			}),
		]);
		expect(snapshotPlanStructure(a)).not.toBe(snapshotPlanStructure(b));
	});
});

describe("shouldFirePicker", () => {
	const plan = makePlan([makePhase({ status: "planned" })]);
	const snapshot = snapshotPlanStructure(makePlan([])); // empty: differs from `plan`

	it("fires when mode=plan, stage=planning, hasUI, actionable, and snapshot differs", () => {
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan,
				snapshot,
				hasUI: true,
			}),
		).toBe(true);
	});

	it("does not fire when mode is not plan", () => {
		expect(
			shouldFirePicker({
				mode: "auto",
				stage: "planning",
				plan,
				snapshot,
				hasUI: true,
			}),
		).toBe(false);
	});

	it("does not fire when stage is not planning", () => {
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "executing",
				plan,
				snapshot,
				hasUI: true,
			}),
		).toBe(false);
	});

	it("does not fire when hasUI is false (headless)", () => {
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan,
				snapshot,
				hasUI: false,
			}),
		).toBe(false);
	});

	it.each<PhaseStatus>([
		"shipped",
		"abandoned",
	])("does not fire when every phase is terminal (%s)", (status) => {
		const allTerminal = makePlan([
			makePhase({ id: "p-1", status }),
			makePhase({ id: "p-2", status }),
		]);
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan: allTerminal,
				snapshot: "different",
				hasUI: true,
			}),
		).toBe(false);
	});

	it.each<PhaseStatus>([
		"planned",
		"active",
		"needs-attention",
	])("fires when at least one phase is %s", (status) => {
		const actionable = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status }),
		]);
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan: actionable,
				snapshot: snapshotPlanStructure(makePlan([])),
				hasUI: true,
			}),
		).toBe(true);
	});

	it("does not fire when snapshot is null (no capture this turn)", () => {
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan,
				snapshot: null,
				hasUI: true,
			}),
		).toBe(false);
	});

	it("does not fire when snapshot matches current plan (no mutation)", () => {
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan,
				snapshot: snapshotPlanStructure(plan),
				hasUI: true,
			}),
		).toBe(false);
	});

	it("does not fire when plan is null", () => {
		expect(
			shouldFirePicker({
				mode: "plan",
				stage: "planning",
				plan: null,
				snapshot: "anything",
				hasUI: true,
			}),
		).toBe(false);
	});
});

describe("shouldOfferShiftTabPicker", () => {
	it("returns false when hasUI is false", () => {
		const plan = makePlan([makePhase({ status: "planned" })]);
		expect(shouldOfferShiftTabPicker(plan, false)).toBe(false);
	});

	it("returns false when plan is null", () => {
		expect(shouldOfferShiftTabPicker(null, true)).toBe(false);
	});

	it("returns false when every phase is terminal", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "abandoned" }),
		]);
		expect(shouldOfferShiftTabPicker(plan, true)).toBe(false);
	});

	it.each<PhaseStatus>([
		"planned",
		"active",
		"needs-attention",
	])("returns true when at least one phase is %s", (status) => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status }),
		]);
		expect(shouldOfferShiftTabPicker(plan, true)).toBe(true);
	});
});

describe("buildPickerCopy", () => {
	it("returns 'in-flight' kind with resumption copy when an active phase exists", () => {
		const plan = makePlan([
			makePhase({
				id: "p-active",
				status: "active",
				branch: "feat/p-active",
			}),
		]);
		const copy = buildPickerCopy(plan, "feat/p-active");
		expect(copy.kind).toBe("in-flight");
		expect(copy.title).toContain("p-active");
		expect(copy.title).toContain("in flight");
		expect(copy.title).toContain("feat/p-active");
		expect(copy.implementAutoLabel).toMatch(/^Resume \(auto\)/);
		expect(copy.implementAutoLabel).toContain("feat/p-active");
		expect(copy.implementAskLabel).toMatch(/^Resume \(ask\)/);
		expect(copy.implementAskLabel).toContain("feat/p-active");
	});

	it("treats needs-attention as in-flight", () => {
		const plan = makePlan([
			makePhase({
				id: "p-fix",
				status: "needs-attention",
				branch: "feat/p-fix",
			}),
		]);
		const copy = buildPickerCopy(plan, "feat/p-fix");
		expect(copy.kind).toBe("in-flight");
		expect(copy.implementAutoLabel).toMatch(/^Resume \(auto\)/);
		expect(copy.implementAskLabel).toMatch(/^Resume \(ask\)/);
	});

	it("prefers in-flight phase over a planned successor", () => {
		const plan = makePlan([
			makePhase({ id: "p-active", status: "active", branch: "feat/p-active" }),
			makePhase({ id: "p-next", status: "planned", branch: "feat/p-next" }),
		]);
		const copy = buildPickerCopy(plan, null);
		expect(copy.kind).toBe("in-flight");
		expect(copy.title).toContain("p-active");
	});

	it("returns 'fresh' kind with original copy when only planned phases exist", () => {
		const plan = makePlan([
			makePhase({ id: "p-one", status: "planned" }),
			makePhase({ id: "p-two", status: "planned" }),
		]);
		const copy = buildPickerCopy(plan, "feat/p-one");
		expect(copy.kind).toBe("fresh");
		expect(copy.title).toContain("plan ready");
		expect(copy.title).toContain("feat/p-one");
		expect(copy.implementAutoLabel).toMatch(/^Implement \(auto\)/);
		expect(copy.implementAskLabel).toMatch(/^Implement \(ask\)/);
	});

	it("omits branch suffix in title when currentBranch is null", () => {
		const plan = makePlan([makePhase({ status: "planned" })]);
		const copy = buildPickerCopy(plan, null);
		expect(copy.kind).toBe("fresh");
		expect(copy.title).not.toContain("(");
	});

	it("returns 'none' kind when every phase is terminal", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "abandoned" }),
		]);
		const copy = buildPickerCopy(plan, "main");
		expect(copy.kind).toBe("none");
	});

	it("returns 'none' kind when plan is null", () => {
		const copy = buildPickerCopy(null, null);
		expect(copy.kind).toBe("none");
	});
});

describe("planPickerView", () => {
	it("returns a 'bail' action with no UI options when plan has no actionable phase", () => {
		// Reachable when Shift+Tab pops the picker on a fully-shipped plan
		// or when /plan resume lands on one. The handler must notify and
		// reset stage without invoking ctx.ui.select — so the view carries
		// no `options` field for that case.
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "abandoned" }),
		]);
		const view = planPickerView(plan, "main");
		expect(view.action).toBe("bail");
		if (view.action === "bail") {
			expect(view.notice).toContain("no actionable phase");
			expect(view.notice).toContain("staying in plan mode");
		}
	});

	it("returns a 'bail' action when plan is null", () => {
		const view = planPickerView(null, null);
		expect(view.action).toBe("bail");
	});

	it("returns a 'show' action with four options for a fresh plan (auto first by default)", () => {
		const plan = makePlan([makePhase({ status: "planned" })]);
		const view = planPickerView(plan, "feat/p-one");
		expect(view.action).toBe("show");
		if (view.action === "show") {
			expect(view.options).toHaveLength(4);
			expect(view.options[0]).toMatch(/^Implement \(auto\)/);
			expect(view.options[1]).toMatch(/^Implement \(ask\)/);
			expect(view.options[2]).toMatch(/^Park/);
			expect(view.options[3]).toMatch(/^Continue discussing/);
			expect(view.title).toContain("plan ready");
		}
	});

	it("flips implement order when implementDefault is 'ask'", () => {
		const plan = makePlan([makePhase({ status: "planned" })]);
		const view = planPickerView(plan, "feat/p-one", "ask");
		expect(view.action).toBe("show");
		if (view.action === "show") {
			expect(view.options[0]).toMatch(/^Implement \(ask\)/);
			expect(view.options[1]).toMatch(/^Implement \(auto\)/);
			expect(view.options[2]).toMatch(/^Park/);
			expect(view.options[3]).toMatch(/^Continue discussing/);
		}
	});

	it("returns a 'show' action with resume copy for an in-flight plan", () => {
		const plan = makePlan([
			makePhase({
				id: "p-active",
				status: "active",
				branch: "feat/p-active",
			}),
		]);
		const view = planPickerView(plan, "feat/p-active");
		expect(view.action).toBe("show");
		if (view.action === "show") {
			expect(view.options[0]).toMatch(/^Resume \(auto\)/);
			expect(view.options[1]).toMatch(/^Resume \(ask\)/);
			expect(view.title).toContain("in flight");
		}
	});
});

describe("classifyImplementContext", () => {
	it("returns 'no-plan' when plan is null", () => {
		const result = classifyImplementContext(null);
		expect(result.kind).toBe("no-plan");
	});

	it("returns 'refuse-no-actionable' when plan exists but every phase is shipped", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "shipped" }),
		]);
		const result = classifyImplementContext(plan);
		expect(result.kind).toBe("refuse-no-actionable");
	});

	it("returns 'refuse-no-actionable' for mixed shipped/abandoned phases", () => {
		// The fix's main regression risk: a future change rerouting this
		// case back to /implement's legacy description-derived branch
		// fallback would surface here as a flipped kind.
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped" }),
			makePhase({ id: "p-2", status: "abandoned" }),
		]);
		const result = classifyImplementContext(plan);
		expect(result.kind).toBe("refuse-no-actionable");
	});

	it("returns 'refuse-no-actionable' when plan has zero phases", () => {
		// Empty plans don't appear in normal flow (`/plan` ensures at
		// least one phase exists), but if one slips through we still want
		// the safe path — not the legacy description-derived branch.
		const plan = makePlan([]);
		const result = classifyImplementContext(plan);
		expect(result.kind).toBe("refuse-no-actionable");
	});

	it.each<PhaseStatus>([
		"active",
		"needs-attention",
	])("returns 'use-phase' with the in-flight phase when status is %s", (status) => {
		const inFlight = makePhase({ id: "p-active", status });
		const plan = makePlan([
			makePhase({ id: "p-shipped", status: "shipped" }),
			inFlight,
			makePhase({ id: "p-next", status: "planned" }),
		]);
		const result = classifyImplementContext(plan);
		expect(result.kind).toBe("use-phase");
		if (result.kind === "use-phase") {
			expect(result.phase.id).toBe("p-active");
		}
	});

	it("returns 'use-phase' with the next planned phase when nothing is in flight", () => {
		const plan = makePlan([
			makePhase({ id: "p-shipped", status: "shipped" }),
			makePhase({ id: "p-next", status: "planned" }),
			makePhase({ id: "p-later", status: "planned" }),
		]);
		const result = classifyImplementContext(plan);
		expect(result.kind).toBe("use-phase");
		if (result.kind === "use-phase") {
			expect(result.phase.id).toBe("p-next");
		}
	});

	it("prefers in-flight over planned when both exist", () => {
		const plan = makePlan([
			makePhase({ id: "p-active", status: "active" }),
			makePhase({ id: "p-planned", status: "planned" }),
		]);
		const result = classifyImplementContext(plan);
		expect(result.kind).toBe("use-phase");
		if (result.kind === "use-phase") {
			expect(result.phase.id).toBe("p-active");
		}
	});
});
