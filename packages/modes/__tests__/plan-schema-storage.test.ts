import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abandonNonTerminalDeliverables,
	blockedReason,
	canTransition,
	chainHead,
	deliverables,
	effectiveDependsOn,
	effectiveWorkItemKind,
	isDeliverableReady,
	matchDeliverableId,
	matchWorkItemId,
	ownWorkItems,
	type Deliverable as Phase,
	type DeliverableStatus as PhaseStatus,
	type Plan,
	deliverableId as phaseId,
	pickBaseBranch,
	planImplementBranch,
	readyDeliverables,
	repoNameFromPath,
	slugify,
	workItemId as taskId,
} from "../plan/schema.js";
import {
	_setPlansRootForTests,
	activePlanForRepo,
	assertPlanUnchanged,
	deletePlan,
	listPlans,
	loadPlan,
	migratePlan,
	PlanNotFoundError,
	PlanStaleError,
	planExists,
	plansForRepo,
	plansForSession,
	rebuildIndex,
	SchemaTooNewError,
	savePlan,
	withPlanLock,
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
		nodes: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		type: "deliverable" as const,
		id: "p-x",
		title: "Phase X",
		body: "do x",
		status: "planned",
		branch: "feat/p-x",
		children: [],
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

	it("matchDeliverableId tolerates legacy `p-` prefix on either side", () => {
		// New plans store plain slugs; legacy plans on disk have `p-` ids;
		// CLI args (`/ship p-foo`) and tool callers may pass either form.
		expect(matchDeliverableId("add-webhook", "add-webhook")).toBe(true);
		expect(matchDeliverableId("add-webhook", "p-add-webhook")).toBe(true);
		expect(matchDeliverableId("p-add-webhook", "add-webhook")).toBe(true);
		expect(matchDeliverableId("p-add-webhook", "p-add-webhook")).toBe(true);
		expect(matchDeliverableId("add-webhook", "validate")).toBe(false);
	});

	it("matchWorkItemId tolerates legacy `t-` prefix on either side", () => {
		expect(matchWorkItemId("do-thing", "do-thing")).toBe(true);
		expect(matchWorkItemId("do-thing", "t-do-thing")).toBe(true);
		expect(matchWorkItemId("t-do-thing", "do-thing")).toBe(true);
		expect(matchWorkItemId("t-do-thing", "t-other")).toBe(false);
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

describe("abandonNonTerminalDeliverables", () => {
	const NOW = "2026-06-01T00:00:00.000Z";

	function phase(id: string, status: PhaseStatus): Phase {
		const t = "2026-01-01T00:00:00.000Z";
		return {
			type: "deliverable" as const,
			id,
			title: id,
			body: "",
			status,
			branch: `feat/${id}`,
			children: [],
			createdAt: t,
			updatedAt: t,
		};
	}

	it("flips every non-terminal phase to abandoned and stamps updatedAt", () => {
		const plan: Plan = {
			slug: "p",
			title: "P",
			repo: { path: "/r" },
			nodes: [
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
		const { plan: out, archived } = abandonNonTerminalDeliverables(plan, NOW);
		expect(archived.map((p) => p.id)).toEqual([
			"p-2",
			"p-3",
			"p-4",
			"p-5",
			"p-6",
		]);
		expect(deliverables(out).find((p) => p.id === "p-1")?.status).toBe(
			"shipped",
		);
		expect(deliverables(out).find((p) => p.id === "p-7")?.status).toBe(
			"abandoned",
		);
		for (const id of ["p-2", "p-3", "p-4", "p-5", "p-6"]) {
			const p = deliverables(out).find((ph) => ph.id === id);
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
			nodes: [phase("p-1", "shipped"), phase("p-2", "abandoned")],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-15T00:00:00.000Z",
		};
		const { plan: out, archived } = abandonNonTerminalDeliverables(plan, NOW);
		expect(archived).toEqual([]);
		expect(out.updatedAt).toBe("2026-01-15T00:00:00.000Z");
		expect(deliverables(out)).toEqual(deliverables(plan));
	});

	it("does not mutate the input plan", () => {
		const original: Plan = {
			slug: "p",
			title: "P",
			repo: { path: "/r" },
			nodes: [phase("p-1", "in-review")],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
		const snapshot = JSON.parse(JSON.stringify(original));
		abandonNonTerminalDeliverables(original, NOW);
		expect(original).toEqual(snapshot);
	});
});

describe("storage", () => {
	it("saves and loads a plan (lazy-migrates to the current schema)", () => {
		const plan = makePlan();
		savePlan(plan);
		expect(planExists(plan.slug)).toBe(true);
		const loaded = loadPlan(plan.slug);
		// loadPlan applies migratePlan: v1 plans on disk come back stamped
		// with schemaVersion=2 and followUps=[] so callers always see v2.
		expect(loaded).toEqual({
			...plan,
			schemaVersion: 3,
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
				nodes: [
					{
						type: "deliverable" as const,
						id: "p-1",
						title: "x",
						body: "g",
						status: "shipped",
						branch: "feat/p-1",
						children: [],
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
				nodes: [
					{
						type: "deliverable" as const,
						id: "p-2",
						title: "y",
						body: "g",
						status: "active",
						branch: "feat/p-2",
						children: [],
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
			makePlan({ slug: "empty", repo: { path: "/r-empty" }, nodes: [] }),
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
			nodes: [makePhase({ id: "p-1", branch: "feat/p-1", dependsOn: [] })],
		});
		expect(pickBaseBranch(plan, "p-1", DEFAULT)).toBe("main");
	});

	it("returns default when parent is shipped (its work is on main)", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "ready-to-ship",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "needs-attention",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "active",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "abandoned",
				}),
				makePhase({
					type: "deliverable" as const,
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
		// `isDeliverableReady` would return false in this state, but the picker
		// stays mechanical: don't fork from a branch that doesn't have any
		// commits. The auto loop won't activate this phase anyway.
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "planned",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					type: "deliverable" as const,
					id: "p-2",
					branch: "feat/p-2",
					dependsOn: ["p-1"],
					status: "in-review",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					type: "deliverable" as const,
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
			nodes: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "abandoned" }),
				makePhase({ id: "p-3", branch: "feat/p-3", status: "planned" }),
			],
		});
		expect(pickBaseBranch(plan, "p-3", DEFAULT)).toBe("feat/p-1");
	});

	it("phase id not in plan → default (defensive)", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "p-1", branch: "feat/p-1", dependsOn: [] })],
		});
		expect(pickBaseBranch(plan, "p-bogus", DEFAULT)).toBe("main");
	});

	it("respects the caller's defaultBranch (e.g. 'master')", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "p-1", branch: "feat/p-1", dependsOn: [] })],
		});
		expect(pickBaseBranch(plan, "p-1", "master")).toBe("master");
	});
});

describe("planImplementBranch", () => {
	const DEFAULT = "main";

	it("planned phase: 'create' with picked base (default branch when no in-flight predecessors)", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					status: "planned",
				}),
			],
		});
		const phase = deliverables(plan)[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, false)).toEqual({
			kind: "create",
			branch: "feat/p-1",
			baseBranch: "main",
		});
	});

	it("planned phase: 'create' with predecessor branch when predecessor is in-review", () => {
		const plan = makePlan({
			nodes: [
				makePhase({ id: "p-1", branch: "feat/p-1", status: "in-review" }),
				makePhase({ id: "p-2", branch: "feat/p-2", status: "planned" }),
			],
		});
		const phase = deliverables(plan)[1];
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
			nodes: [makePhase({ id: "p-1", branch: "feat/p-1", status: "active" })],
		});
		const phase = deliverables(plan)[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, true)).toEqual({
			kind: "resume",
			branch: "feat/p-1",
		});
	});

	it("needs-attention phase + branch exists: 'resume' (preserves PR-review work)", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					status: "needs-attention",
				}),
			],
		});
		const phase = deliverables(plan)[0];
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
			nodes: [makePhase({ id: "p-1", branch: "feat/p-1", status: "active" })],
		});
		const phase = deliverables(plan)[0];
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
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "p-1",
					branch: "feat/p-1",
					status: "needs-attention",
				}),
			],
		});
		const phase = deliverables(plan)[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(planImplementBranch(plan, phase, DEFAULT, false).kind).toBe("abort");
	});

	it("planned phase: branchExists is irrelevant (always 'create')", () => {
		// Even if a leftover branch from a previous failed run exists,
		// first activation still creates from the picked base. The actual
		// `git checkout -B` will overwrite it; that's intentional for the
		// planned case.
		const plan = makePlan({
			nodes: [makePhase({ id: "p-1", branch: "feat/p-1", status: "planned" })],
		});
		const phase = deliverables(plan)[0];
		if (!phase) throw new Error("fixture missing phase");
		const a = planImplementBranch(plan, phase, DEFAULT, true);
		const b = planImplementBranch(plan, phase, DEFAULT, false);
		expect(a).toEqual(b);
		expect(a.kind).toBe("create");
	});
});

describe("migratePlan (v1/v2 \u2192 v3)", () => {
	const legacyTask = {
		id: "t-1",
		title: "do thing",
		body: "details",
		done: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};

	function legacyPhase(over: Record<string, unknown> = {}) {
		return {
			id: "a",
			title: "Phase A",
			goal: "ship a",
			status: "planned",
			branch: "feat/a",
			tasks: [],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			...over,
		};
	}

	function legacyPlan(over: Record<string, unknown> = {}) {
		return {
			slug: "legacy",
			title: "Legacy",
			repo: { path: "/r" },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-02T00:00:00.000Z",
			...over,
		} as unknown as Plan;
	}

	it("v1 \u2192 v3 double hop: backfills dependsOn, remaps kinds, lifts followUps", () => {
		const v1 = legacyPlan({
			phases: [
				legacyPhase({ id: "a", status: "shipped", tasks: [legacyTask] }),
				legacyPhase({ id: "b", branch: "feat/b", status: "in-review" }),
				legacyPhase({ id: "c", branch: "feat/c", status: "planned" }),
			],
			followUps: [{ ...legacyTask, id: "fu-1", kind: "followUp", done: false }],
		});
		const out = migratePlan(v1);
		expect(out.schemaVersion).toBe(3);
		const flat = deliverables(out);
		expect(flat[0]?.dependsOn).toEqual([]);
		expect(flat[1]?.dependsOn).toEqual(["a"]);
		expect(flat[2]?.dependsOn).toEqual(["b"]);
		// Legacy default task kind `deliverable` remaps to `task`.
		const items = flat[0] ? ownWorkItems(flat[0]) : [];
		expect(items[0]?.kind).toBe("task");
		expect(items[0]?.type).toBe("work-item");
		// Plan-level followUps become top-level loose leaves with the
		// remapped `followup` kind.
		const loose = out.nodes.filter((n) => n.type === "work-item");
		expect(loose).toHaveLength(1);
		expect(loose[0]?.id).toBe("fu-1");
		expect((loose[0] as { kind?: string }).kind).toBe("followup");
	});

	it("v2 \u2192 v3 carries every phase field and renames goal\u2192body, tasks\u2192children", () => {
		const v2 = legacyPlan({
			slug: "carry",
			schemaVersion: 2,
			phases: [
				legacyPhase({
					id: "a",
					goal: "the goal",
					status: "in-review",
					dependsOn: [],
					worktreePath: "/wt/a",
					sessionPath: "/s/a.jsonl",
					driverSessionId: "sess-1",
					driverSessionFile: "/s/a.jsonl",
					driverClaimedAt: "2026-01-03T00:00:00.000Z",
					issueNumber: 12,
					prNumber: 34,
					summary: "did the thing",
					tokens: {
						phase: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						midPhase: [],
					},
					tasks: [{ ...legacyTask, kind: "question" }],
				}),
			],
			followUps: [],
		});
		const out = migratePlan(v2);
		const d = deliverables(out)[0];
		if (!d) throw new Error("missing deliverable");
		expect(d.type).toBe("deliverable");
		expect(d.body).toBe("the goal");
		expect((d as { goal?: unknown }).goal).toBeUndefined();
		expect(d.worktreePath).toBe("/wt/a");
		expect(d.sessionPath).toBe("/s/a.jsonl");
		expect(d.driverSessionId).toBe("sess-1");
		expect(d.driverSessionFile).toBe("/s/a.jsonl");
		expect(d.driverClaimedAt).toBe("2026-01-03T00:00:00.000Z");
		expect(d.issueNumber).toBe(12);
		expect(d.prNumber).toBe(34);
		expect(d.summary).toBe("did the thing");
		expect(d.tokens?.phase.input).toBe(1);
		expect(d.branch).toBe("feat/a");
		const items = ownWorkItems(d);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("question");
	});

	it("pre/post phase kind becomes lifecycle; empty branch is dropped", () => {
		const v2 = legacyPlan({
			slug: "lifecycle",
			schemaVersion: 2,
			phases: [
				legacyPhase({ id: "pre", kind: "pre", branch: "", dependsOn: [] }),
				legacyPhase({ id: "a", dependsOn: [] }),
				legacyPhase({ id: "post", kind: "post", branch: "", dependsOn: [] }),
			],
			followUps: [],
		});
		const out = migratePlan(v2);
		const flat = deliverables(out);
		expect(flat[0]?.lifecycle).toBe("pre");
		expect(flat[0]?.branch).toBeUndefined();
		expect(flat[1]?.lifecycle).toBeUndefined();
		expect(flat[1]?.branch).toBe("feat/a");
		expect(flat[2]?.lifecycle).toBe("post");
	});

	it("is idempotent: migrating twice equals migrating once", () => {
		const v1 = legacyPlan({
			phases: [
				legacyPhase({ id: "a", status: "in-review" }),
				legacyPhase({ id: "b", branch: "feat/b" }),
			],
			followUps: [{ ...legacyTask, id: "fu", kind: "followUp" }],
		});
		const once = migratePlan(v1);
		const twice = migratePlan(once);
		expect(twice).toEqual(once);
	});

	it("normalises a hand-edited v3 plan whose nodes dropped the discriminant", () => {
		const handEdited = {
			slug: "hand-edit",
			title: "Hand edit",
			repo: { path: "/r" },
			schemaVersion: 3,
			nodes: [
				{
					id: "a",
					title: "A",
					body: "",
					status: "planned",
					branch: "feat/a",
					children: [
						{
							id: "t",
							title: "t",
							body: "",
							done: false,
							createdAt: "x",
							updatedAt: "x",
						},
					],
					createdAt: "x",
					updatedAt: "x",
				},
			],
			createdAt: "x",
			updatedAt: "x",
		} as unknown as Plan;
		const out = migratePlan(handEdited);
		expect(out.nodes[0]?.type).toBe("deliverable");
		const d = out.nodes[0];
		if (!d || d.type !== "deliverable") throw new Error("not a deliverable");
		expect(d.children[0]?.type).toBe("work-item");
	});
});

describe("schema write guard (SchemaTooNewError)", () => {
	it("savePlan refuses a plan with a newer schemaVersion", () => {
		const plan = makePlan({ schemaVersion: 4 });
		expect(() => savePlan(plan)).toThrow(SchemaTooNewError);
	});

	it("withPlanLock refuses to mutate a newer-schema file on disk", async () => {
		const plan = makePlan({ slug: "too-new", schemaVersion: 3 });
		savePlan(plan);
		// Hand-bump the on-disk version past what this code understands.
		const file = join(tmp, "too-new", "plan.json");
		const raw = JSON.parse(readFileSync(file, "utf8"));
		raw.schemaVersion = 99;
		writeFileSync(file, JSON.stringify(raw), "utf8");
		await expect(
			withPlanLock("too-new", () => {
				throw new Error("mutator must not run");
			}),
		).rejects.toBeInstanceOf(SchemaTooNewError);
	});
});

describe("rebuildIndex migrates before inspecting", () => {
	it("indexes a v2 file (phases array) with the right active flag", () => {
		const v2 = {
			slug: "v2-on-disk",
			title: "V2",
			repo: { path: "/r2" },
			schemaVersion: 2,
			phases: [
				{
					id: "a",
					title: "A",
					goal: "",
					status: "shipped",
					branch: "feat/a",
					dependsOn: [],
					tasks: [],
					createdAt: "x",
					updatedAt: "x",
				},
			],
			followUps: [],
			createdAt: "x",
			updatedAt: "2026-01-05T00:00:00.000Z",
		};
		mkdirSync(join(tmp, "v2-on-disk"), { recursive: true });
		writeFileSync(
			join(tmp, "v2-on-disk", "plan.json"),
			JSON.stringify(v2),
			"utf8",
		);
		rebuildIndex();
		const entry = listPlans().find((p) => p.slug === "v2-on-disk");
		expect(entry).toBeDefined();
		// Single shipped phase \u2192 not active.
		expect(entry?.active).toBe(false);
	});

	it("indexes a v3 file with nested deliverables", () => {
		const plan = makePlan({
			slug: "v3-on-disk",
			schemaVersion: 3,
			nodes: [
				{
					type: "deliverable" as const,
					id: "group",
					title: "Group",
					body: "",
					status: "planned",
					children: [
						{
							type: "deliverable" as const,
							id: "child",
							title: "Child",
							body: "",
							status: "active",
							branch: "feat/child",
							children: [],
							createdAt: "x",
							updatedAt: "x",
						},
					],
					createdAt: "x",
					updatedAt: "x",
				},
			],
		});
		savePlan(plan);
		const entry = listPlans().find((p) => p.slug === "v3-on-disk");
		expect(entry?.active).toBe(true);
	});
});

describe("effectiveDependsOn", () => {
	it("returns stored dependsOn when present", () => {
		const plan = makePlan({
			nodes: [
				makePhase({ id: "a", branch: "feat/a" }),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(effectiveDependsOn(plan, deliverables(plan)[1])).toEqual(["a"]);
	});

	it("falls back to nearest non-abandoned predecessor when dependsOn unset", () => {
		const plan = makePlan({
			nodes: [
				makePhase({ id: "a", branch: "feat/a", status: "shipped" }),
				makePhase({ id: "b", branch: "feat/b", status: "abandoned" }),
				makePhase({ id: "c", branch: "feat/c", status: "planned" }),
			],
		});
		expect(effectiveDependsOn(plan, deliverables(plan)[2])).toEqual(["a"]);
	});

	it("returns [] for first phase", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "a", branch: "feat/a" })],
		});
		expect(effectiveDependsOn(plan, deliverables(plan)[0])).toEqual([]);
	});
});

describe("effectiveWorkItemKind", () => {
	it("defaults to deliverable when kind absent", () => {
		expect(effectiveWorkItemKind({})).toBe("task");
	});

	it("returns explicit kind", () => {
		expect(effectiveWorkItemKind({ kind: "followup" })).toBe("followup");
		expect(effectiveWorkItemKind({ kind: "manual" })).toBe("manual");
	});
});

describe("isDeliverableReady / readyDeliverables", () => {
	it("first phase with no parent is ready when planned", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "a", branch: "feat/a", dependsOn: [] })],
		});
		expect(isDeliverableReady(plan, deliverables(plan)[0])).toBe(true);
		expect(readyDeliverables(plan).map((p) => p.id)).toEqual(["a"]);
	});

	it("non-planned phases are never ready", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({
					type: "deliverable" as const,
					id: "b",
					branch: "feat/b",
					dependsOn: [],
					status: "shipped",
				}),
			],
		});
		expect(readyDeliverables(plan)).toEqual([]);
	});

	it("chain: only head is ready when middle is planned", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
				makePhase({ id: "c", branch: "feat/c", dependsOn: ["b"] }),
			],
		});
		expect(readyDeliverables(plan).map((p) => p.id)).toEqual(["b"]);
	});

	it("forest: roots of two independent chains are both ready", () => {
		const plan = makePlan({
			nodes: [
				makePhase({ id: "a1", branch: "feat/a1", dependsOn: [] }),
				makePhase({ id: "a2", branch: "feat/a2", dependsOn: ["a1"] }),
				makePhase({ id: "b1", branch: "feat/b1", dependsOn: [] }),
				makePhase({ id: "b2", branch: "feat/b2", dependsOn: ["b1"] }),
			],
		});
		expect(readyDeliverables(plan).map((p) => p.id)).toEqual(["a1", "b1"]);
	});

	it("abandoned parent blocks dependent (does not silently fall back)", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "abandoned",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(isDeliverableReady(plan, deliverables(plan)[1])).toBe(false);
		expect(readyDeliverables(plan)).toEqual([]);
	});

	it("unknown parent blocks the dependent", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "b", branch: "feat/b", dependsOn: ["missing"] })],
		});
		expect(isDeliverableReady(plan, deliverables(plan)[0])).toBe(false);
	});

	it.each([
		["active"],
		["in-review"],
		["ready-to-ship"],
		["needs-attention"],
		["shipped"],
	] as const)("successor is ready when parent is %s (stacked PR / shipped)", (parentStatus) => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: parentStatus,
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(isDeliverableReady(plan, deliverables(plan)[1])).toBe(true);
	});

	it("successor is NOT ready when parent is still planned", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "planned",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(isDeliverableReady(plan, deliverables(plan)[1])).toBe(false);
	});

	it("v1 plan (dependsOn unset) falls back to array-order parent", () => {
		const plan = makePlan({
			nodes: [
				makePhase({ id: "a", branch: "feat/a", status: "shipped" }),
				makePhase({ id: "b", branch: "feat/b" }),
			],
		});
		expect(readyDeliverables(plan).map((p) => p.id)).toEqual(["b"]);
	});
});

describe("chainHead", () => {
	it("returns null when phase has no successors", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "a", branch: "feat/a", dependsOn: [] })],
		});
		expect(chainHead(plan, deliverables(plan)[0])).toBeNull();
	});

	it("returns immediate planned successor", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(chainHead(plan, deliverables(plan)[0])?.id).toBe("b");
	});

	it("skips shipped descendants and returns first non-shipped", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					type: "deliverable" as const,
					id: "b",
					branch: "feat/b",
					dependsOn: ["a"],
					status: "shipped",
				}),
				makePhase({ id: "c", branch: "feat/c", dependsOn: ["b"] }),
				makePhase({ id: "d", branch: "feat/d", dependsOn: ["c"] }),
			],
		});
		expect(chainHead(plan, deliverables(plan)[0])?.id).toBe("c");
	});

	it("returns null when every descendant is shipped", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					type: "deliverable" as const,
					id: "b",
					branch: "feat/b",
					dependsOn: ["a"],
					status: "shipped",
				}),
			],
		});
		expect(chainHead(plan, deliverables(plan)[0])).toBeNull();
	});

	it("on a fork picks the first child by array order", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
				makePhase({ id: "c", branch: "feat/c", dependsOn: ["a"] }),
			],
		});
		expect(chainHead(plan, deliverables(plan)[0])?.id).toBe("b");
	});

	it("is bounded against external on-disk cycles (no infinite loop)", () => {
		// dependsOn cycle b↔c. Plan-tools rejects this at write time;
		// chainHead must not infinite-loop when a hand-edited plan slips
		// one through.
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "shipped",
				}),
				makePhase({
					type: "deliverable" as const,
					id: "b",
					branch: "feat/b",
					dependsOn: ["c"],
					status: "shipped",
				}),
				makePhase({
					type: "deliverable" as const,
					id: "c",
					branch: "feat/c",
					dependsOn: ["b"],
					status: "shipped",
				}),
			],
		});
		expect(() => chainHead(plan, deliverables(plan)[0])).not.toThrow();
	});
});

describe("blockedReason", () => {
	it("returns null when phase is ready", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "a", branch: "feat/a", dependsOn: [] })],
		});
		expect(blockedReason(plan, deliverables(plan)[0])).toBeNull();
	});

	it("flags non-planned phase", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
			],
		});
		expect(blockedReason(plan, deliverables(plan)[0])).toContain("in-review");
	});

	it("returns null when parent is in-flight (stacked PR is allowed)", () => {
		// Option B: in-flight parents (active / in-review / ready-to-ship /
		// needs-attention) don't block the successor. Stacked PRs fork off
		// the parent's branch via pickBaseBranch.
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "in-review",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(blockedReason(plan, deliverables(plan)[1])).toBeNull();
	});

	it("surfaces parent's status when waiting on a not-yet-started parent", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "planned",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(blockedReason(plan, deliverables(plan)[1])).toBe(
			"waiting on `a` (planned)",
		);
	});

	it("explains abandoned parent", () => {
		const plan = makePlan({
			nodes: [
				makePhase({
					type: "deliverable" as const,
					id: "a",
					branch: "feat/a",
					dependsOn: [],
					status: "abandoned",
				}),
				makePhase({ id: "b", branch: "feat/b", dependsOn: ["a"] }),
			],
		});
		expect(blockedReason(plan, deliverables(plan)[1])).toContain("abandoned");
		expect(blockedReason(plan, deliverables(plan)[1])).toContain("dependsOn");
	});

	it("flags unknown parent", () => {
		const plan = makePlan({
			nodes: [makePhase({ id: "b", branch: "feat/b", dependsOn: ["missing"] })],
		});
		expect(blockedReason(plan, deliverables(plan)[0])).toContain("missing");
	});
});

describe("withPlanLock", () => {
	it("loads, mutates, and persists the plan in a single locked sequence", async () => {
		const plan = makePlan({ slug: "lock-1", nodes: [] });
		savePlan(plan);

		const result = await withPlanLock("lock-1", (p) => {
			p.title = "Renamed";
			p.updatedAt = "2026-06-01T00:00:00.000Z";
			return "ok" as const;
		});

		expect(result).toBe("ok");
		const reloaded = loadPlan("lock-1");
		expect(reloaded?.title).toBe("Renamed");
		expect(reloaded?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
	});

	it("throws PlanNotFoundError when the slug doesn't resolve", async () => {
		await expect(
			withPlanLock("does-not-exist", () => "noop"),
		).rejects.toBeInstanceOf(PlanNotFoundError);
	});

	it("does not leak an empty placeholder file when load fails", async () => {
		// withPlanLock touches an empty plan.json so proper-lockfile has
		// something to lock; on the failure path that placeholder must be
		// cleaned up so plansRoot doesn't fill with empty plan dirs.
		await expect(
			withPlanLock("missing-plan", () => "noop"),
		).rejects.toBeInstanceOf(PlanNotFoundError);
		expect(existsSync(join(tmp, "missing-plan", "plan.json"))).toBe(false);
	});

	it("releases the lock when the mutator throws", async () => {
		savePlan(makePlan({ slug: "lock-2" }));

		await expect(
			withPlanLock("lock-2", () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// If the lock leaked, this second call would hang waiting on it.
		// The retry budget is bounded so a leak surfaces as a thrown
		// "Lock file is already being held" — either way the test would
		// fail. A clean release lets the second call complete promptly.
		const result = await withPlanLock("lock-2", (p) => {
			p.title = "After throw";
			p.updatedAt = "2026-06-01T00:00:00.000Z";
			return p.title;
		});
		expect(result).toBe("After throw");
	});

	it("supports async mutators", async () => {
		savePlan(makePlan({ slug: "lock-3" }));

		const result = await withPlanLock("lock-3", async (p) => {
			await new Promise((r) => setTimeout(r, 5));
			p.title = "Async edit";
			p.updatedAt = "2026-06-01T00:00:00.000Z";
			return p.title;
		});

		expect(result).toBe("Async edit");
		expect(loadPlan("lock-3")?.title).toBe("Async edit");
	});

	it("skips the save when the mutator returns { save: false }", async () => {
		savePlan(makePlan({ slug: "lock-4", title: "Original" }));

		const result = await withPlanLock("lock-4", (p) => {
			p.title = "Should not persist";
			return { result: 42, save: false } as const;
		});

		expect(result).toBe(42);
		expect(loadPlan("lock-4")?.title).toBe("Original");
	});

	it("serialises concurrent withPlanLock calls on the same slug", async () => {
		savePlan(makePlan({ slug: "lock-5", nodes: [] }));

		const order: string[] = [];
		const a = withPlanLock("lock-5", async (p) => {
			order.push("a-start");
			await new Promise((r) => setTimeout(r, 30));
			p.title = "A";
			p.updatedAt = "2026-06-01T00:00:01.000Z";
			order.push("a-end");
			return "a";
		});
		// Slight delay so a's lock is reliably acquired first.
		await new Promise((r) => setTimeout(r, 5));
		const b = withPlanLock("lock-5", async (p) => {
			order.push("b-start");
			p.title = `${p.title}-B`;
			p.updatedAt = "2026-06-01T00:00:02.000Z";
			order.push("b-end");
			return "b";
		});

		await Promise.all([a, b]);
		// b must observe a's write (no interleaving).
		expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
		expect(loadPlan("lock-5")?.title).toBe("A-B");
	});
});

describe("assertPlanUnchanged", () => {
	it("returns silently when updatedAt matches", () => {
		const plan = makePlan({
			slug: "cas",
			updatedAt: "2026-06-01T00:00:00.000Z",
		});
		expect(() =>
			assertPlanUnchanged(plan, "2026-06-01T00:00:00.000Z"),
		).not.toThrow();
	});

	it("throws PlanStaleError when updatedAt diverges", () => {
		const plan = makePlan({
			slug: "cas",
			updatedAt: "2026-06-01T00:00:01.000Z",
		});
		try {
			assertPlanUnchanged(plan, "2026-06-01T00:00:00.000Z");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(PlanStaleError);
			const stale = err as PlanStaleError;
			expect(stale.slug).toBe("cas");
			expect(stale.expected).toBe("2026-06-01T00:00:00.000Z");
			expect(stale.actual).toBe("2026-06-01T00:00:01.000Z");
		}
	});
});

describe("savePlan locking", () => {
	it("doesn't tear when called concurrently from multiple async writers", async () => {
		// Sanity: many parallel saves all complete and the final read is
		// valid JSON. Lock prevents two writers stomping the file
		// mid-write. We don't assert which write wins — just that the
		// outcome is parseable and reflects exactly one of them.
		savePlan(makePlan({ slug: "race", nodes: [] }));

		const writes = Array.from({ length: 20 }, (_, i) =>
			Promise.resolve().then(() => {
				const p = loadPlan("race");
				if (!p) throw new Error("plan missing");
				p.title = `T-${i}`;
				p.updatedAt = `2026-06-01T00:00:${String(i).padStart(2, "0")}.000Z`;
				savePlan(p);
			}),
		);
		await Promise.all(writes);

		const final = loadPlan("race");
		expect(final).not.toBeNull();
		expect(final?.title).toMatch(/^T-\d+$/);
	});
});
