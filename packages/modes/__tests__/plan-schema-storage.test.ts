import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canTransition,
	type PhaseStatus,
	type Plan,
	phaseId,
	repoNameFromPath,
	slugify,
	taskId,
} from "../plan/schema.js";
import {
	_setPlansRootForTests,
	activePlanForRepo,
	deletePlan,
	listPlans,
	loadPlan,
	planExists,
	plansForRepo,
	rebuildIndex,
	savePlan,
} from "../plan/storage.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "modes-plan-test-"));
	_setPlansRootForTests(tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
	const now = new Date().toISOString();
	return {
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/tmp/repo-a" },
		phases: [],
		shipPolicy: "prompt",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("schema helpers", () => {
	it("slugify lowercases and dashes special chars", () => {
		expect(slugify("Add Validation Logic!")).toBe("add-validation-logic");
		expect(slugify("foo___bar")).toBe("foo-bar");
		expect(slugify("  trim me  ")).toBe("trim-me");
		expect(slugify("UPPER")).toBe("upper");
	});

	it("phaseId prefixes with p-", () => {
		expect(phaseId("Add validation")).toBe("p-add-validation");
		expect(phaseId("p-already-prefixed")).toBe("p-already-prefixed");
	});

	it("taskId prefixes with t-", () => {
		expect(taskId("Write tests")).toBe("t-write-tests");
	});

	it("repoNameFromPath returns basename", () => {
		expect(repoNameFromPath("/foo/bar/repo-a")).toBe("repo-a");
		expect(repoNameFromPath("/foo/bar/repo-a/")).toBe("repo-a");
	});
});

describe("state machine", () => {
	const cases: Array<[PhaseStatus, PhaseStatus, boolean]> = [
		["planned", "active", true],
		["planned", "abandoned", true],
		["planned", "shipped", false],
		["active", "in-review", true],
		["active", "abandoned", true],
		["active", "shipped", false],
		["in-review", "ready-to-ship", true],
		["in-review", "needs-attention", true],
		["in-review", "active", false],
		["needs-attention", "ready-to-ship", true],
		["needs-attention", "active", false],
		["ready-to-ship", "shipped", true],
		["shipped", "active", false],
		["abandoned", "active", false],
	];

	it.each(cases)("%s -> %s = %s", (from, to, expected) => {
		expect(canTransition(from, to)).toBe(expected);
	});
});

describe("storage", () => {
	it("saves and loads a plan", () => {
		const plan = makePlan();
		savePlan(plan);
		expect(planExists(plan.slug)).toBe(true);
		const loaded = loadPlan(plan.slug);
		expect(loaded).toEqual(plan);
	});

	it("loadPlan returns null for missing plan", () => {
		expect(loadPlan("nonexistent")).toBeNull();
	});

	it("listPlans returns saved plans newest first", () => {
		savePlan(
			makePlan({
				slug: "old",
				title: "Old",
				updatedAt: "2025-01-01T00:00:00Z",
			}),
		);
		savePlan(
			makePlan({
				slug: "new",
				title: "New",
				updatedAt: "2025-12-01T00:00:00Z",
			}),
		);
		const plans = listPlans();
		expect(plans.map((p) => p.slug)).toEqual(["new", "old"]);
	});

	it("plansForRepo filters by repoPath", () => {
		savePlan(makePlan({ slug: "a", repo: { path: "/r1" } }));
		savePlan(makePlan({ slug: "b", repo: { path: "/r2" } }));
		expect(plansForRepo("/r1").map((p) => p.slug)).toEqual(["a"]);
	});

	it("activePlanForRepo skips fully-shipped plans", () => {
		const now = new Date().toISOString();
		savePlan(
			makePlan({
				slug: "shipped",
				repo: { path: "/r" },
				phases: [
					{
						id: "p-1",
						title: "x",
						goal: "g",
						status: "shipped",
						branch: "feat/p-1",
						tasks: [],
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
		savePlan(
			makePlan({
				slug: "active",
				repo: { path: "/r" },
				updatedAt: new Date(Date.now() + 1000).toISOString(),
				phases: [
					{
						id: "p-2",
						title: "y",
						goal: "g",
						status: "active",
						branch: "feat/p-2",
						tasks: [],
						createdAt: now,
						updatedAt: now,
					},
				],
			}),
		);
		const active = activePlanForRepo("/r");
		expect(active?.slug).toBe("active");
	});

	it("empty plans are treated as active so /plan can reuse them", () => {
		savePlan(
			makePlan({ slug: "empty", repo: { path: "/r-empty" }, phases: [] }),
		);
		const active = activePlanForRepo("/r-empty");
		expect(active?.slug).toBe("empty");
	});

	it("loadPlan rejects path-traversal slugs", () => {
		expect(loadPlan("../../etc/passwd")).toBeNull();
		expect(loadPlan("..")).toBeNull();
		expect(loadPlan("foo/bar")).toBeNull();
		expect(loadPlan("")).toBeNull();
		expect(loadPlan("UPPERCASE")).toBeNull();
	});

	it("savePlan rejects invalid slugs", () => {
		expect(() => savePlan(makePlan({ slug: "../evil" }))).toThrow();
		expect(() => savePlan(makePlan({ slug: "foo/bar" }))).toThrow();
	});

	it("deletePlan removes from disk and index", () => {
		savePlan(makePlan());
		expect(planExists("test-plan")).toBe(true);
		deletePlan("test-plan");
		expect(planExists("test-plan")).toBe(false);
		expect(listPlans()).toEqual([]);
	});

	it("rebuildIndex skips malformed plans", () => {
		savePlan(makePlan());
		// Corrupt the file: create an unrelated dir with broken plan.json
		mkdirSync(join(tmp, "broken"), { recursive: true });
		writeFileSync(join(tmp, "broken", "plan.json"), "not json");
		rebuildIndex();
		expect(listPlans().map((p) => p.slug)).toEqual(["test-plan"]);
	});
});
