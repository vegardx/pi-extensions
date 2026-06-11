/**
 * Phase-driver claim primitive.
 *
 * Each phase carries an optional `driverSessionId` recording the pi
 * session that's currently implementing it. A second session trying
 * to `/implement` the same phase is refused unless:
 *   - the recorded driver is "stale" (its session file's mtime is
 *     older than `STALE_TTL_MS`, or the file is missing — the
 *     session has crashed or been abandoned), or
 *   - the caller passes the takeover override.
 *
 * Liveness is checked against the session file mtime rather than
 * polling pi. The session manager touches the JSONL on every
 * appended entry (~every tool call), so a session that's actively
 * working updates its mtime well within the TTL. A session that's
 * been quiet for >30 minutes is treated as gone — long enough to
 * cover a coffee break and an LLM call, short enough that a crashed
 * worker doesn't block its peers all day.
 */

import { existsSync, statSync } from "node:fs";
import type { Deliverable } from "./schema.js";

/**
 * Time after a session file's mtime stops updating before its
 * driver claim is considered stale and may be silently broken by
 * another session adopting the phase.
 */
export const STALE_DRIVER_TTL_MS = 30 * 60 * 1000;

/** Outcome of a claim adoption attempt. */
export type ClaimDecision =
	| { kind: "available" }
	| { kind: "self"; sessionId: string }
	| {
			kind: "stale";
			sessionId: string;
			reason: "missing-session-file" | "session-quiet";
	  }
	| {
			kind: "occupied";
			sessionId: string;
			sessionFile?: string;
			ageMs: number;
	  };

/**
 * Decide whether `selfSessionId` may adopt `phase` as its driver.
 *
 * - `available`: phase has no recorded driver. Caller may claim.
 * - `self`: phase is already claimed by this session. No action
 *   needed; safe to proceed.
 * - `stale`: phase is claimed by another session whose session file
 *   is missing or older than `STALE_DRIVER_TTL_MS`. Caller may
 *   silently break the lock and adopt.
 * - `occupied`: phase is claimed by a live other session. Caller
 *   must refuse without an explicit takeover override.
 */
export function evaluateClaim(
	phase: Deliverable,
	selfSessionId: string | undefined,
	now = Date.now(),
): ClaimDecision {
	const recorded = phase.driverSessionId;
	if (!recorded) return { kind: "available" };
	if (selfSessionId && recorded === selfSessionId) {
		return { kind: "self", sessionId: recorded };
	}
	const sessionFile = phase.driverSessionFile;
	if (!sessionFile || !existsSync(sessionFile)) {
		return {
			kind: "stale",
			sessionId: recorded,
			reason: "missing-session-file",
		};
	}
	let ageMs: number;
	try {
		const stat = statSync(sessionFile);
		// Clamp to 0: a session file's mtime can be slightly in the future
		// due to clock skew or FS timestamp granularity. A negative age
		// otherwise propagates into user-facing strings like "active -1m
		// ago".
		ageMs = Math.max(0, now - stat.mtimeMs);
	} catch {
		return {
			kind: "stale",
			sessionId: recorded,
			reason: "missing-session-file",
		};
	}
	if (ageMs > STALE_DRIVER_TTL_MS) {
		return { kind: "stale", sessionId: recorded, reason: "session-quiet" };
	}
	return {
		kind: "occupied",
		sessionId: recorded,
		sessionFile,
		ageMs,
	};
}

/** Mutates `phase` in place to record `selfSessionId` as the driver. */
export function claimPhase(
	phase: Deliverable,
	selfSessionId: string,
	sessionFile: string | undefined,
	now: string,
): void {
	phase.driverSessionId = selfSessionId;
	if (sessionFile) {
		phase.driverSessionFile = sessionFile;
	} else {
		delete phase.driverSessionFile;
	}
	phase.driverClaimedAt = now;
}

/**
 * Mutates `phase` in place to clear the driver claim. Called when
 * the phase enters a terminal status (`shipped` / `abandoned`) or
 * when the session voluntarily releases the claim (e.g. on an
 * explicit takeover by another session).
 */
export function releasePhase(phase: Deliverable): void {
	delete phase.driverSessionId;
	delete phase.driverSessionFile;
	delete phase.driverClaimedAt;
}
