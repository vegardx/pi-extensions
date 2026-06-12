/**
 * Round-trip tests for the worker wire protocol: every
 * `WorkerNotification` variant that `encodeWorkerEvent` can emit must
 * survive `decodeWorkerEvent`.
 */

import {
	decodeWorkerEvent,
	encodeWorkerEvent,
	type WorkerNotification,
} from "../plan/worker-protocol.js";

describe("worker protocol encode/decode round-trip", () => {
	const cases: WorkerNotification[] = [
		{ kind: "phase-started", phaseId: "d1", branch: "feat/d1" },
		{ kind: "phase-shipped", phaseId: "d1", prNumber: 42 },
		{ kind: "phase-shipped", phaseId: "d1" },
		{ kind: "phase-blocked", phaseId: "d1", reason: "stuck" },
		{ kind: "phase-error", phaseId: "d1", error: "boom" },
		{ kind: "findings-surfaced", phaseId: "d1", questionIds: ["q1", "q2"] },
		{ kind: "chain-complete", chainId: "chain" },
	];

	for (const evt of cases) {
		it(`round-trips ${evt.kind}`, () => {
			expect(decodeWorkerEvent(encodeWorkerEvent(evt))).toEqual(evt);
		});
	}

	it("rejects a findings-surfaced payload with non-string question ids", () => {
		const bad = encodeWorkerEvent({
			kind: "findings-surfaced",
			phaseId: "d1",
			questionIds: [1 as unknown as string],
		});
		expect(decodeWorkerEvent(bad)).toBeNull();
	});

	it("rejects an unrecognised kind", () => {
		const out = decodeWorkerEvent({
			kind: "worker-event",
			text: JSON.stringify({ kind: "nope" }),
		});
		expect(out).toBeNull();
	});
});
