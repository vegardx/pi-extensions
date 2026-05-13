/**
 * Worker protocol — Pattern X (orchestrator + worker subagents).
 *
 * A worker is a `pi` subagent process spawned by the FleetManager with
 * `PI_PLAN_WORKER=1` and `PI_PLAN_WORKER_CHAIN_ID=<chainId>` set in
 * its environment. The worker loads the `modes` extension and runs
 * `/implement <chainHead>`; modes detects the env vars on activation
 * and emits structured `notify(...)` calls at every phase-lifecycle
 * boundary so the orchestrator can render fleet progress and decide
 * when to fan out into newly-unblocked chains.
 *
 * Why a separate protocol: the explore mailbox lifts notify text
 * verbatim, but here we need a discriminated union so the orchestrator
 * can route per-event-kind. We piggy-back on the same `notify` tool —
 * the worker calls it with a JSON-serialised payload in `text` and
 * `kind: "worker-event"`. The orchestrator parses `text` back into a
 * `WorkerNotification`.
 *
 * Design decision: re-using the existing `notify` tool (rather than
 * introducing a second one) avoids forking the explore-notify
 * extension and keeps the worker's tool surface minimal. The
 * `kind: "worker-event"` discriminator stays out of the explore
 * mailbox's interest set, so a single worker pi process could in
 * principle emit both flavours without confusion.
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
	| { kind: "chain-complete"; chainId: string };

/** Marker `kind` value used on the wire (in the notify tool call). */
export const WORKER_EVENT_KIND = "worker-event";

/** Env var that flags a pi process as a worker subagent. */
export const WORKER_ENV_FLAG = "PI_PLAN_WORKER";

/** Env var carrying the chain id the worker was spawned for. */
export const WORKER_CHAIN_ENV = "PI_PLAN_WORKER_CHAIN_ID";

/** True when the current process was spawned as a fleet worker. */
export function isWorker(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[WORKER_ENV_FLAG] === "1";
}

/** The chain id assigned to this worker, if running as one. */
export function workerChainId(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (!isWorker(env)) return null;
	const id = env[WORKER_CHAIN_ENV];
	return id && id.length > 0 ? id : null;
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
		case "chain-complete":
			if (typeof obj.chainId === "string") {
				return { kind, chainId: obj.chainId };
			}
			return null;
		default:
			return null;
	}
}
