import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { Plan } from "../plan/schema.js";
import { _setPlansRootForTests, loadPlan, savePlan } from "../plan/storage.js";
import { registerPlanTools } from "../plan/tools.js";

let tmp: string;
let registeredTools: Map<string, any>;

const mockPi: any = {
	registerTool: (spec: any) => {
		registeredTools.set(spec.name, spec);
	},
};

const mockCtx: any = { cwd: "/tmp" };

function call(toolName: string, params: any) {
	const tool = registeredTools.get(toolName);
	if (!tool) throw new Error(`tool ${toolName} not registered`);
	return tool.execute("call-id", params, undefined, () => {}, mockCtx);
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
	const now = new Date().toISOString();
	return {
		slug: "tools-test",
		title: "Tools Test",
		repo: { path: "/tmp/repo" },
		phases: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

let onChanged: ReturnType<typeof vi.fn>;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "modes-tools-test-"));
	_setPlansRootForTests(tmp);
	registeredTools = new Map();
	onChanged = vi.fn();
	registerPlanTools(mockPi, {
		getCurrentPlanSlug: () => "tools-test",
		onPlanChanged: onChanged,
	});
	savePlan(makePlan());
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("plan_phase", () => {
	it("adds a phase with default status planned", async () => {
		const r = await call("plan_phase", {
			action: "add",
			title: "Add validation",
			goal: "Validate inputs",
		});
		expect(r.details.action).toBe("add");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases).toHaveLength(1);
		expect(plan.phases[0].status).toBe("planned");
		expect(plan.phases[0].id).toBe("add-validation");
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("rejects duplicate phase id", async () => {
		await call("plan_phase", { action: "add", title: "Foo" });
		const r = await call("plan_phase", { action: "add", title: "Foo" });
		expect(r.details.error).toBe("duplicate phase id");
	});

	it("update enforces state machine", async () => {
		await call("plan_phase", { action: "add", title: "Foo" });
		const bad = await call("plan_phase", {
			action: "update",
			id: "foo",
			status: "shipped",
		});
		expect(bad.details.error).toBe("invalid transition");

		const good = await call("plan_phase", {
			action: "update",
			id: "foo",
			status: "active",
		});
		expect(good.details.action).toBe("update");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].status).toBe("active");
	});

	it("remove deletes the phase", async () => {
		await call("plan_phase", { action: "add", title: "Foo" });
		await call("plan_phase", { action: "remove", id: "foo" });
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases).toHaveLength(0);
	});

	it("reorder moves a phase by id", async () => {
		await call("plan_phase", { action: "add", title: "First" });
		await call("plan_phase", { action: "add", title: "Second" });
		await call("plan_phase", {
			action: "reorder",
			id: "second",
			position: 0,
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases.map((p) => p.id)).toEqual(["second", "first"]);
	});

	it("accepts legacy `p-` prefixed ids on tool calls", async () => {
		await call("plan_phase", { action: "add", title: "Legacy" });
		const r = await call("plan_phase", {
			action: "update",
			id: "p-legacy",
			status: "active",
		});
		expect(r.details.action).toBe("update");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].id).toBe("legacy");
		expect(plan.phases[0].status).toBe("active");
	});

	it("list returns phases", async () => {
		await call("plan_phase", { action: "add", title: "A" });
		const r = await call("plan_phase", { action: "list" });
		expect(r.details.action).toBe("list");
		expect(r.details.phases as any[]).toHaveLength(1);
	});
});

describe("plan_task", () => {
	beforeEach(async () => {
		await call("plan_phase", { action: "add", title: "Phase one" });
	});

	it("adds a task to a phase", async () => {
		const r = await call("plan_task", {
			action: "add",
			phaseId: "phase-one",
			title: "Write spec",
			body: "Detailed body",
		});
		expect(r.details.action).toBe("add");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks).toHaveLength(1);
		expect(plan.phases[0].tasks[0].title).toBe("Write spec");
		expect(plan.phases[0].tasks[0].body).toBe("Detailed body");
		expect(plan.phases[0].tasks[0].done).toBe(false);
	});

	it("toggle marks a task done", async () => {
		await call("plan_task", {
			action: "add",
			phaseId: "phase-one",
			title: "Foo",
		});
		await call("plan_task", {
			action: "toggle",
			phaseId: "phase-one",
			taskId: "foo",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks[0].done).toBe(true);
	});

	it("remove deletes a task", async () => {
		await call("plan_task", {
			action: "add",
			phaseId: "phase-one",
			title: "Foo",
		});
		await call("plan_task", {
			action: "remove",
			phaseId: "phase-one",
			taskId: "foo",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks).toHaveLength(0);
	});

	it("move relocates a task to another phase", async () => {
		await call("plan_phase", { action: "add", title: "Phase two" });
		await call("plan_task", {
			action: "add",
			phaseId: "phase-one",
			title: "Task A",
		});
		await call("plan_task", {
			action: "move",
			phaseId: "phase-one",
			taskId: "task-a",
			targetPhaseId: "phase-two",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks).toHaveLength(0);
		expect(plan.phases[1].tasks).toHaveLength(1);
		expect(plan.phases[1].tasks[0].id).toBe("task-a");
	});

	it("update changes title and body", async () => {
		await call("plan_task", {
			action: "add",
			phaseId: "phase-one",
			title: "Old",
		});
		await call("plan_task", {
			action: "update",
			phaseId: "phase-one",
			taskId: "old",
			body: "new body",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks[0].body).toBe("new body");
	});

	it("accepts legacy `t-` prefixed taskId on tool calls", async () => {
		await call("plan_task", {
			action: "add",
			phaseId: "phase-one",
			title: "Migrate",
		});
		const r = await call("plan_task", {
			action: "toggle",
			phaseId: "phase-one",
			taskId: "t-migrate",
		});
		expect(r.details.action).toBe("toggle");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks[0].id).toBe("migrate");
		expect(plan.phases[0].tasks[0].done).toBe(true);
	});
});

describe("plan_view", () => {
	it("returns markdown summary", async () => {
		await call("plan_phase", {
			action: "add",
			title: "Foo",
			goal: "Make it work",
		});
		await call("plan_task", {
			action: "add",
			phaseId: "foo",
			title: "Step",
		});
		const r = await call("plan_view", {});
		const text = (r.content[0] as any).text as string;
		expect(text).toContain("Tools Test");
		expect(text).toContain("`foo`");
		expect(text).toContain("Step");
		expect(text).toContain("Make it work");
	});

	it("reports no plan when slug missing", async () => {
		// Re-register with null slug.
		registeredTools = new Map();
		registerPlanTools(mockPi, {
			getCurrentPlanSlug: () => null,
			onPlanChanged: onChanged,
		});
		const r = await call("plan_view", {});
		expect((r.details as any).error).toBeDefined();
	});
});

describe("plan_phase dependsOn", () => {
	it("stores dependsOn on add", async () => {
		await call("plan_phase", { action: "add", title: "First" });
		const r = await call("plan_phase", {
			action: "add",
			title: "Second",
			dependsOn: ["first"],
		});
		expect(r.details.action).toBe("add");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[1].dependsOn).toEqual(["first"]);
	});

	it("defaults dependsOn to last phase when omitted (linear chain ergonomic)", async () => {
		await call("plan_phase", { action: "add", title: "First" });
		await call("plan_phase", { action: "add", title: "Second" });
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[1].dependsOn).toEqual(["first"]);
	});

	it("first phase in an empty plan defaults to []", async () => {
		await call("plan_phase", { action: "add", title: "Solo" });
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].dependsOn).toEqual([]);
	});

	it("explicit dependsOn: [] declares a sibling root (overrides default)", async () => {
		await call("plan_phase", { action: "add", title: "First" });
		await call("plan_phase", {
			action: "add",
			title: "Second",
			dependsOn: [],
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[1].dependsOn).toEqual([]);
	});

	it("explicit dependsOn forks off an earlier phase", async () => {
		await call("plan_phase", { action: "add", title: "A" });
		await call("plan_phase", { action: "add", title: "B" });
		await call("plan_phase", {
			action: "add",
			title: "C",
			dependsOn: ["a"],
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[2].dependsOn).toEqual(["a"]);
	});

	it("rejects multi-parent on add (chain-only constraint)", async () => {
		await call("plan_phase", { action: "add", title: "A" });
		await call("plan_phase", { action: "add", title: "B" });
		const r = await call("plan_phase", {
			action: "add",
			title: "C",
			dependsOn: ["a", "b"],
		});
		expect(r.details.error).toContain("cannot depend on multiple phases");
	});

	it("rejects unknown dependsOn id", async () => {
		const r = await call("plan_phase", {
			action: "add",
			title: "X",
			dependsOn: ["nope"],
		});
		expect(r.details.error).toContain("unknown phase");
	});

	it("rejects self-reference on update", async () => {
		await call("plan_phase", { action: "add", title: "Solo" });
		const r = await call("plan_phase", {
			action: "update",
			id: "solo",
			dependsOn: ["solo"],
		});
		expect(r.details.error).toContain("cannot depend on itself");
	});

	it("detects 2-cycle on update (A → B → A)", async () => {
		// Add A and B as roots so neither has a dependsOn yet, then create
		// the chain manually with updates.
		await call("plan_phase", { action: "add", title: "A" });
		await call("plan_phase", { action: "add", title: "B" });
		await call("plan_phase", {
			action: "update",
			id: "b",
			dependsOn: ["a"],
		});
		// Now point A back at B: this should be a cycle.
		const r = await call("plan_phase", {
			action: "update",
			id: "a",
			dependsOn: ["b"],
		});
		expect(r.details.error).toContain("cycle");
	});

	it("detects 3-cycle on update (A → B → C → A)", async () => {
		await call("plan_phase", { action: "add", title: "A" });
		await call("plan_phase", { action: "add", title: "B" });
		await call("plan_phase", { action: "add", title: "C" });
		await call("plan_phase", {
			action: "update",
			id: "b",
			dependsOn: ["a"],
		});
		await call("plan_phase", {
			action: "update",
			id: "c",
			dependsOn: ["b"],
		});
		const r = await call("plan_phase", {
			action: "update",
			id: "a",
			dependsOn: ["c"],
		});
		expect(r.details.error).toContain("cycle");
	});

	it("canonicalises legacy `p-` prefix in dependsOn", async () => {
		await call("plan_phase", { action: "add", title: "Root" });
		const r = await call("plan_phase", {
			action: "add",
			title: "Child",
			dependsOn: ["p-root"],
		});
		expect(r.details.action).toBe("add");
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[1].dependsOn).toEqual(["root"]);
	});
});

describe("plan_task kind + @plan sentinel", () => {
	it("round-trips kind on add and update", async () => {
		await call("plan_phase", { action: "add", title: "P" });
		await call("plan_task", {
			action: "add",
			phaseId: "p",
			title: "Note",
			kind: "followUp",
		});
		const plan1 = loadPlan("tools-test") as Plan;
		expect(plan1.phases[0].tasks[0].kind).toBe("followUp");

		await call("plan_task", {
			action: "update",
			phaseId: "p",
			taskId: "note",
			kind: "manual",
		});
		const plan2 = loadPlan("tools-test") as Plan;
		expect(plan2.phases[0].tasks[0].kind).toBe("manual");
	});

	it("defaults kind to deliverable when omitted", async () => {
		await call("plan_phase", { action: "add", title: "P" });
		await call("plan_task", {
			action: "add",
			phaseId: "p",
			title: "T",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks[0].kind).toBe("deliverable");
	});

	it("@plan: add stores task on plan.followUps", async () => {
		await call("plan_task", {
			action: "add",
			phaseId: "@plan",
			title: "Cross-cutting note",
			kind: "followUp",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.followUps).toHaveLength(1);
		expect(plan.followUps?.[0].title).toBe("Cross-cutting note");
		expect(plan.followUps?.[0].kind).toBe("followUp");
	});

	it("@plan: toggle marks plan-level task done", async () => {
		await call("plan_task", {
			action: "add",
			phaseId: "@plan",
			title: "Tell support",
		});
		await call("plan_task", {
			action: "toggle",
			phaseId: "@plan",
			taskId: "tell-support",
		});
		const plan = loadPlan("tools-test") as Plan;
		expect(plan.followUps?.[0].done).toBe(true);
	});

	it("@plan: move from phase to @plan and back", async () => {
		await call("plan_phase", { action: "add", title: "Phase" });
		await call("plan_task", {
			action: "add",
			phaseId: "phase",
			title: "Mover",
		});
		await call("plan_task", {
			action: "move",
			phaseId: "phase",
			taskId: "mover",
			targetPhaseId: "@plan",
		});
		let plan = loadPlan("tools-test") as Plan;
		expect(plan.phases[0].tasks).toHaveLength(0);
		expect(plan.followUps?.[0].id).toBe("mover");

		await call("plan_task", {
			action: "move",
			phaseId: "@plan",
			taskId: "mover",
			targetPhaseId: "phase",
		});
		plan = loadPlan("tools-test") as Plan;
		expect(plan.followUps).toHaveLength(0);
		expect(plan.phases[0].tasks[0].id).toBe("mover");
	});
});

describe("plan_view markdown rendering", () => {
	it("renders dependsOn header, task kind markers, and follow-ups section", async () => {
		await call("plan_phase", { action: "add", title: "Root" });
		await call("plan_phase", {
			action: "add",
			title: "Child",
			dependsOn: ["root"],
		});
		await call("plan_task", {
			action: "add",
			phaseId: "child",
			title: "Ship it",
		});
		await call("plan_task", {
			action: "add",
			phaseId: "child",
			title: "Open question",
			kind: "question",
		});
		await call("plan_task", {
			action: "add",
			phaseId: "@plan",
			title: "Tell support",
			kind: "followUp",
		});
		const r = await call("plan_view", {});
		const text = (r.content[0] as any).text as string;
		expect(text).toContain("depends on: `root`");
		// Deliverable still uses [ ]/[x].
		expect(text).toMatch(/- \[ \] \*\*Ship it\*\*/);
		// Question kind rendered with [?] marker.
		expect(text).toContain("[?] **Open question**");
		// Follow-ups section appears at the end.
		expect(text).toContain("## Follow-ups");
		expect(text).toContain("[~] **Tell support**");
	});
});
