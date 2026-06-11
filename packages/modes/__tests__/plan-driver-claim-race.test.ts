/**
 * Concurrency regression for the driver-claim TOCTOU race.
 *
 * `/implement`'s claim path (doImplement in index.ts) wraps
 * evaluate→claim→save in `withPlanLock` so two sessions racing to
 * adopt the same phase can't both win. This exercises that exact
 * composition (`withPlanLock` + `evaluateClaim` + `claimPhase`)
 * against a shared on-disk plan and asserts exactly one claimer
 * succeeds — the second observes the first's committed claim inside
 * the lock and refuses.
 *
 * Before the fix the claim was a bare read→evaluate (outside the
 * lock) followed by a lock-only `savePlan`, so both sessions saw
 * `available`, both claimed, and last-write-wins left two drivers on
 * one phase/branch.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimPhase, evaluateClaim } from "../plan/driver-claim.js";
import type { Deliverable as Phase, Plan } from "../plan/schema.js";
import { deliverables } from "../plan/schema.js";
import {
	_setPlansRootForTests,
	loadPlan,
	savePlan,
	withPlanLock,
} from "../plan/storage.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "modes-claim-race-"));
	_setPlansRootForTests(tmp);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
	const now = new Date().toISOString();
	return {
		slug: "race-plan",
		title: "Race Plan",
		repo: { path: "/tmp/repo-race" },
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
		id: "p-1",
		title: "P",
		body: "g",
		status: "planned",
		branch: "feat/p-1",
		children: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

type ClaimOutcome = { ok: true } | { ok: false; reason: "occupied" };

/**
 * Mirror of doImplement's `claimAtomically`: re-evaluate the claim
 * against fresh on-disk state inside the plan lock, refuse if a live
 * peer holds it, otherwise claim and persist.
 */
async function lockedClaim(
	slug: string,
	phaseId: string,
	selfSessionId: string,
	sessionFile: string,
	takeover = false,
): Promise<ClaimOutcome> {
	return withPlanLock<ClaimOutcome>(slug, (fresh) => {
		const fp = deliverables(fresh).find((p) => p.id === phaseId);
		if (!fp) return { result: { ok: false, reason: "occupied" }, save: false };
		const d = evaluateClaim(fp, selfSessionId);
		if (d.kind === "occupied" && !takeover) {
			return { result: { ok: false, reason: "occupied" }, save: false };
		}
		const now = new Date().toISOString();
		claimPhase(fp, selfSessionId, sessionFile, now);
		fresh.updatedAt = now;
		return { ok: true };
	});
}

describe("driver-claim race", () => {
	it("lets exactly one of two concurrent claimers win", async () => {
		const fileA = join(tmp, "session-a.jsonl");
		const fileB = join(tmp, "session-b.jsonl");
		// Live session files (recent mtime) so a held claim reads as
		// `occupied`, not `stale`.
		writeFileSync(fileA, "");
		writeFileSync(fileB, "");
		savePlan(makePlan({ nodes: [makePhase()] }));

		const [a, b] = await Promise.all([
			lockedClaim("race-plan", "p-1", "session-a", fileA),
			lockedClaim("race-plan", "p-1", "session-b", fileB),
		]);

		const winners = [a, b].filter((r) => r.ok);
		const losers = [a, b].filter((r) => !r.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		expect((losers[0] as { reason: string }).reason).toBe("occupied");

		// The persisted plan records exactly one driver — the winner.
		const persisted = loadPlan("race-plan");
		const driver = persisted
			? deliverables(persisted)[0]?.driverSessionId
			: undefined;
		expect(driver).toBeDefined();
		expect(["session-a", "session-b"]).toContain(driver);
		if (a.ok) {
			expect(driver).toBe("session-a");
		} else {
			expect(driver).toBe("session-b");
		}
	});

	it("re-claim by the same session is idempotent (self)", async () => {
		const fileA = join(tmp, "session-a.jsonl");
		writeFileSync(fileA, "");
		savePlan(makePlan({ nodes: [makePhase()] }));

		const first = await lockedClaim("race-plan", "p-1", "session-a", fileA);
		const second = await lockedClaim("race-plan", "p-1", "session-a", fileA);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		const reloaded = loadPlan("race-plan");
		expect((reloaded ? deliverables(reloaded) : [])[0]?.driverSessionId).toBe(
			"session-a",
		);
	});

	it("takeover overrides a live peer's claim", async () => {
		const fileA = join(tmp, "session-a.jsonl");
		const fileB = join(tmp, "session-b.jsonl");
		writeFileSync(fileA, "");
		writeFileSync(fileB, "");
		savePlan(makePlan({ nodes: [makePhase()] }));

		const held = await lockedClaim("race-plan", "p-1", "session-a", fileA);
		expect(held.ok).toBe(true);

		// Without takeover, b is refused.
		const refused = await lockedClaim("race-plan", "p-1", "session-b", fileB);
		expect(refused.ok).toBe(false);

		// With takeover, b wins and becomes the recorded driver.
		const taken = await lockedClaim(
			"race-plan",
			"p-1",
			"session-b",
			fileB,
			true,
		);
		expect(taken.ok).toBe(true);
		expect(
			(() => {
				const lp = loadPlan("race-plan");
				return lp ? deliverables(lp)[0] : undefined;
			})()?.driverSessionId,
		).toBe("session-b");
	});
});
