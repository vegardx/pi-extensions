/**
 * Tests for the phase-driver claim primitive: adoption decisions
 * (available / self / stale / occupied), claim/release mutations,
 * and the liveness check based on session file mtime.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claimPhase,
	evaluateClaim,
	releasePhase,
	STALE_DRIVER_TTL_MS,
} from "../plan/driver-claim.js";
import type { Phase } from "../plan/schema.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "modes-driver-claim-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		id: "p-1",
		title: "P",
		goal: "g",
		status: "planned",
		branch: "feat/p-1",
		tasks: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function touchSessionFile(name: string, ageMs: number): string {
	const path = join(tmp, name);
	writeFileSync(path, "");
	const mtime = (Date.now() - ageMs) / 1000;
	utimesSync(path, mtime, mtime);
	return path;
}

describe("evaluateClaim", () => {
	it("returns 'available' when no driver is recorded", () => {
		const phase = makePhase();
		expect(evaluateClaim(phase, "self-1").kind).toBe("available");
	});

	it("returns 'self' when phase is already claimed by the calling session", () => {
		const phase = makePhase({ driverSessionId: "self-1" });
		const decision = evaluateClaim(phase, "self-1");
		expect(decision).toMatchObject({ kind: "self", sessionId: "self-1" });
	});

	it("returns 'occupied' when another session's claim is fresh", () => {
		const sessionFile = touchSessionFile("live.jsonl", 5_000);
		const phase = makePhase({
			driverSessionId: "other",
			driverSessionFile: sessionFile,
		});
		const decision = evaluateClaim(phase, "self-1");
		expect(decision.kind).toBe("occupied");
		if (decision.kind === "occupied") {
			expect(decision.sessionId).toBe("other");
			expect(decision.ageMs).toBeGreaterThanOrEqual(0);
			expect(decision.ageMs).toBeLessThan(STALE_DRIVER_TTL_MS);
		}
	});

	it("returns 'stale' (session-quiet) when the recorded session file's mtime is older than TTL", () => {
		const sessionFile = touchSessionFile(
			"quiet.jsonl",
			STALE_DRIVER_TTL_MS + 60_000,
		);
		const phase = makePhase({
			driverSessionId: "other",
			driverSessionFile: sessionFile,
		});
		const decision = evaluateClaim(phase, "self-1");
		expect(decision).toMatchObject({
			kind: "stale",
			sessionId: "other",
			reason: "session-quiet",
		});
	});

	it("returns 'stale' (missing-session-file) when driverSessionFile is unset", () => {
		const phase = makePhase({ driverSessionId: "other" });
		const decision = evaluateClaim(phase, "self-1");
		expect(decision).toMatchObject({
			kind: "stale",
			sessionId: "other",
			reason: "missing-session-file",
		});
	});

	it("returns 'stale' (missing-session-file) when the recorded path doesn't exist on disk", () => {
		const phase = makePhase({
			driverSessionId: "other",
			driverSessionFile: join(tmp, "ghost.jsonl"),
		});
		const decision = evaluateClaim(phase, "self-1");
		expect(decision).toMatchObject({
			kind: "stale",
			sessionId: "other",
			reason: "missing-session-file",
		});
	});

	it("treats missing self id as 'never matches' — claim is occupied/stale by other id", () => {
		const sessionFile = touchSessionFile("live.jsonl", 5_000);
		const phase = makePhase({
			driverSessionId: "other",
			driverSessionFile: sessionFile,
		});
		const decision = evaluateClaim(phase, undefined);
		expect(decision.kind).toBe("occupied");
	});
});

describe("claimPhase / releasePhase", () => {
	it("claimPhase records driver id, session file, and timestamp", () => {
		const phase = makePhase();
		claimPhase(
			phase,
			"sess-1",
			"/tmp/sess-1.jsonl",
			"2026-06-01T00:00:00.000Z",
		);
		expect(phase.driverSessionId).toBe("sess-1");
		expect(phase.driverSessionFile).toBe("/tmp/sess-1.jsonl");
		expect(phase.driverClaimedAt).toBe("2026-06-01T00:00:00.000Z");
	});

	it("claimPhase clears driverSessionFile when called with undefined", () => {
		const phase = makePhase({
			driverSessionFile: "/tmp/old.jsonl",
		});
		claimPhase(phase, "sess-1", undefined, "2026-06-01T00:00:00.000Z");
		expect(phase.driverSessionId).toBe("sess-1");
		expect(phase.driverSessionFile).toBeUndefined();
	});

	it("releasePhase removes all three driver fields", () => {
		const phase = makePhase({
			driverSessionId: "sess-1",
			driverSessionFile: "/tmp/sess-1.jsonl",
			driverClaimedAt: "2026-06-01T00:00:00.000Z",
		});
		releasePhase(phase);
		expect(phase.driverSessionId).toBeUndefined();
		expect(phase.driverSessionFile).toBeUndefined();
		expect(phase.driverClaimedAt).toBeUndefined();
	});

	it("releasePhase is a no-op on a phase with no claim", () => {
		const phase = makePhase();
		releasePhase(phase);
		expect(phase.driverSessionId).toBeUndefined();
	});
});
