/**
 * Pre-publish review loop: fix-apply rounds, oscillation guard,
 * soft-skip on reviewer absence, and surfacing findings as id-stable
 * question work-items. Plus the findings-surfaced event derivation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DelegateTarget } from "@vegardx/pi-extensions-shared/delegate-registry.js";
import type { OrchestratedFinding } from "pi-ext-review/findings";
import type { Deliverable, Plan } from "../plan/schema.js";
import { deliverables, ownWorkItems } from "../plan/schema.js";
import { _setPlansRootForTests, loadPlan, savePlan } from "../plan/storage.js";
import { diffWorkerEvents } from "../plan/worker-mailbox.js";
import {
	appendSurfacedQuestions,
	buildWorkerFixPrompt,
	runPrePublishReview,
} from "../plan/worker-review.js";

const ctx = { cwd: "/tmp" } as ExtensionContext;

function finding(over?: Partial<OrchestratedFinding>): OrchestratedFinding {
	return {
		severity: "IMPORTANT",
		file: "a.ts",
		line: 3,
		title: "an issue",
		description: "why",
		confidence: "high",
		confirmedByTiers: [],
		confirmedByRoles: ["code-review"],
		staticToolSource: null,
		...over,
	};
}

function reviewerStub(
	rounds: Array<{
		autoApplied?: OrchestratedFinding[];
		surfaced?: OrchestratedFinding[];
		ran?: boolean;
	}>,
): { target: DelegateTarget; calls: number[] } {
	let call = 0;
	const calls: number[] = [];
	const target: DelegateTarget = {
		name: "reviewer",
		description: "stub",
		execute: async () => {
			const round = rounds[Math.min(call, rounds.length - 1)];
			call++;
			calls.push(call);
			return {
				text: "summary",
				details: {
					ran: round?.ran ?? true,
					autoApplied: round?.autoApplied ?? [],
					surfaced: round?.surfaced ?? [],
				},
			};
		},
	};
	return { target, calls };
}

describe("runPrePublishReview", () => {
	const base = { deliverable: { id: "d1", branch: "feat/d1" }, ctx };

	it("applies high-confidence fixes, re-reviews, publishes with the rest", async () => {
		const fix = finding({ suggestedAction: "do x" });
		const leftover = finding({ title: "needs human", confidence: "medium" });
		const { target, calls } = reviewerStub([
			{ autoApplied: [fix], surfaced: [leftover] },
			{ autoApplied: [], surfaced: [leftover] },
		]);
		const applied: string[] = [];
		const result = await runPrePublishReview({
			...base,
			getReviewer: () => target,
			applyFix: async (prompt) => {
				applied.push(prompt);
			},
		});
		expect(result.ran).toBe(true);
		expect(result.rounds).toBe(2);
		expect(calls).toHaveLength(2);
		expect(applied).toHaveLength(1);
		expect(applied[0]).toContain("an issue");
		expect(applied[0]).toContain("commit");
		expect(result.applied.map((f) => f.title)).toEqual(["an issue"]);
		expect(result.surfaced.map((f) => f.title)).toEqual(["needs human"]);
	});

	it("caps at maxRounds even when fixes keep coming", async () => {
		const mk = (n: number) =>
			finding({ title: `fix-${n}`, suggestedAction: "x" });
		const { target, calls } = reviewerStub([
			{ autoApplied: [mk(1)], surfaced: [finding({ title: "s1" })] },
			{ autoApplied: [mk(2)], surfaced: [finding({ title: "s2" })] },
			{ autoApplied: [mk(3)], surfaced: [finding({ title: "s3" })] },
		]);
		const result = await runPrePublishReview({
			...base,
			maxRounds: 2,
			getReviewer: () => target,
			applyFix: async () => {},
		});
		expect(calls).toHaveLength(2);
		expect(result.rounds).toBe(2);
		// Round 2's fixes were applied but not re-reviewed — accepted.
		expect(result.applied.map((f) => f.title)).toEqual(["fix-1", "fix-2"]);
	});

	it("oscillation guard: identical fix + unchanged surfaced set stops the loop", async () => {
		const sameFix = finding({ title: "flappy", suggestedAction: "toggle" });
		const sameSurfaced = finding({ title: "stuck" });
		const { target, calls } = reviewerStub([
			{ autoApplied: [sameFix], surfaced: [sameSurfaced] },
			// Round 2 reports the SAME fix again (it didn't stick).
			{ autoApplied: [sameFix], surfaced: [sameSurfaced] },
			{ autoApplied: [sameFix], surfaced: [sameSurfaced] },
		]);
		const applied: string[] = [];
		const result = await runPrePublishReview({
			...base,
			maxRounds: 5,
			getReviewer: () => target,
			applyFix: async (p) => {
				applied.push(p);
			},
		});
		// Applied once; round 2 saw the identical fix already applied and
		// stopped instead of ping-ponging.
		expect(applied).toHaveLength(1);
		expect(calls.length).toBeLessThanOrEqual(2);
		expect(result.ran).toBe(true);
	});

	it("reviewer absent → soft-skip, never throws", async () => {
		const warnings: string[] = [];
		const result = await runPrePublishReview({
			...base,
			getReviewer: () => undefined,
			applyFix: async () => {
				throw new Error("must not be called");
			},
			notify: (m) => {
				warnings.push(m);
			},
		});
		expect(result.ran).toBe(false);
		expect(result.skipReason).toBe("reviewer-absent");
		expect(warnings[0]).toContain("skipped");
	});

	it("review failure → publishes without blocking", async () => {
		const { target } = reviewerStub([{ ran: false }]);
		const result = await runPrePublishReview({
			...base,
			getReviewer: () => target,
			applyFix: async () => {},
		});
		expect(result.skipReason).toBe("review-failed");
	});
});

describe("appendSurfacedQuestions", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "modes-wr-test-"));
		_setPlansRootForTests(tmp);
		const now = new Date().toISOString();
		const plan: Plan = {
			slug: "wr-plan",
			title: "WR",
			repo: { path: "/tmp" },
			schemaVersion: 3,
			nodes: [
				{
					type: "deliverable",
					id: "d1",
					title: "D1",
					body: "",
					status: "in-review",
					branch: "feat/d1",
					children: [],
					createdAt: now,
					updatedAt: now,
				} as Deliverable,
			],
			createdAt: now,
			updatedAt: now,
		};
		savePlan(plan);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("appends question items once — re-running adds no duplicates", async () => {
		const findings = [finding(), finding({ title: "second", line: 9 })];
		const ids1 = await appendSurfacedQuestions("wr-plan", "d1", findings);
		const ids2 = await appendSurfacedQuestions("wr-plan", "d1", findings);
		expect(ids1).toEqual(ids2);
		const plan = loadPlan("wr-plan") as Plan;
		const d = deliverables(plan)[0];
		const items = d ? ownWorkItems(d) : [];
		expect(items).toHaveLength(2);
		expect(items[0]?.kind).toBe("question");
		expect(items[0]?.title).toContain("[review]");
		expect(items[0]?.body).toContain("a.ts:3");
	});

	it("unknown deliverable is a no-op", async () => {
		const ids = await appendSurfacedQuestions("wr-plan", "nope", [finding()]);
		expect(ids).toEqual([]);
	});
});

describe("diffWorkerEvents — findings-surfaced", () => {
	it("emits when new question ids appear on a deliverable", () => {
		const now = new Date().toISOString();
		const after = {
			slug: "s",
			title: "t",
			repo: { path: "/r" },
			schemaVersion: 3,
			nodes: [
				{
					type: "deliverable",
					id: "d1",
					title: "D1",
					body: "",
					status: "in-review",
					branch: "feat/d1",
					children: [
						{
							type: "work-item",
							id: "q-new",
							title: "q",
							body: "",
							done: false,
							kind: "question",
							createdAt: now,
							updatedAt: now,
						},
					],
					createdAt: now,
					updatedAt: now,
				},
			],
			createdAt: now,
			updatedAt: now,
		} as Plan;
		const events = diffWorkerEvents({ d1: "in-review" }, after, "chain", "d1", {
			d1: [],
		});
		expect(events).toContainEqual({
			kind: "findings-surfaced",
			phaseId: "d1",
			questionIds: ["q-new"],
		});
		// Without a prior question snapshot the event is not derived.
		const none = diffWorkerEvents({ d1: "in-review" }, after, "chain", "d1");
		expect(none.find((e) => e.kind === "findings-surfaced")).toBeUndefined();
	});
});

describe("buildWorkerFixPrompt", () => {
	it("lists findings with locations and asks for a commit", () => {
		const prompt = buildWorkerFixPrompt([
			finding({ suggestedAction: "guard the null" }),
		]);
		expect(prompt).toContain("[pre-publish review]");
		expect(prompt).toContain("`a.ts:3`");
		expect(prompt).toContain("guard the null");
		expect(prompt).toContain("commit");
	});
});
