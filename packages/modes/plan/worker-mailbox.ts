/**
 * WorkerMailbox — single-worker wrapper around `SubagentPool` for
 * Pattern X (orchestrator + worker subagents).
 *
 * Each WorkerMailbox owns ONE pi subagent dedicated to one chain.
 * The subagent is spawned with `PI_PLAN_WORKER=1` and
 * `PI_PLAN_WORKER_CHAIN_ID=<id>` set in its env so the modes
 * extension inside that process knows it's a worker (drives
 * non-interactive defaults, see `worker-protocol.ts`).
 *
 * The orchestrator infers progress from two signals:
 *   1. The shared `plan.json` file (lockfile-protected, status
 *      flips visible to anyone who re-reads it). This gives us
 *      `phase-started` / `phase-shipped` / `chain-complete`.
 *   2. The subagent's RPC event stream (`agent_end` when its turn
 *      finishes; tool-execution-start for live progress strings).
 *
 * We deliberately do NOT require the worker to emit notify(...)
 * tool calls for lifecycle events: the plan file is already the
 * source of truth, lock-protected against tearing, and re-reading
 * it on each `agent_end` is cheap. This keeps the worker prompt
 * surface minimal and avoids forking the explore-notify extension.
 *
 * `WorkerNotification`s are computed by diffing the plan state
 * snapshot taken at spawn time against the snapshot taken on each
 * `agent_end`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import {
	type PersistentAgent,
	SubagentPool,
} from "@vegardx/pi-extensions-shared/subagent-pool.js";
import {
	chainHead,
	type Deliverable,
	deliverables,
	effectiveWorkItemKind,
	isWorkItem,
	type Plan,
} from "./schema.js";
import { loadPlan } from "./storage.js";
import {
	WORKER_CHAIN_ENV,
	WORKER_ENV_FLAG,
	type WorkerNotification,
} from "./worker-protocol.js";

// ---- Types ------------------------------------------------------------------

export type WorkerStatus = "starting" | "running" | "ended" | "error";

export interface WorkerState {
	chainId: string;
	status: WorkerStatus;
	/** Phase id the worker was originally pointed at. */
	chainHeadId: string;
	/** Latest event surfaced to subscribers. */
	lastEvent: WorkerNotification | null;
	/** Live progress string from the worker's tool calls. */
	lastToolSummary: string | null;
	/** Error message when status === "error". */
	error: string | null;
}

export interface WorkerOptions {
	chainId: string;
	chainHeadId: string;
	planSlug: string;
	/** Worktree the subagent runs in. */
	cwd: string;
}

export interface WorkerMailboxDeps {
	/**
	 * Spawn the worker subagent. Injected so tests can stub the
	 * underlying `SubagentPool`.
	 */
	spawnAgent(
		ctx: ExtensionContext,
		opts: WorkerOptions,
	): Promise<{ agent: PersistentAgent; dispose: () => Promise<void> }>;
	/**
	 * Read the plan from disk. Injected so tests don't need a real
	 * plans directory.
	 */
	readPlan(slug: string): Plan | null;
}

// ---- Defaults ---------------------------------------------------------------

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

/**
 * Worker subagent runs with the modes extension's full toolset (it
 * needs read/write/bash/git/etc.). The prompt path is the same
 * append-system file the explore agent uses, since modes's main
 * extension defines /implement; the worker doesn't need additional
 * guidance beyond "do whatever /implement tells you".
 *
 * We loosen the tool list to the explicit pi default plus modes' own
 * — the subagent must be able to commit/push/run tests.
 */
const WORKER_TOOLS: readonly string[] = [
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
];
const WORKER_AGENT_PROMPT = join(PROMPTS_DIR, "worker-agent.md");

/**
 * Window in which a follow-up `agent_start` may arrive after
 * `agent_end`. /implement schedules follow-up turns via
 * `triggerTurn: true`; the next turn typically begins within a few
 * tens of milliseconds. 250ms gives ample slack while bounding the
 * "worker is truly done" detection delay.
 */
const AGENT_END_DEFERRAL_MS = 250;

function defaultWorkerDeps(): WorkerMailboxDeps {
	return {
		async spawnAgent(ctx, opts) {
			const resolved = await resolveModel(ctx, {
				name: "modes",
				tier: "normal",
			});
			if (!resolved) {
				throw new Error(
					"no normal-tier model configured — set " +
						"`backgroundModels.primary.normal` (or " +
						"`extensionConfig.modes.model`) in settings.json",
				);
			}
			const pool = new SubagentPool();
			const agent = await pool.spawn(`worker-${opts.chainId}`, {
				provider: resolved.model.provider,
				model: resolved.model.id,
				systemPromptPath: WORKER_AGENT_PROMPT,
				tools: WORKER_TOOLS,
				cwd: opts.cwd,
				followUpMode: "one-at-a-time",
				env: {
					...process.env,
					[WORKER_ENV_FLAG]: "1",
					[WORKER_CHAIN_ENV]: opts.chainId,
					// Workers review their own diff pre-publish: re-enable the
					// review pipeline and the delegate host inside the child
					// (PI_SUBAGENT isolation would otherwise strip both).
					PI_EXT_REVIEW: "on",
					PI_EXT_SUBAGENT: "on",
				} as Record<string, string>,
				extraArgs: [],
			});
			return {
				agent,
				dispose: () => pool.dispose(),
			};
		},
		readPlan(slug) {
			return loadPlan(slug);
		},
	};
}

// ---- Helpers ----------------------------------------------------------------

function summariseToolCall(
	name: string,
	args: Record<string, unknown>,
): string {
	switch (name) {
		case "bash": {
			const cmd = String(args.command ?? "").split("\n")[0];
			return cmd.length > 50 ? `$ ${cmd.slice(0, 50)}\u2026` : `$ ${cmd}`;
		}
		case "edit":
			return `edit ${args.path ?? ""}`;
		case "write":
			return `write ${args.path ?? ""}`;
		case "read":
			return `read ${args.path ?? args.file_path ?? ""}`;
		default:
			return name;
	}
}

/**
 * Snapshot of phase status keyed by phase id. Used to diff plan state
 * across `agent_end` cycles to derive lifecycle events.
 */
type StatusSnapshot = Record<string, Deliverable["status"]>;

function snapshotStatuses(plan: Plan): StatusSnapshot {
	const out: StatusSnapshot = {};
	for (const p of deliverables(plan)) out[p.id] = p.status;
	return out;
}

/**
 * Question work-item ids per deliverable. Diffed across agent_end
 * cycles to derive `findings-surfaced` events (the worker's
 * pre-publish review appends question items to its deliverable).
 */
type QuestionSnapshot = Record<string, string[]>;

function snapshotQuestionIds(plan: Plan): QuestionSnapshot {
	const out: QuestionSnapshot = {};
	for (const p of deliverables(plan)) {
		out[p.id] = p.children
			.filter((n) => isWorkItem(n) && effectiveWorkItemKind(n) === "question")
			.map((n) => n.id);
	}
	return out;
}

/**
 * Derive lifecycle events from a before/after status diff plus the
 * worker's chain head. Returns events in causal order.
 */
export function diffWorkerEvents(
	before: StatusSnapshot,
	after: Plan,
	chainId: string,
	chainHeadId: string,
	beforeQuestions?: QuestionSnapshot,
): WorkerNotification[] {
	const events: WorkerNotification[] = [];
	if (beforeQuestions) {
		const afterQuestions = snapshotQuestionIds(after);
		for (const phase of deliverables(after)) {
			const prev = new Set(beforeQuestions[phase.id] ?? []);
			const fresh = (afterQuestions[phase.id] ?? []).filter(
				(id) => !prev.has(id),
			);
			if (fresh.length > 0) {
				events.push({
					kind: "findings-surfaced",
					phaseId: phase.id,
					questionIds: fresh,
				});
			}
		}
	}
	for (const phase of deliverables(after)) {
		const prev = before[phase.id];
		const curr = phase.status;
		if (prev === curr) continue;
		// active arrival: the worker just claimed and started this phase.
		if (curr === "active" && prev !== "active") {
			events.push({
				kind: "phase-started",
				phaseId: phase.id,
				branch: phase.branch ?? "(unknown)",
			});
		}
		// shipped arrival: the worker finished a phase and pushed a PR.
		// `in-review` is the post-/ship state; `shipped` is the post-merge
		// state. Either signals "this phase is no longer the worker's
		// problem".
		if (
			(curr === "in-review" || curr === "shipped") &&
			prev !== "in-review" &&
			prev !== "shipped"
		) {
			const evt: WorkerNotification = {
				kind: "phase-shipped",
				phaseId: phase.id,
			};
			if (typeof phase.prNumber === "number") evt.prNumber = phase.prNumber;
			events.push(evt);
		}
	}
	// Chain-complete: the chain root is shipped AND no descendant
	// phase remains non-shipped (chainHead returns null). Without the
	// status check we'd false-positive on a head that's still active
	// but happens to have no descendants.
	const head = deliverables(after).find((p) => p.id === chainHeadId);
	if (head && head.status === "shipped" && chainHead(after, head) === null) {
		events.push({ kind: "chain-complete", chainId });
	}
	return events;
}

// ---- Mailbox ----------------------------------------------------------------

export class WorkerMailbox {
	private readonly ctx: ExtensionContext;
	private readonly deps: WorkerMailboxDeps;
	private readonly opts: WorkerOptions;

	private agentDispose: (() => Promise<void>) | null = null;
	private unsubscribe: (() => void) | null = null;

	private state: WorkerState;
	private lastSnapshot: StatusSnapshot = {};
	// `null` until the first plan read establishes a baseline; a `{}`
	// baseline would make the first agent_end spuriously emit
	// findings-surfaced for every pre-existing question item.
	private lastQuestionSnapshot: QuestionSnapshot | null = null;
	private listeners = new Set<(event: WorkerNotification) => void>();
	private endHandlers = new Set<() => void>();
	private disposed = false;
	// Defer firing `onEnd` after `agent_end` so we don't tear down the
	// worker mid-chain when pi schedules a follow-up turn (per-turn
	// `agent_end` is not the worker's terminal). If `agent_start`
	// arrives within the deferral window, the timer is cancelled.
	private pendingEndTimer: NodeJS.Timeout | null = null;

	constructor(
		ctx: ExtensionContext,
		opts: WorkerOptions,
		deps: WorkerMailboxDeps = defaultWorkerDeps(),
	) {
		this.ctx = ctx;
		this.opts = opts;
		this.deps = deps;
		this.state = {
			chainId: opts.chainId,
			status: "starting",
			chainHeadId: opts.chainHeadId,
			lastEvent: null,
			lastToolSummary: null,
			error: null,
		};
	}

	getState(): WorkerState {
		return { ...this.state };
	}

	onEvent(listener: (event: WorkerNotification) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onEnd(handler: () => void): () => void {
		this.endHandlers.add(handler);
		return () => {
			this.endHandlers.delete(handler);
		};
	}

	/**
	 * Spawn the subagent and prompt it with `/implement <chainHeadId>`.
	 * Resolves once the spawn completes; the worker keeps running
	 * after this returns. Subscribers receive lifecycle events
	 * asynchronously.
	 */
	async start(): Promise<void> {
		if (this.disposed) throw new Error("WorkerMailbox is disposed");
		let localDispose: (() => Promise<void>) | null = null;
		try {
			const initialPlan = this.deps.readPlan(this.opts.planSlug);
			if (initialPlan) {
				this.lastSnapshot = snapshotStatuses(initialPlan);
				this.lastQuestionSnapshot = snapshotQuestionIds(initialPlan);
			}
			const { agent, dispose } = await this.deps.spawnAgent(
				this.ctx,
				this.opts,
			);
			localDispose = dispose;
			this.agentDispose = dispose;
			this.unsubscribe = agent.onEvent((event) => this.handleEvent(event));
			this.state.status = "running";
			await agent.prompt(`/implement ${this.opts.chainHeadId}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.state.status = "error";
			this.state.error = msg;
			// If the agent was spawned but a later step (event subscription,
			// initial prompt) threw, dispose the running subagent/pool so we
			// don't leak a process. Wrap in try/catch so the original error
			// keeps propagating even if disposal also fails.
			this.unsubscribe?.();
			this.unsubscribe = null;
			if (localDispose) {
				try {
					await localDispose();
				} catch {
					/* best-effort — surface the original error, not the dispose failure */
				}
				this.agentDispose = null;
			}
			throw err;
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pendingEndTimer) {
			clearTimeout(this.pendingEndTimer);
			this.pendingEndTimer = null;
		}
		this.unsubscribe?.();
		this.unsubscribe = null;
		const dispose = this.agentDispose;
		this.agentDispose = null;
		if (dispose) {
			try {
				await dispose();
			} catch {
				/* best-effort */
			}
		}
	}

	// ---- internals --------------------------------------------------------

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start": {
				// A new turn started — cancel any pending end deferral. The
				// previous `agent_end` was a per-turn boundary, not terminal.
				if (this.pendingEndTimer) {
					clearTimeout(this.pendingEndTimer);
					this.pendingEndTimer = null;
				}
				break;
			}
			case "tool_execution_start": {
				const args = (event.args ?? {}) as Record<string, unknown>;
				this.state.lastToolSummary = summariseToolCall(event.toolName, args);
				break;
			}
			case "agent_end": {
				// Worker's turn finished. Re-read the plan and emit
				// derived events.
				const plan = this.deps.readPlan(this.opts.planSlug);
				let sawChainComplete = false;
				if (plan) {
					const events = diffWorkerEvents(
						this.lastSnapshot,
						plan,
						this.opts.chainId,
						this.opts.chainHeadId,
						this.lastQuestionSnapshot ?? undefined,
					);
					this.lastSnapshot = snapshotStatuses(plan);
					this.lastQuestionSnapshot = snapshotQuestionIds(plan);
					for (const evt of events) {
						this.state.lastEvent = evt;
						if (evt.kind === "chain-complete") sawChainComplete = true;
						for (const l of this.listeners) {
							try {
								l(evt);
							} catch {
								/* best-effort */
							}
						}
					}
				}
				if (sawChainComplete) {
					// Definitive plan-derived terminal: chain root is shipped
					// AND no descendant remains. End immediately.
					this.fireEnd();
					break;
				}
				// pi's `agent_end` is per-turn, not terminal. /implement
				// schedules follow-up turns via `triggerTurn: true`; the
				// next `agent_start` cancels this deferral. If no follow-up
				// arrives within the window, treat the worker as ended.
				if (this.pendingEndTimer) clearTimeout(this.pendingEndTimer);
				this.pendingEndTimer = setTimeout(() => {
					this.pendingEndTimer = null;
					this.fireEnd();
				}, AGENT_END_DEFERRAL_MS);
				// Don't keep the event loop alive on this timer: the
				// orchestrator owns the lifecycle.
				this.pendingEndTimer.unref?.();
				break;
			}
			default:
				break;
		}
	}

	private fireEnd(): void {
		if (this.state.status === "ended") return;
		this.state.status = "ended";
		for (const h of this.endHandlers) {
			try {
				h();
			} catch {
				/* best-effort */
			}
		}
	}
}
