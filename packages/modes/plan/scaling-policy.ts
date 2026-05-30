/**
 * Pure capacity arithmetic shared by the delegate pools (explore child
 * routing, research) and the fleet fan-out. The kernel both call sites
 * reimplemented is "spawn up to a cap, queue the rest" — extracted here
 * so there's one definition with one set of tests.
 *
 * This module is intentionally side-effect-free: no spawning, no I/O.
 * Callers feed it counts and act on the result. `cap === Infinity`
 * means uncapped (every pending item is admitted).
 */

export interface AdmitInput {
	/** Consumers currently running / in-flight. */
	inFlight: number;
	/** Hard cap on concurrent consumers. `Infinity` = uncapped. */
	cap: number;
	/** Number of pending items wanting a consumer. */
	pending: number;
}

export interface AdmitResult {
	/** How many pending items to start now. */
	spawn: number;
	/** How many to leave queued. */
	queue: number;
}

/** Free slots under the cap (never negative). Infinite cap → Infinity. */
export function freeSlots(inFlight: number, cap: number): number {
	// Only a positive Infinity cap means "uncapped". A NaN / -Infinity /
	// non-positive cap is treated as zero capacity, never as uncapped — a
	// bad computed cap must not silently admit all pending work.
	if (cap === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
	if (!Number.isFinite(cap) || cap <= 0) return 0;
	return Math.max(0, cap - inFlight);
}

/** True when at least one more consumer fits under the cap. */
export function hasRoom(inFlight: number, cap: number): boolean {
	return freeSlots(inFlight, cap) > 0;
}

/**
 * Split `pending` into spawn-now vs queue, honouring the cap.
 *
 * - Fleet fan-out: `admit({ inFlight: workers.size, cap: maxParallel,
 *   pending: unclaimedHeads.length })` → start `spawn`, queue the rest.
 * - A delegate pool: same shape with the pool's own cap.
 */
export function admit({ inFlight, cap, pending }: AdmitInput): AdmitResult {
	const free = freeSlots(inFlight, cap);
	const spawn =
		free === Number.POSITIVE_INFINITY ? pending : Math.min(pending, free);
	return { spawn, queue: pending - spawn };
}
