import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canTransition,
	type Phase,
	type PhaseStatus,
	type Plan,
	phaseId,
	pickBaseBranch,
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
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		id: "p-x",
		title: "Phase X",
		goal: "do x",
		status: "planned",
		branch: "feat/p-x",
		tasks: [],
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

describe("pickBaseBranch", () => {
	const DEFAULT = "main";

	it("returns default branch when phase has no predecessors", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1" })],
		});
		expect(pickBaseBranch(plan, "p-1", DEFAULT)).toBe("main");
	});

	it("returns default when only predecessor is shipped (its work is on main)", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "shipped" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("main");
	});

	it("forks from in-review predecessor's branch", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("forks from ready-to-ship predecessor's branch", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "ready-to-ship" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("forks from needs-attention predecessor's branch", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "needs-attention" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("forks from active predecessor's branch (unusual but supported)", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "active" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("skips abandoned predecessors and walks further back", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "abandoned" }),
				makePhase({ id: "p-3", branch: "feat/p-3", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("feat/p-1");
	});

	it("skips planned predecessors and walks further back", () => {
		// Edge case: shouldn't normally happen (you'd activate phases in
		// order), but the helper should still degrade sensibly.
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
				makePhase({ id: "p-3", branch: "feat/p-3", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("feat/p-1");
	});

	it("uses the FIRST non-skippable predecessor walking backwards", () => {
		// p-2 (in-review) is between p-1 (in-review) and p-3.
		// p-3 should fork from p-2, NOT p-1 — p-2 is built on top of p-1
		// and contains p-1's commits via the previous /implement.
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "in-review" }),
				makePhase({ id: "p-3", branch: "feat/p-3", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("feat/p-2");
	});

	it("returns default when phase id isn't found in the plan (defensive)", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1" })],
		});
		expect(pickBaseBranch(plan, "p-bogus", DEFAULT)).toBe("main");
	});

	it("returns default when every predecessor is skippable", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "abandoned" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "abandoned" }),
				makePhase({ id: "p-3", branch: "feat/p-3", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("main");
	});

	it("respects the caller's defaultBranch (e.g. 'master')", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1" })],
		});
		expect(pickBaseBranch(plan, "p-1", "master")).toBe("master");
	});
});
