import { describe, expect, it } from "vitest";
import {
	chainHead,
	effectivePhaseKind,
	findPostPhase,
	findPrePhase,
	isPhaseReady,
	type Phase,
	type Plan,
	pendingPostPhase,
	pendingPrePhase,
	readyPhases,
	regularPhases,
} from "../plan/schema.js";

const NOW = "2026-05-16T00:00:00.000Z";

function makePlan(phases: Phase[]): Plan {
	return {
		slug: "test",
		title: "Test",
		repo: { path: "/tmp/r" },
		phases,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "p",
		title: "P",
		goal: "g",
		status: "planned",
		branch: "feat/p",
		dependsOn: [],
		tasks: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe("effectivePhaseKind", () => {
	it("defaults to regular when kind is undefined (v1/v2 plans)", () => {
		expect(effectivePhaseKind({ kind: undefined })).toBe("regular");
		expect(effectivePhaseKind({} as Pick<Phase, "kind">)).toBe("regular");
	});

	it("returns the explicit kind when set", () => {
		expect(effectivePhaseKind({ kind: "pre" })).toBe("pre");
		expect(effectivePhaseKind({ kind: "post" })).toBe("post");
		expect(effectivePhaseKind({ kind: "regular" })).toBe("regular");
	});
});

describe("findPrePhase / findPostPhase", () => {
	it("finds pre/post phases by kind", () => {
		const pre = makePhase({ id: "pre", kind: "pre", branch: "" });
		const reg = makePhase({ id: "r1" });
		const post = makePhase({ id: "post", kind: "post", branch: "" });
		const plan = makePlan([pre, reg, post]);
		expect(findPrePhase(plan)?.id).toBe("pre");
		expect(findPostPhase(plan)?.id).toBe("post");
	});

	it("returns undefined when no pre/post exists", () => {
		const plan = makePlan([makePhase({ id: "r1" })]);
		expect(findPrePhase(plan)).toBeUndefined();
		expect(findPostPhase(plan)).toBeUndefined();
	});
});

describe("regularPhases", () => {
	it("filters out pre and post", () => {
		const plan = makePlan([
			makePhase({ id: "pre", kind: "pre", branch: "" }),
			makePhase({ id: "r1" }),
			makePhase({ id: "r2" }),
			makePhase({ id: "post", kind: "post", branch: "" }),
		]);
		expect(regularPhases(plan).map((p) => p.id)).toEqual(["r1", "r2"]);
	});
});

describe("pendingPrePhase / pendingPostPhase", () => {
	it("returns the pre-phase when any task is undone", () => {
		const pre = makePhase({
			id: "pre",
			kind: "pre",
			branch: "",
			tasks: [
				{
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
		expect(pendingPrePhase(plan)?.id).toBe("pre");
	});

	it("returns null when every pre-phase task is done", () => {
		const pre = makePhase({
			id: "pre",
			kind: "pre",
			branch: "",
			tasks: [
				{
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
		expect(pendingPrePhase(plan)).toBeNull();
	});

	it("returns null when pre-phase has no tasks", () => {
		const pre = makePhase({ id: "pre", kind: "pre", branch: "" });
		expect(pendingPrePhase(makePlan([pre]))).toBeNull();
	});

	it("returns null when no pre-phase exists", () => {
		expect(pendingPrePhase(makePlan([makePhase({ id: "r1" })]))).toBeNull();
	});

	it("post-phase variant follows the same rules", () => {
		const post = makePhase({
			id: "post",
			kind: "post",
			branch: "",
			tasks: [
				{
					id: "t1",
					title: "deploy",
					body: "",
					done: false,
					createdAt: NOW,
					updatedAt: NOW,
				},
			],
		});
		expect(pendingPostPhase(makePlan([post]))?.id).toBe("post");
	});
});

describe("isPhaseReady — kind awareness", () => {
	it("returns false for pre-phase even when planned and unblocked", () => {
		const pre = makePhase({ id: "pre", kind: "pre", branch: "" });
		expect(isPhaseReady(makePlan([pre]), pre)).toBe(false);
	});

	it("returns false for post-phase even when planned and unblocked", () => {
		const post = makePhase({ id: "post", kind: "post", branch: "" });
		expect(isPhaseReady(makePlan([post]), post)).toBe(false);
	});

	it("returns true for regular planned root phase", () => {
		const r = makePhase({ id: "r", kind: "regular" });
		expect(isPhaseReady(makePlan([r]), r)).toBe(true);
	});
});

describe("readyPhases — pre/post excluded", () => {
	it("only surfaces regular phases", () => {
		const plan = makePlan([
			makePhase({ id: "pre", kind: "pre", branch: "" }),
			makePhase({ id: "r1" }),
			makePhase({ id: "post", kind: "post", branch: "" }),
		]);
		expect(readyPhases(plan).map((p) => p.id)).toEqual(["r1"]);
	});
});

describe("chainHead — skips pre/post", () => {
	it("walks past a non-regular successor", () => {
		const r1 = makePhase({ id: "r1", status: "shipped", dependsOn: [] });
		const post = makePhase({
			id: "post",
			kind: "post",
			branch: "",
			dependsOn: ["r1"],
		});
		const r2 = makePhase({ id: "r2", dependsOn: ["post"] });
		const plan = makePlan([r1, post, r2]);
		expect(chainHead(plan, r1)?.id).toBe("r2");
	});
});
