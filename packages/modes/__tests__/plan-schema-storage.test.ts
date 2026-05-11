import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abandonNonTerminalPhases,
	canTransition,
	type Phase,
	type PhaseStatus,
	type Plan,
	phaseId,
	pickBaseBranch,
	planImplementBranch,
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
	plansForSession,
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

	it("phaseId returns plain slug, strips legacy `p-` prefix", () => {
		expect(phaseId("Add validation")).toBe("add-validation");
		expect(phaseId("p-already-prefixed")).toBe("already-prefixed");
	});

	it("taskId returns plain slug, strips legacy `t-` prefix", () => {
		expect(taskId("Write tests")).toBe("write-tests");
		expect(taskId("t-already-prefixed")).toBe("already-prefixed");
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

describe("abandonNonTerminalPhases", () => {
	const NOW = "2026-06-01T00:00:00.000Z";

	function phase(id: string, status: PhaseStatus): Phase {
		const t = "2026-01-01T00:00:00.000Z";
		return {
			id,
			title: id,
			goal: "",
			status,
			branch: `feat/${id}`,
			tasks: [],
			createdAt: t,
			updatedAt: t,
		};
	}

	it("flips every non-terminal phase to abandoned and stamps updatedAt", () => {
		const plan: Plan = {
			slug: "p",
			title: "P",
			repo: { path: "/r" },
			phases: [
				phase("p-1", "shipped"),
				phase("p-2", "in-review"),
				phase("p-3", "active"),
				phase("p-4", "planned"),
				phase("p-5", "needs-attention"),
				phase("p-6", "ready-to-ship"),
				phase("p-7", "abandoned"),
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const { plan: out, archived } = abandonNonTerminalPhases(plan, NOW);
		expect(archived.map((p) => p.id)).toEqual([
			"p-2",
			"p-3",
			"p-4",
			"p-5",
			"p-6",
		]);
		expect(out.phases.find((p) => p.id === "p-1")?.status).toBe("shipped");
		expect(out.phases.find((p) => p.id === "p-7")?.status).toBe("abandoned");
		for (const id of ["p-2", "p-3", "p-4", "p-5", "p-6"]) {
			const p = out.phases.find((ph) => ph.id === id);
			expect(p?.status).toBe("abandoned");
			expect(p?.updatedAt).toBe(NOW);
		}
		expect(out.updatedAt).toBe(NOW);
	});

	it("returns empty archived list and preserves updatedAt when nothing to do", () => {
		const plan: Plan = {
			slug: "p",
			title: "P",
			repo: { path: "/r" },
			phases: [phase("p-1", "shipped"), phase("p-2", "abandoned")],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-15T00:00:00.000Z",
		};
		const { plan: out, archived } = abandonNonTerminalPhases(plan, NOW);
		expect(archived).toEqual([]);
		expect(out.updatedAt).toBe("2026-01-15T00:00:00.000Z");
		expect(out.phases).toEqual(plan.phases);
	});

	it("does not mutate the input plan", () => {
		const original: Plan = {
			slug: "p",
			title: "P",
			repo: { path: "/r" },
			phases: [phase("p-1", "in-review")],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const snapshot = JSON.parse(JSON.stringify(original));
		abandonNonTerminalPhases(original, NOW);
		expect(original).toEqual(snapshot);
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

	it("index entry surfaces createdBy + seenIn from the saved plan", () => {
		savePlan(
			makePlan({
				slug: "owned",
				createdBy: { sessionId: "s-owner", sessionName: "work" },
				seenIn: ["s-owner", "s-other"],
			}),
		);
		const entry = listPlans().find((p) => p.slug === "owned");
		expect(entry?.createdBy).toBe("s-owner");
		expect(entry?.seenIn).toEqual(["s-owner", "s-other"]);
	});

	it("legacy plans (no ownership fields) load with createdBy undefined and seenIn []", () => {
		savePlan(makePlan({ slug: "legacy" }));
		const entry = listPlans().find((p) => p.slug === "legacy");
		expect(entry?.createdBy).toBeUndefined();
		expect(entry?.seenIn).toEqual([]);
	});

	it("plansForSession matches createdBy or seenIn", () => {
		savePlan(
			makePlan({
				slug: "created-by-me",
				createdBy: { sessionId: "s-me" },
				seenIn: ["s-me"],
			}),
		);
		savePlan(
			makePlan({
				slug: "adopted-by-me",
				createdBy: { sessionId: "s-other" },
				seenIn: ["s-other", "s-me"],
			}),
		);
		savePlan(
			makePlan({
				slug: "someone-elses",
				createdBy: { sessionId: "s-other" },
				seenIn: ["s-other"],
			}),
		);
		savePlan(makePlan({ slug: "legacy" }));

		const mine = plansForSession("s-me")
			.map((p) => p.slug)
			.sort();
		expect(mine).toEqual(["adopted-by-me", "created-by-me"]);

		expect(plansForSession("s-nobody")).toEqual([]);
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

describe("planImplementBranch", () => {
	const DEFAULT = "main";

	it("planned phase: 'create' with picked base (default branch when no in-flight predecessors)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					status: "planned",
				}),
			],
		});
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, false)).toEqual({
			kind: "create",
			branch: "feat/p-1",
			baseBranch: "main",
		});
	});

	it("planned phase: 'create' with predecessor branch when predecessor is in-review", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		const phase = plan.phases[1];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, false)).toEqual({
			kind: "create",
			branch: "feat/p-2",
			baseBranch: "feat/p-1",
		});
	});

	it("active phase + branch exists: 'resume' (regression — was destructive 'create')", () => {
		// THIS is the bug: previously /implement re-ran on an active phase
		// fired `git checkout -B feat/p-1`, resetting the branch to the
		// default branch and erasing all phase commits. The user could
		// exit auto → plan and never come back without losing work.
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1", status: "active" })],
		});
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, true)).toEqual({
			kind: "resume",
			branch: "feat/p-1",
		});
	});

	it("needs-attention phase + branch exists: 'resume' (preserves PR-review work)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					status: "needs-attention",
				}),
			],
		});
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, true)).toEqual({
			kind: "resume",
			branch: "feat/p-1",
		});
	});

	it("active phase + branch missing: 'abort' (refuse to silently destroy state)", () => {
		// The previous code would have run `git checkout -B feat/p-1`,
		// silently re-creating the branch from the default branch and
		// pretending nothing was wrong. If the user has work on a remote
		// or in the reflog, that's their last chance to recover it.
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1", status: "active" })],
		});
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		const out = planImplementBranch(plan, phase, DEFAULT, false);
		expect(out.kind).toBe("abort");
		if (out.kind === "abort") {
			expect(out.reason).toContain("missing locally");
			expect(out.reason).toContain("`feat/p-1`");
			expect(out.reason).toContain("git reflog");
		}
	});

	it("needs-attention + branch missing: 'abort' (same protection)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					status: "needs-attention",
				}),
			],
		});
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, false).kind).toBe("abort");
	});

	it("planned phase: branchExists is irrelevant (always 'create')", () => {
		// Even if a leftover branch from a previous failed run exists,
		// first activation still creates from the picked base. The actual
		// `git checkout -B` will overwrite it; that's intentional for the
		// planned case.
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1", status: "planned" })],
		});
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		const a = planImplementBranch(plan, phase, DEFAULT, true);
		const b = planImplementBranch(plan, phase, DEFAULT, false);
		expect(a).toEqual(b);
		expect(a.kind).toBe("create");
	});
});
