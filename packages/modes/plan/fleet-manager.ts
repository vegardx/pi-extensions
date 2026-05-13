/**
 * FleetManager — Pattern X coordinator (orchestrator + worker subagents).
 *
 * Spawns one `WorkerMailbox` per ready chain head, watches each
 * worker's lifecycle, and re-evaluates the plan when a worker exits
 * to fan out into newly-unblocked chains. Caps total parallel
 * workers at `maxParallel` so a 20-chain plan doesn't spawn 20 pi
 * subagents.
 *
 * Concurrency model:
 *   - Each chain has at most one worker. A "chain" is identified by
 *     its root phase id (the topmost ancestor in `dependsOn`). All
 *     descendants of that root share the same chainId.
 *   - The fleet completes when no workers remain AND no ready chain
 *     head exists (either the plan is fully shipped, or every
 *     remaining chain is blocked on a non-shipped peer chain).
 *   - Workers are spawned with the parent process's env extended
 *     to set `PI_PLAN_WORKER=1` and `PI_PLAN_WORKER_CHAIN_ID=<id>`.
 *
 * The fleet manager is intentionally pure orchestration: it calls
 * the same plan storage primitives as the rest of modes (lockfile-
 * protected savePlan, evaluateClaim/claimPhase). It does NOT manage
 * git branches or PR state; the worker subagent runs the normal
 * `/implement` → `/commit` → `/ship` loop and the lockfile + driver
 * claim from Phase 4 keeps cross-worker writes consistent.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { evaluateClaim } from "./driver-claim.js";
import {
	effectiveDependsOn,
	isPhaseReady,
	type Phase,
	type Plan,
	readyPhases,
} from "./schema.js";
import { loadPlan } from "./storage.js";
import {
	WorkerMailbox as DefaultWorkerMailbox,
	type WorkerMailbox,
	type WorkerMailboxDeps,
	type WorkerOptions,
	type WorkerState,
} from "./worker-mailbox.js";
import type { WorkerNotification } from "./worker-protocol.js";

// ---- Types ------------------------------------------------------------------

export interface FleetOptions {
	planSlug: string;
	/** Hard cap on simultaneously running workers. Default 3. */
	maxParallel?: number;
	/**
	 * Self session id (the orchestrator's). Used to filter out the
	 * orchestrator's own claims when scanning for unclaimed chains.
	 */
	selfSessionId: string;
	/**
	 * Override for the worker subagent factory. Tests substitute a
	 * fake; production callers leave this undefined to use the
	 * default `defaultWorkerDeps()` chain.
	 */
	workerDeps?: WorkerMailboxDeps;
	/**
	 * Override for the WorkerMailbox constructor. Tests substitute a
	 * fake mailbox impl. Production callers leave undefined.
	 */
	workerFactory?: (
		ctx: ExtensionContext,
		opts: WorkerOptions,
		deps?: WorkerMailboxDeps,
	) => WorkerMailbox;
}

export interface FleetEvent {
	chainId: string;
	notification: WorkerNotification;
}

export interface FleetSnapshot {
	workers: WorkerState[];
	/** Chain ids ready but unclaimed (paused due to maxParallel cap). */
	queued: string[];
	/** True once no workers remain and no ready chains can be spawned. */
	complete: boolean;
}

// ---- Helpers ----------------------------------------------------------------

/**
 * Compute the chain id for a phase: walk `effectiveDependsOn` to the
 * root and return the root phase id. Bounded by `phases.length` to
 * defeat cycles in hand-edited plans.
 */
export function chainIdFor(plan: Plan, phase: Phase): string {
	let cur: Phase = phase;
	const limit = plan.phases.length;
	for (let i = 0; i < limit; i++) {
		const parents = effectiveDependsOn(plan, cur);
		const parentId = parents[0];
		if (!parentId) return cur.id;
		const parent = plan.phases.find((p) => p.id === parentId);
		if (!parent) return cur.id;
		cur = parent;
	}
	return cur.id;
}

/**
 * Find unclaimed ready chain heads. A "head" is a phase where
 * `isPhaseReady` is true AND no live driver currently owns it.
 * Chain ids are deduplicated so two ready siblings under the same
 * parent only surface once.
 */
export function unclaimedChainHeads(
	plan: Plan,
	selfSessionId: string,
): { chainId: string; phaseId: string }[] {
	const seen = new Set<string>();
	const out: { chainId: string; phaseId: string }[] = [];
	for (const phase of readyPhases(plan)) {
		const decision = evaluateClaim(phase, selfSessionId);
		if (decision.kind === "occupied") continue;
		const cid = chainIdFor(plan, phase);
		if (seen.has(cid)) continue;
		seen.add(cid);
		out.push({ chainId: cid, phaseId: phase.id });
	}
	return out;
}

// ---- FleetManager -----------------------------------------------------------

const DEFAULT_MAX_PARALLEL = 3;

export class FleetManager {
	private readonly ctx: ExtensionContext;
	private readonly opts: FleetOptions;
	private readonly maxParallel: number;

	private workers = new Map<string, WorkerMailbox>();
	private queued: { chainId: string; phaseId: string }[] = [];
	private listeners = new Set<(event: FleetEvent) => void>();
	private completionResolvers: Array<() => void> = [];
	private disposed = false;
	private complete = false;
	// Serialise refresh() runs. `void this.refresh()` from event
	// handlers can race; concurrent runs would each see
	// `this.workers.size < maxParallel` and over-spawn. We keep one
	// in-flight, plus at most one queued (further requests collapse
	// onto the queued one).
	private refreshing: Promise<void> | null = null;
	private refreshQueued = false;

	constructor(ctx: ExtensionContext, opts: FleetOptions) {
		this.ctx = ctx;
		this.opts = opts;
		this.maxParallel = opts.maxParallel ?? DEFAULT_MAX_PARALLEL;
	}

	/**
	 * Subscribe to per-worker notifications. Useful for the
	 * coordinator UI to render fleet progress.
	 */
	onEvent(listener: (event: FleetEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): FleetSnapshot {
		return {
			workers: [...this.workers.values()].map((w) => w.getState()),
			queued: this.queued.map((q) => q.chainId),
			complete: this.complete,
		};
	}

	/**
	 * Start the fleet: scan the plan, spawn up to `maxParallel`
	 * workers, queue the rest. Returns a promise that resolves when
	 * the fleet completes (no workers, no ready chains).
	 */
	async start(): Promise<void> {
		if (this.disposed) throw new Error("FleetManager is disposed");
		await this.refresh();
		if (this.workers.size === 0 && this.queued.length === 0) {
			this.markComplete();
			return;
		}
		await new Promise<void>((resolve) => {
			this.completionResolvers.push(resolve);
		});
	}

	/** Tear down all workers. Best-effort. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const disposals = [...this.workers.values()].map((w) => w.dispose());
		this.workers.clear();
		this.queued = [];
		this.listeners.clear();
		// Resolve any waiters so callers don't hang.
		const waiters = this.completionResolvers;
		this.completionResolvers = [];
		for (const r of waiters) r();
		await Promise.allSettled(disposals);
	}

	// ---- internals --------------------------------------------------------

	/**
	 * Re-read the plan, compute unclaimed chain heads not already
	 * owned by an active worker, spawn up to the parallelism cap,
	 * queue the rest. Idempotent — safe to call after every worker
	 * lifecycle event.
	 */
	private async refresh(): Promise<void> {
		// Single in-flight refresh + at most one queued. Coalesces a
		// burst of `phase-shipped` events into one re-scan after each
		// run.
		if (this.refreshing) {
			this.refreshQueued = true;
			return this.refreshing;
		}
		this.refreshing = (async () => {
			try {
				do {
					this.refreshQueued = false;
					await this.runRefresh();
				} while (this.refreshQueued && !this.disposed);
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
	}

	private async runRefresh(): Promise<void> {
		if (this.disposed) return;
		const plan = loadPlan(this.opts.planSlug);
		if (!plan) return;
		const heads = unclaimedChainHeads(plan, this.opts.selfSessionId);
		const owned = new Set(this.workers.keys());
		const toSpawn: { chainId: string; phaseId: string }[] = [];
		const toQueue: { chainId: string; phaseId: string }[] = [];
		for (const head of heads) {
			if (owned.has(head.chainId)) continue;
			if (this.workers.size + toSpawn.length < this.maxParallel) {
				toSpawn.push(head);
			} else {
				toQueue.push(head);
			}
		}
		this.queued = toQueue;
		for (const head of toSpawn) {
			await this.spawnWorker(plan, head.chainId, head.phaseId);
		}
	}

	private async spawnWorker(
		plan: Plan,
		chainId: string,
		chainHeadPhaseId: string,
	): Promise<void> {
		const phase = plan.phases.find((p) => p.id === chainHeadPhaseId);
		if (!phase || !isPhaseReady(plan, phase)) return;
		const cwd = phase.worktreePath ?? this.ctx.cwd;
		const opts: WorkerOptions = {
			chainId,
			chainHeadId: chainHeadPhaseId,
			planSlug: this.opts.planSlug,
			cwd,
		};
		const factory = this.opts.workerFactory ?? defaultWorkerFactory;
		const deps = this.opts.workerDeps;
		const mailbox = factory(this.ctx, opts, deps);
		this.workers.set(chainId, mailbox);
		mailbox.onEvent((notification) => {
			for (const l of this.listeners) {
				try {
					l({ chainId, notification });
				} catch {
					/* best-effort */
				}
			}
			// Spawn-on-shipped: a phase shipping in this chain may have
			// unblocked a sibling chain. Re-scan opportunistically; refresh
			// is a no-op when there's nothing new.
			if (notification.kind === "phase-shipped") {
				void this.refresh();
			}
		});
		mailbox.onEnd(() => {
			void this.handleWorkerEnd(chainId);
		});
		try {
			await mailbox.start();
		} catch (err) {
			// Worker spawn failed. Surface as a synthetic error event and
			// remove from the active set; refresh will be tried via end-handler.
			const reason = err instanceof Error ? err.message : String(err);
			for (const l of this.listeners) {
				try {
					l({
						chainId,
						notification: {
							kind: "phase-error",
							phaseId: chainHeadPhaseId,
							error: reason,
						},
					});
				} catch {
					/* best-effort */
				}
			}
			this.workers.delete(chainId);
			void mailbox.dispose();
			void this.refresh();
		}
	}

	private async handleWorkerEnd(chainId: string): Promise<void> {
		const mailbox = this.workers.get(chainId);
		if (mailbox) {
			this.workers.delete(chainId);
			void mailbox.dispose();
		}
		await this.refresh();
		if (this.workers.size === 0 && this.queued.length === 0) {
			this.markComplete();
		}
	}

	private markComplete(): void {
		this.complete = true;
		const waiters = this.completionResolvers;
		this.completionResolvers = [];
		for (const r of waiters) r();
	}
}

function defaultWorkerFactory(
	ctx: ExtensionContext,
	opts: WorkerOptions,
	deps?: WorkerMailboxDeps,
): WorkerMailbox {
	return deps
		? new DefaultWorkerMailbox(ctx, opts, deps)
		: new DefaultWorkerMailbox(ctx, opts);
}

/**
 * Helper: fleet is "trivial" when the plan has fewer than two
 * independent chains. Coordinator command uses this to fall back to
 * normal `/implement` rather than spawning a one-worker fleet.
 */
export function fleetWouldBeTrivial(
	plan: Plan,
	selfSessionId: string,
): boolean {
	const heads = unclaimedChainHeads(plan, selfSessionId);
	return heads.length < 2;
}

// Re-export commonly-used types so consumers don't need to dive.
export type { WorkerState } from "./worker-mailbox.js";
export type { WorkerNotification } from "./worker-protocol.js";
