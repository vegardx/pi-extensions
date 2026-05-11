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
