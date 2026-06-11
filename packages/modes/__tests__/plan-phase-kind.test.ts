import { describe, expect, it } from "vitest";
import {
	chainHead,
	findLifecycle,
	isDeliverableReady,
	type Deliverable as Phase,
	type Plan,
	pendingLifecycle,
	readyDeliverables,
	regularDeliverables,
} from "../plan/schema.js";

const NOW = "2026-05-16T00:00:00.000Z";

function makePlan(nodes: Phase[]): Plan {
	return {
		slug: "test",
		title: "Test",
		repo: { path: "/tmp/r" },
		nodes,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		type: "deliverable" as const,
		id: "p",
		title: "P",
		body: "g",
		status: "planned",
		branch: "feat/p",
		dependsOn: [],
		children: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe("lifecycle field", () => {
	it("absent lifecycle means a regular deliverable", () => {
		expect(makePhase({}).lifecycle).toBeUndefined();
	});

	it("carries the explicit lifecycle when set", () => {
		expect(makePhase({ lifecycle: "pre" }).lifecycle).toBe("pre");
		expect(makePhase({ lifecycle: "post" }).lifecycle).toBe("post");
	});
});

describe("findPrePhase / findPostPhase", () => {
	it("finds pre/post phases by kind", () => {
		const pre = makePhase({ id: "pre", lifecycle: "pre" });
		const reg = makePhase({ id: "r1" });
		const post = makePhase({ id: "post", lifecycle: "post" });
		const plan = makePlan([pre, reg, post]);
		expect(findLifecycle(plan, "pre")?.id).toBe("pre");
		expect(findLifecycle(plan, "post")?.id).toBe("post");
	});

	it("returns undefined when no pre/post exists", () => {
		const plan = makePlan([makePhase({ id: "r1" })]);
		expect(findLifecycle(plan, "pre")).toBeUndefined();
		expect(findLifecycle(plan, "post")).toBeUndefined();
	});
});

describe("regularPhases", () => {
	it("filters out pre and post", () => {
		const plan = makePlan([
			makePhase({ id: "pre", lifecycle: "pre" }),
			makePhase({ id: "r1" }),
			makePhase({ id: "r2" }),
			makePhase({ id: "post", lifecycle: "post" }),
		]);
		expect(regularDeliverables(plan).map((p) => p.id)).toEqual(["r1", "r2"]);
	});
});

describe("pendingPrePhase / pendingPostPhase", () => {
	it("returns the pre-phase when any task is undone", () => {
		const pre = makePhase({
			id: "pre",
			lifecycle: "pre",
			branch: "",
			children: [
				{
					type: "work-item" as const,
					id: "t1",
					title: "rename secret",
					body: "",
					done: false,
					createdAt: NOW,
					updatedAt: NOW,
				},
			],
		});
		const plan = makePlan([pre]);
		expect(pendingLifecycle(plan, "pre")?.id).toBe("pre");
	});

	it("returns null when every pre-phase task is done", () => {
		const pre = makePhase({
			id: "pre",
			lifecycle: "pre",
			branch: "",
			children: [
				{
					type: "work-item" as const,
					id: "t1",
					title: "rename secret",
					body: "",
					done: true,
					createdAt: NOW,
					updatedAt: NOW,
				},
			],
		});
		const plan = makePlan([pre]);
		expect(pendingLifecycle(plan, "pre")).toBeNull();
	});

	it("returns null when pre-phase has no tasks", () => {
		const pre = makePhase({ id: "pre", lifecycle: "pre" });
		expect(pendingLifecycle(makePlan([pre]), "pre")).toBeNull();
	});

	it("returns null when no pre-phase exists", () => {
		expect(
			pendingLifecycle(makePlan([makePhase({ id: "r1" })]), "pre"),
		).toBeNull();
	});

	it("post-phase variant follows the same rules", () => {
		const post = makePhase({
			id: "post",
			lifecycle: "post",
			branch: "",
			children: [
				{
					type: "work-item" as const,
					id: "t1",
					title: "deploy",
					body: "",
					done: false,
					createdAt: NOW,
					updatedAt: NOW,
				},
			],
		});
		expect(pendingLifecycle(makePlan([post]), "post")?.id).toBe("post");
	});
});

describe("isDeliverableReady — kind awareness", () => {
	it("returns false for pre-phase even when planned and unblocked", () => {
		const pre = makePhase({ id: "pre", lifecycle: "pre" });
		expect(isDeliverableReady(makePlan([pre]), pre)).toBe(false);
	});

	it("returns false for post-phase even when planned and unblocked", () => {
		const post = makePhase({ id: "post", lifecycle: "post" });
		expect(isDeliverableReady(makePlan([post]), post)).toBe(false);
	});

	it("returns true for regular planned root phase", () => {
		const r = makePhase({ id: "r" });
		expect(isDeliverableReady(makePlan([r]), r)).toBe(true);
	});
});

describe("readyDeliverables — pre/post excluded", () => {
	it("only surfaces regular phases", () => {
		const plan = makePlan([
			makePhase({ id: "pre", lifecycle: "pre" }),
			makePhase({ id: "r1" }),
			makePhase({ id: "post", lifecycle: "post" }),
		]);
		expect(readyDeliverables(plan).map((p) => p.id)).toEqual(["r1"]);
	});
});

describe("chainHead — skips pre/post", () => {
	it("walks past a non-regular successor", () => {
		const r1 = makePhase({ id: "r1", status: "shipped", dependsOn: [] });
		const post = makePhase({
			id: "post",
			lifecycle: "post",
			branch: "",
			dependsOn: ["r1"],
		});
		const r2 = makePhase({ id: "r2", dependsOn: ["post"] });
		const plan = makePlan([r1, post, r2]);
		expect(chainHead(plan, r1)?.id).toBe("r2");
	});
});
