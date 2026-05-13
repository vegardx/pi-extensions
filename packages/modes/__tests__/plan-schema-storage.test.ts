import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abandonNonTerminalPhases,
	blockedReason,
	canTransition,
	chainHead,
	effectiveDependsOn,
	effectiveTaskKind,
	isPhaseReady,
	matchPhaseId,
	matchTaskId,
	type Phase,
	type PhaseStatus,
	type Plan,
	phaseId,
	pickBaseBranch,
	planImplementBranch,
	readyPhases,
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
	migratePlan,
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

	it("matchPhaseId tolerates legacy `p-` prefix on either side", () => {
		// New plans store plain slugs; legacy plans on disk have `p-` ids;
		// CLI args (`/ship p-foo`) and tool callers may pass either form.
		expect(matchPhaseId("add-webhook", "add-webhook")).toBe(true);
		expect(matchPhaseId("add-webhook", "p-add-webhook")).toBe(true);
		expect(matchPhaseId("p-add-webhook", "add-webhook")).toBe(true);
		expect(matchPhaseId("p-add-webhook", "p-add-webhook")).toBe(true);
		expect(matchPhaseId("add-webhook", "validate")).toBe(false);
	});

	it("matchTaskId tolerates legacy `t-` prefix on either side", () => {
		expect(matchTaskId("do-thing", "do-thing")).toBe(true);
		expect(matchTaskId("do-thing", "t-do-thing")).toBe(true);
		expect(matchTaskId("t-do-thing", "do-thing")).toBe(true);
		expect(matchTaskId("t-do-thing", "t-other")).toBe(false);
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
	it("saves and loads a plan (lazy-migrates v1 \u2192 v2)", () => {
		const plan = makePlan();
		savePlan(plan);
		expect(planExists(plan.slug)).toBe(true);
		const loaded = loadPlan(plan.slug);
		// loadPlan applies migratePlan: v1 plans on disk come back stamped
		// with schemaVersion=2 and followUps=[] so callers always see v2.
		expect(loaded).toEqual({
			...plan,
			schemaVersion: 2,
			followUps: [],
		});
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

	it("returns default branch when phase has no parent", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1", dependsOn: [] })],
		});
		expect(pickBaseBranch(plan, "p-1", DEFAULT)).toBe("main");
	});

	it("returns default when parent is shipped (its work is on main)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("main");
	});

	it("forks from in-review parent's branch", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("forks from ready-to-ship parent's branch", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "ready-to-ship",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("forks from needs-attention parent's branch", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "needs-attention",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("forks from active parent's branch (concurrent driver case)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "active",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("feat/p-1");
	});

	it("abandoned parent → default (parent's branch is dead-end)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "abandoned",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("main");
	});

	it("planned parent → default (parent has no commits yet)", () => {
		// `isPhaseReady` would return false in this state, but the picker
		// stays mechanical: don't fork from a branch that doesn't have any
		// commits. The auto loop won't activate this phase anyway.
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "planned",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-2", DEFAULT)).toBe("main");
	});

	it("unknown parent id → default (defensive)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: ["missing"],
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-1", DEFAULT)).toBe("main");
	});

	it("chain: middle phase forks from its in-flight parent, not the root", () => {
		// p-3 depends on p-2 (in-review). p-2 contains p-1's commits via
		// stacking, so forking from feat/p-2 is correct — NOT from feat/p-1.
		const plan = makePlan({
			phases: [
				makePhase({
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "in-review",
				}),
				makePhase({
					id: "p-3",
					branch: "feat/p-3",
					dependsOn: ["p-2"],
					status: "planned",
				}),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("feat/p-2");
	});

	it("forest: sibling chains don't see each other (different parent edges)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					id: "b",
					branch: "feat/b",
					dependsOn: [],
					status: "planned",
				}),
			],
		});
		// b has no parent → forks from main, even though `a` exists earlier
		// in the array and is in-review.
		expect(pickBaseBranch(plan, "b", DEFAULT)).toBe("main");
	});

	it("v1 plan (dependsOn unset) falls back to nearest non-abandoned predecessor", () => {
		// On migrate, dependsOn would be backfilled to ["p-1"] (skipping the
		// abandoned p-2). Here we test the in-memory fallback directly.
		const plan = makePlan({
			phases: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "abandoned" }),
				makePhase({ id: "p-3", branch: "feat/p-3", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("feat/p-1");
	});

	it("phase id not in plan → default (defensive)", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1", dependsOn: [] })],
		});
		expect(pickBaseBranch(plan, "p-bogus", DEFAULT)).toBe("main");
	});

	it("respects the caller's defaultBranch (e.g. 'master')", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "p-1", branch: "feat/p-1", dependsOn: [] })],
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

describe("migratePlan", () => {
	it("v1 → v2: backfills dependsOn from array order, defaults task.kind, adds followUps + schemaVersion", () => {
		const v1: Plan = {
			slug: "legacy",
			title: "Legacy",
			repo: { path: "/r" },
			phases: [
				makePhase({ id: "a", branch: "feat/a", status: "shipped" }),
				makePhase({ id: "b", branch: "feat/b", status: "in-review" }),
				makePhase({ id: "c", branch: "feat/c", status: "planned" }),
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		};
		v1.phases[0].tasks = [
			{
				id: "t-1",
				title: "do thing",
				body: "",
				done: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		];

		const out = migratePlan(v1);
		expect(out.schemaVersion).toBe(2);
		expect(out.followUps).toEqual([]);
		// Chain root has no parent; later phases get the previous phase as parent.
		expect(out.phases[0].dependsOn).toEqual([]);
		expect(out.phases[1].dependsOn).toEqual(["a"]);
		expect(out.phases[2].dependsOn).toEqual(["b"]);
		// Existing tasks default to deliverable.
		expect(out.phases[0].tasks[0].kind).toBe("deliverable");
	});

	it("derive parent skips abandoned phases", () => {
		const v1: Plan = {
			slug: "legacy-skip",
			title: "Legacy skip",
			repo: { path: "/r" },
			phases: [
				makePhase({ id: "a", branch: "feat/a", status: "shipped" }),
				makePhase({ id: "b", branch: "feat/b", status: "abandoned" }),
				makePhase({ id: "c", branch: "feat/c", status: "planned" }),
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		};
		const out = migratePlan(v1);
		// `c`'s parent should be `a`, not the abandoned `b`.
		expect(out.phases[2].dependsOn).toEqual(["a"]);
	});

	it("is idempotent: v2 → v2 returns the same shape", () => {
		const v1: Plan = {
			slug: "idem",
			title: "Idem",
			repo: { path: "/r" },
			phases: [
				makePhase({ id: "a", branch: "feat/a", status: "in-review" }),
				makePhase({ id: "b", branch: "feat/b", status: "planned" }),
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		};
		const once = migratePlan(v1);
		const twice = migratePlan(once);
		expect(twice).toEqual(once);
	});

	it("normalises a v2 plan that was hand-edited and dropped fields", () => {
		const partial: Plan = {
			slug: "partial-v2",
			title: "Partial",
			repo: { path: "/r" },
			schemaVersion: 2,
			phases: [
				{
					...makePhase({ id: "a", branch: "feat/a", status: "planned" }),
					// dependsOn missing — simulate hand-edit.
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
		};
		const out = migratePlan(partial);
		expect(out.phases[0].dependsOn).toEqual([]);
		expect(out.followUps).toEqual([]);
	});

	it(
		"v2 normalisation backfills dependsOn even when followUps + kinds " +
			"are already present (regression: copilot review on PR #125)",
		() => {
			// Trigger the exact bug path: schemaVersion=2, every task has
			// `kind`, `followUps` is present — so the only missing field is a
			// phase's `dependsOn`. Pre-fix, normaliseV2 returned the original
			// plan because `mutated` never flipped, dropping the backfilled
			// phases array.
			const partial: Plan = {
				slug: "partial-v2-deps-only",
				title: "Partial deps-only",
				repo: { path: "/r" },
				schemaVersion: 2,
				followUps: [],
				phases: [
					{
						...makePhase({ id: "a", branch: "feat/a", status: "planned" }),
						tasks: [
							{
								id: "t-1",
								title: "task",
								body: "",
								done: false,
								kind: "deliverable",
								createdAt: "2026-01-01T00:00:00.000Z",
								updatedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						// dependsOn deliberately omitted.
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
			};
			const out = migratePlan(partial);
			expect(out.phases[0].dependsOn).toEqual([]);
		},
	);
});

describe("effectiveDependsOn", () => {
	it("returns stored dependsOn when present", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "a", branch: "feat/a" }),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(effectiveDependsOn(plan, plan.phases[1])).toEqual(["a"]);
	});

	it("falls back to nearest non-abandoned predecessor when dependsOn unset", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "a", branch: "feat/a", status: "shipped" }),
				makePhase({ id: "b", branch: "feat/b", status: "abandoned" }),
				makePhase({ id: "c", branch: "feat/c", status: "planned" }),
			],
		});
		expect(effectiveDependsOn(plan, plan.phases[2])).toEqual(["a"]);
	});

	it("returns [] for first phase", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "a", branch: "feat/a" })],
		});
		expect(effectiveDependsOn(plan, plan.phases[0])).toEqual([]);
	});
});

describe("effectiveTaskKind", () => {
	it("defaults to deliverable when kind absent", () => {
		expect(effectiveTaskKind({})).toBe("deliverable");
	});

	it("returns explicit kind", () => {
		expect(effectiveTaskKind({ kind: "followUp" })).toBe("followUp");
		expect(effectiveTaskKind({ kind: "manual" })).toBe("manual");
	});
});

describe("isPhaseReady / readyPhases", () => {
	it("first phase with no parent is ready when planned", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "a", branch: "feat/a", dependsOn: [] })],
		});
		expect(isPhaseReady(plan, plan.phases[0])).toBe(true);
		expect(readyPhases(plan).map((p) => p.id)).toEqual(["a"]);
	});

	it("non-planned phases are never ready", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					id: "b",
					branch: "feat/b",
					dependsOn: [],
					status: "shipped",
				}),
			],
		});
		expect(readyPhases(plan)).toEqual([]);
	});

	it("chain: only head is ready when middle is planned", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
				makePhase({ id: "c", branch: "feat/c", dependsOn: ["b"] }),
			],
		});
		expect(readyPhases(plan).map((p) => p.id)).toEqual(["b"]);
	});

	it("forest: roots of two independent chains are both ready", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "a1", branch: "feat/a1", dependsOn: [] }),
				makePhase({ id: "a2", branch: "feat/a2", dependsOn: ["a1"] }),
				makePhase({ id: "b1", branch: "feat/b1", dependsOn: [] }),
				makePhase({ id: "b2", branch: "feat/b2", dependsOn: ["b1"] }),
			],
		});
		expect(readyPhases(plan).map((p) => p.id)).toEqual(["a1", "b1"]);
	});

	it("abandoned parent blocks dependent (does not silently fall back)", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "abandoned",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(isPhaseReady(plan, plan.phases[1])).toBe(false);
		expect(readyPhases(plan)).toEqual([]);
	});

	it("unknown parent blocks the dependent", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["missing"] }),
			],
		});
		expect(isPhaseReady(plan, plan.phases[0])).toBe(false);
	});

	it("v1 plan (dependsOn unset) falls back to array-order parent", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "a", branch: "feat/a", status: "shipped" }),
				makePhase({ id: "b", branch: "feat/b" }),
			],
		});
		expect(readyPhases(plan).map((p) => p.id)).toEqual(["b"]);
	});
});

describe("chainHead", () => {
	it("returns null when phase has no successors", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "a", branch: "feat/a", dependsOn: [] })],
		});
		expect(chainHead(plan, plan.phases[0])).toBeNull();
	});

	it("returns immediate planned successor", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(chainHead(plan, plan.phases[0])?.id).toBe("b");
	});

	it("skips shipped descendants and returns first non-shipped", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					id: "b",
					branch: "feat/b",
					dependsOn: ["a"],
					status: "shipped",
				}),
				makePhase({ id: "c", branch: "feat/c", dependsOn: ["b"] }),
				makePhase({ id: "d", branch: "feat/d", dependsOn: ["c"] }),
			],
		});
		expect(chainHead(plan, plan.phases[0])?.id).toBe("c");
	});

	it("returns null when every descendant is shipped", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					id: "b",
					branch: "feat/b",
					dependsOn: ["a"],
					status: "shipped",
				}),
			],
		});
		expect(chainHead(plan, plan.phases[0])).toBeNull();
	});

	it("on a fork picks the first child by array order", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
				makePhase({ id: "c", branch: "feat/c", dependsOn: ["a"] }),
			],
		});
		expect(chainHead(plan, plan.phases[0])?.id).toBe("b");
	});

	it("is bounded against external on-disk cycles (no infinite loop)", () => {
		// dependsOn cycle b↔c. Plan-tools rejects this at write time;
		// chainHead must not infinite-loop when a hand-edited plan slips
		// one through.
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					id: "b",
					branch: "feat/b",
					dependsOn: ["c"],
					status: "shipped",
				}),
				makePhase({
					id: "c",
					branch: "feat/c",
					dependsOn: ["b"],
					status: "shipped",
				}),
			],
		});
		expect(() => chainHead(plan, plan.phases[0])).not.toThrow();
	});
});

describe("blockedReason", () => {
	it("returns null when phase is ready", () => {
		const plan = makePlan({
			phases: [makePhase({ id: "a", branch: "feat/a", dependsOn: [] })],
		});
		expect(blockedReason(plan, plan.phases[0])).toBeNull();
	});

	it("flags non-planned phase", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
			],
		});
		expect(blockedReason(plan, plan.phases[0])).toContain("in-review");
	});

	it("surfaces parent's status when waiting", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(blockedReason(plan, plan.phases[1])).toBe(
			"waiting on `a` (in-review)",
		);
	});

	it("explains abandoned parent", () => {
		const plan = makePlan({
			phases: [
				makePhase({
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "abandoned",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(blockedReason(plan, plan.phases[1])).toContain("abandoned");
		expect(blockedReason(plan, plan.phases[1])).toContain("dependsOn");
	});

	it("flags unknown parent", () => {
		const plan = makePlan({
			phases: [
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["missing"] }),
			],
		});
		expect(blockedReason(plan, plan.phases[0])).toContain("missing");
	});
});
