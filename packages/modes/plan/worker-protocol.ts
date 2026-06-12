/**
 * Worker protocol — Pattern X (orchestrator + worker subagents).
 *
 * A worker is a `pi` subagent process spawned by the FleetManager with
 * `PI_PLAN_WORKER=1` and `PI_PLAN_WORKER_CHAIN_ID=<chainId>` set in
 * its environment. The worker loads the `modes` extension and runs
 * `/implement <chainHead>`.
 *
 * ## Event derivation (current implementation)
 *
 * Lifecycle events are derived **on the orchestrator side** by the
 * `WorkerMailbox`, which diffs `plan.json` snapshots on every
 * `agent_end` (see `diffWorkerEvents`). The worker process itself
 * does not emit `notify(...)` calls with `kind: "worker-event"`; the
 * notify tool isn't even loaded into the worker's tool surface.
 *
 * The encode/decode helpers below are kept as a dormant API: if a
 * future revision wants worker-side emission (e.g. for events that
 * can't be derived from plan-status diffs, like agent-internal
 * blocks), the wire format is already defined. Until then, the
 * orchestrator-side diff is the source of truth.
 *
 * ## Event coverage today
 *
 * `diffWorkerEvents` produces `phase-started`, `phase-shipped`, and
 * `chain-complete`. `phase-error` is synthesised by `FleetManager`
 * on spawn failure. `phase-blocked` is currently unused; the
 * orchestrator handles it as a defensive branch should worker-side
 * emission land later.
 */

/**
 * Discriminated union of all events a worker emits. The orchestrator
 * is the only consumer; ergonomics for the orchestrator dominate.
 */
export type WorkerNotification =
	| { kind: "phase-started"; phaseId: string; branch: string }
	| { kind: "phase-shipped"; phaseId: string; prNumber?: number }
	| { kind: "phase-blocked"; phaseId: string; reason: string }
	| { kind: "phase-error"; phaseId: string; error: string }
	| {
			/** New question work-items landed on a deliverable (pre-publish
			 *  review surfaced findings). Derived from question-id set diffs. */
			kind: "findings-surfaced";
			phaseId: string;
			questionIds: string[];
	  }
	| { kind: "chain-complete"; chainId: string };

/** Marker `kind` value used on the wire (in the notify tool call). */
const WORKER_EVENT_KIND = "worker-event";

/** Env var that flags a pi process as a worker subagent. */
export const WORKER_ENV_FLAG = "PI_PLAN_WORKER";

/** Env var carrying the chain id the worker was spawned for. */
export const WORKER_CHAIN_ENV = "PI_PLAN_WORKER_CHAIN_ID";

/** True when the current process was spawned as a fleet worker. */
export function isWorker(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[WORKER_ENV_FLAG] === "1";
}

/**
 * Encode a worker event for the wire. Returns the `text` and `kind`
 * args the worker should pass to `notify(...)`. The orchestrator
 * recognises the `kind` and JSON.parses the text.
 */
export function encodeWorkerEvent(event: WorkerNotification): {
	text: string;
	kind: string;
} {
	return {
		text: JSON.stringify(event),
		kind: WORKER_EVENT_KIND,
	};
}

/**
 * Try to parse a worker event off the wire. Returns null if the
 * arguments don't carry a recognised event (so callers can fall
 * through to the explore-mailbox notify path or ignore).
 */
export function decodeWorkerEvent(args: {
	text?: unknown;
	kind?: unknown;
}): WorkerNotification | null {
	if (args.kind !== WORKER_EVENT_KIND) return null;
	if (typeof args.text !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(args.text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	const kind = obj.kind;
	switch (kind) {
		case "phase-started":
			if (typeof obj.phaseId === "string" && typeof obj.branch === "string") {
				return { kind, phaseId: obj.phaseId, branch: obj.branch };
			}
			return null;
		case "phase-shipped":
			if (typeof obj.phaseId === "string") {
				const evt: WorkerNotification = { kind, phaseId: obj.phaseId };
				if (typeof obj.prNumber === "number") evt.prNumber = obj.prNumber;
				return evt;
			}
			return null;
		case "phase-blocked":
			if (typeof obj.phaseId === "string" && typeof obj.reason === "string") {
				return { kind, phaseId: obj.phaseId, reason: obj.reason };
			}
			return null;
		case "phase-error":
			if (typeof obj.phaseId === "string" && typeof obj.error === "string") {
				return { kind, phaseId: obj.phaseId, error: obj.error };
			}
			return null;
		case "findings-surfaced":
			if (
				typeof obj.phaseId === "string" &&
				Array.isArray(obj.questionIds) &&
				obj.questionIds.every((id) => typeof id === "string")
			) {
				return {
					kind,
					phaseId: obj.phaseId,
					questionIds: obj.questionIds as string[],
				};
			}
			return null;
		case "chain-complete":
			if (typeof obj.chainId === "string") {
				return { kind, chainId: obj.chainId };
			}
			return null;
		default:
			return null;
	}
}
