/**
 * v3 node-forest capabilities: nesting via parentId, the gating XOR,
 * question answers, tree helpers, shape validation, and topological
 * ordering for /park.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { topologicalDeliverables } from "../plan/park-bodies.js";
import {
	type Deliverable,
	deliverables,
	gatingTasks,
	isGrouping,
	ownWorkItems,
	type Plan,
	type PlanNode,
	shipsPR,
	validatePlanShape,
	type WorkItem,
} from "../plan/schema.js";
import { _setPlansRootForTests, loadPlan, savePlan } from "../plan/storage.js";
import { registerPlanTools } from "../plan/tools.js";
import {
	findNode,
	parentOf,
	subtreeComplete,
	topLevelLeaves,
	unansweredQuestions,
	walk,
} from "../plan/tree.js";

let tmp: string;
let tools: Map<
	string,
	(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<Record<string, unknown>>>
>;

const ctx = { cwd: "/tmp" } as ExtensionContext;

function makePi(): ExtensionAPI {
	tools = new Map();
	return {
		registerTool: (tool: {
			name: string;
			execute: typeof tools extends Map<string, infer F> ? F : never;
		}) => {
			tools.set(tool.name, tool.execute);
		},
	} as unknown as ExtensionAPI;
}

async function call(
	name: string,
	params: Record<string, unknown>,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const fn = tools.get(name);
	if (!fn) throw new Error(`tool ${name} not registered`);
	return fn("id", params, undefined, undefined, ctx);
}

function basePlan(): Plan {
	const now = new Date().toISOString();
	return {
		slug: "tree-test",
		title: "Tree Test",
		repo: { path: "/tmp" },
		schemaVersion: 3,
		nodes: [],
		createdAt: now,
		updatedAt: now,
	};
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "modes-tree-test-"));
	_setPlansRootForTests(tmp);
	savePlan(basePlan());
	registerPlanTools(makePi(), {
		getCurrentPlanSlug: () => "tree-test",
		onPlanChanged: () => {},
	});
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
	return {
		type: "work-item",
		id,
		title: id,
		body: "",
		done: false,
		createdAt: "x",
		updatedAt: "x",
		...over,
	};
}

function deliv(id: string, over: Partial<Deliverable> = {}): Deliverable {
	return {
		type: "deliverable",
		id,
		title: id,
		body: "",
		status: "planned",
		branch: `feat/${id}`,
		children: [],
		createdAt: "x",
		updatedAt: "x",
		...over,
	};
}

describe("deliverable tool — nesting", () => {
	it("parentId nests a child under a grouping", async () => {
		await call("deliverable", { action: "add", title: "Parent" });
		const r = await call("deliverable", {
			action: "add",
			title: "Child",
			parentId: "parent",
		});
		expect(r.details.error).toBeUndefined();
		const plan = loadPlan("tree-test") as Plan;
		const parent = deliverables(plan).find((d) => d.id === "parent");
		expect(parent && isGrouping(parent)).toBe(true);
		expect(parentOf(plan, "child")?.id).toBe("parent");
	});

	it("siblings under a grouping default to chaining; explicit [] makes them parallel", async () => {
		await call("deliverable", { action: "add", title: "G" });
		await call("deliverable", { action: "add", title: "A", parentId: "g" });
		await call("deliverable", { action: "add", title: "B", parentId: "g" });
		await call("deliverable", {
			action: "add",
			title: "C",
			parentId: "g",
			dependsOn: [],
		});
		const plan = loadPlan("tree-test") as Plan;
		const byId = new Map(deliverables(plan).map((d) => [d.id, d]));
		expect(byId.get("b")?.dependsOn).toEqual(["a"]);
		expect(byId.get("c")?.dependsOn).toEqual([]);
	});

	it("refuses to nest under a deliverable with gating tasks (XOR)", async () => {
		await call("deliverable", { action: "add", title: "Leaf" });
		await call("task", { action: "add", phaseId: "leaf", title: "Work" });
		const r = await call("deliverable", {
			action: "add",
			title: "Child",
			parentId: "leaf",
		});
		expect(r.details.error).toBe("gating xor violated");
	});

	it("refuses a gating task on a grouping (XOR, other direction)", async () => {
		await call("deliverable", { action: "add", title: "G" });
		await call("deliverable", { action: "add", title: "Child", parentId: "g" });
		const r = await call("task", {
			action: "add",
			phaseId: "g",
			title: "Nope",
		});
		expect(r.details.error).toBe("gating xor violated");
		// Non-gating notes are fine on a grouping.
		const ok = await call("task", {
			action: "add",
			phaseId: "g",
			title: "A question",
			kind: "question",
		});
		expect(ok.details.error).toBeUndefined();
	});

	it("cross-subtree dependsOn is allowed", async () => {
		await call("deliverable", { action: "add", title: "G one" });
		await call("deliverable", { action: "add", title: "A", parentId: "g-one" });
		await call("deliverable", { action: "add", title: "G two", dependsOn: [] });
		const r = await call("deliverable", {
			action: "add",
			title: "B",
			parentId: "g-two",
			dependsOn: ["a"],
		});
		expect(r.details.error).toBeUndefined();
		const plan = loadPlan("tree-test") as Plan;
		expect(deliverables(plan).find((d) => d.id === "b")?.dependsOn).toEqual([
			"a",
		]);
	});
});

describe("task tool — question answers", () => {
	it("update with answer records the decision and stamps decidedAt", async () => {
		await call("deliverable", { action: "add", title: "D" });
		await call("task", {
			action: "add",
			phaseId: "d",
			title: "Pick a db",
			kind: "question",
		});
		const r = await call("task", {
			action: "update",
			phaseId: "d",
			taskId: "pick-a-db",
			answer: "postgres",
		});
		expect(r.details.error).toBeUndefined();
		const plan = loadPlan("tree-test") as Plan;
		const d = deliverables(plan)[0];
		const q = d ? ownWorkItems(d)[0] : undefined;
		expect(q?.answer).toBe("postgres");
		expect(q?.decidedAt).toBeDefined();
	});

	it("@plan rejects gating task items", async () => {
		const r = await call("task", {
			action: "add",
			phaseId: "@plan",
			title: "Gate",
			kind: "task",
		});
		expect(r.details.error).toBe("plan-level task forbidden");
	});
});

describe("tree helpers", () => {
	const plan: Pick<Plan, "nodes"> = {
		nodes: [
			deliv("group", {
				branch: undefined,
				children: [
					deliv("a", {
						status: "shipped",
						children: [item("t1", { done: true })],
					}),
					deliv("b", { children: [item("t2")] }),
				],
			}),
			item("loose", { kind: "followup" }),
			item("openq", { kind: "question" }),
		] as PlanNode[],
	};

	it("walk visits every node with parent and depth", () => {
		const seen: Array<[string, string | null, number]> = [];
		walk(plan, (n, p, depth) => {
			seen.push([n.id, p?.id ?? null, depth]);
		});
		expect(seen).toEqual([
			["group", null, 0],
			["a", "group", 1],
			["t1", "a", 2],
			["b", "group", 1],
			["t2", "b", 2],
			["loose", null, 0],
			["openq", null, 0],
		]);
	});

	it("findNode/parentOf/topLevelLeaves", () => {
		expect(findNode(plan, "t2")?.id).toBe("t2");
		expect(parentOf(plan, "t2")?.id).toBe("b");
		expect(parentOf(plan, "group")).toBeNull();
		expect(topLevelLeaves(plan).map((l) => l.id)).toEqual(["loose", "openq"]);
	});

	it("subtreeComplete: grouping completes when all children's subtrees do", () => {
		const group = plan.nodes[0] as Deliverable;
		expect(subtreeComplete(group)).toBe(false);
		const done = deliv("group", {
			children: [
				deliv("a", { status: "shipped", children: [item("t1")] }),
				deliv("b", { status: "shipped", children: [item("t2")] }),
			],
		});
		expect(subtreeComplete(done)).toBe(true);
	});

	it("shipsPR/gatingTasks distinguish leaves, groupings, lifecycle", () => {
		const group = plan.nodes[0] as Deliverable;
		expect(shipsPR(group)).toBe(false);
		const leaf = deliv("x", { children: [item("t")] });
		expect(shipsPR(leaf)).toBe(true);
		expect(gatingTasks(leaf)).toHaveLength(1);
		const pre = deliv("pre", {
			lifecycle: "pre",
			children: [item("m", { kind: "manual" })],
		});
		expect(shipsPR(pre)).toBe(false);
	});

	it("unansweredQuestions surfaces open questions anywhere", () => {
		const out = unansweredQuestions(plan);
		expect(out.map((o) => o.item.id)).toEqual(["openq"]);
	});
});

describe("validatePlanShape", () => {
	it("accepts a clean forest", () => {
		expect(
			validatePlanShape({
				nodes: [
					deliv("g", {
						children: [deliv("a", { children: [item("t")] })],
					}),
				],
			}),
		).toEqual([]);
	});

	it("flags gating XOR, bad deps, cycles, and nested lifecycle", () => {
		const bad: Pick<Plan, "nodes"> = {
			nodes: [
				deliv("x", {
					dependsOn: ["y"],
					children: [item("t"), deliv("nested")],
				}),
				deliv("y", { dependsOn: ["x"] }),
				deliv("g", {
					children: [deliv("pre-in-tree", { lifecycle: "pre" })],
				}),
			] as PlanNode[],
		};
		const problems = validatePlanShape(bad);
		expect(problems.join("\n")).toContain(
			"gating tasks and child deliverables",
		);
		expect(problems.join("\n")).toContain("cycle");
		expect(problems.join("\n")).toContain("must be top-level");
	});
});

describe("topologicalDeliverables", () => {
	it("orders dependencies before dependents, cross-subtree included", () => {
		const plan: Pick<Plan, "nodes"> = {
			nodes: [
				deliv("g1", {
					children: [deliv("b", { dependsOn: ["a"] })],
				}),
				deliv("a", { dependsOn: [] }),
			] as PlanNode[],
		};
		const order = topologicalDeliverables(plan).map((d) => d.id);
		expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
	});

	it("orders children before their parent grouping", () => {
		const plan: Pick<Plan, "nodes"> = {
			nodes: [
				deliv("g", {
					children: [deliv("c1"), deliv("c2")],
				}),
			] as PlanNode[],
		};
		const order = topologicalDeliverables(plan).map((d) => d.id);
		expect(order.indexOf("c1")).toBeLessThan(order.indexOf("g"));
		expect(order.indexOf("c2")).toBeLessThan(order.indexOf("g"));
	});

	it("degrades gracefully on cycles", () => {
		const plan: Pick<Plan, "nodes"> = {
			nodes: [
				deliv("a", { dependsOn: ["b"] }),
				deliv("b", { dependsOn: ["a"] }),
			] as PlanNode[],
		};
		expect(topologicalDeliverables(plan)).toHaveLength(2);
	});
});
