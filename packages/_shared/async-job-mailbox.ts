/**
 * Generic async-job mailbox: FIFO queue + non-blocking ask/check/wait.
 *
 * Extracted from `ExploreMailbox` (pre-#159a) so the same queue,
 * lifecycle, and waiter machinery can drive any sub-agent kind —
 * explore today, research after #159a, future kinds (file-watcher,
 * web-monitor, ...) without re-implementing the wiring.
 *
 * The shape of a queued job is opaque to this class beyond
 * {@link BaseJob}; specialisations (explore, research, ...) extend
 * `BaseJob` with kind-specific fields (e.g. `question`) and supply
 * a {@link Dispatcher} that knows how to actually run the job.
 *
 * Three operations match the original explore contract verbatim:
 *
 *   - enqueue(buildJob) → `{ id }`        — non-blocking; returns task id.
 *   - check({ id?, drain? })              — non-blocking; drains terminal
 *                                            tasks + any mid-flight notifications.
 *   - wait(id, timeoutMs)                 — opt-in blocking on terminal state.
 *
 * Concurrency: `maxConcurrent: 1` (default) is the explore FIFO model
 * — one job at a time. `maxConcurrent: Infinity` is the research model
 * — every queued job dispatches immediately and runs in parallel. The
 * #159c parallelism knob will plug in via the same field.
 */

// ---- Public types -----------------------------------------------------------

export type TaskStatus = "queued" | "running" | "done" | "error" | "timeout";

/**
 * Minimum shape every queued job must carry. Specialisations extend
 * with their own fields — `question` for explore, `topic` for research,
 * etc. The `text` / `error` fields are populated by the dispatcher
 * via {@link DispatchHandle.update} or by the dispatcher's resolved
 * `text` value.
 */
export interface BaseJob {
	id: string;
	status: TaskStatus;
	enqueuedAt: number;
	startedAt?: number;
	endedAt?: number;
	text?: string;
	error?: string;
}

/** Mid-flight progress signal from the running dispatcher. */
export interface BaseNotification {
	id: string;
	text: string;
	kind?: string;
	jobId?: string;
	at: number;
}

export interface CheckOptions {
	/** When set, return only this task; do not drain. */
	id?: string;
	/** Default true — remove returned terminal tasks/notifications. */
	drain?: boolean;
}

export interface CheckResult<
	TJob extends BaseJob,
	TNote extends BaseNotification,
> {
	tasks: TJob[];
	notifications: TNote[];
}

export interface MailboxState<
	TJob extends BaseJob,
	TNote extends BaseNotification,
> {
	tasks: TJob[];
	notifications: TNote[];
}

/**
 * Live handle the {@link Dispatcher} uses to mutate the queued job
 * during execution. The mailbox owns the canonical job; dispatcher
 * patches it via this handle so listeners and waiters see updates.
 */
export interface DispatchHandle<
	TJob extends BaseJob,
	TNote extends BaseNotification,
> {
	job: TJob;
	signal: AbortSignal;
	/**
	 * Mark the job as running. Sets `startedAt` and emits a state
	 * change. Idempotent — second call is a no-op.
	 */
	setRunning: () => void;
	/** Patch arbitrary fields on the live job and emit a change. */
	update: (patch: Partial<TJob>) => void;
	/**
	 * Surface a mid-flight notification. Mailbox assigns id + at.
	 * Caller passes the kind-specific note shape sans those fields.
	 */
	notify: (note: Omit<TNote, "id" | "at" | "jobId">) => void;
}

/**
 * Dispatcher contract: given a live handle, run the job to completion
 * and return its terminal text. May throw — mailbox catches and marks
 * the job `error`. Honour `handle.signal` for cooperative cancellation
 * (mailbox dispose, host abort).
 */
export type Dispatcher<TJob extends BaseJob, TNote extends BaseNotification> = (
	handle: DispatchHandle<TJob, TNote>,
) => Promise<{ text: string; jobPatch?: Partial<TJob> }>;

export interface AsyncJobMailboxOptions<
	TJob extends BaseJob,
	TNote extends BaseNotification,
> {
	/** Discriminator string (informational; surfaces in widget labels). */
	kind: string;
	dispatch: Dispatcher<TJob, TNote>;
	/**
	 * Override the id prefix. Default: first letter of `kind`. Set to
	 * preserve a stable id scheme across refactors (e.g. `"q"` for
	 * explore so test assertions on `q1`/`q2` keep passing).
	 */
	idPrefix?: string;
	/**
	 * Max in-flight jobs. `1` (default) = FIFO (explore-style).
	 * `Infinity` = parallel dispatch (research-style). #159c will
	 * surface this through `extensionConfig.modes.<kind>.parallelism`.
	 */
	maxConcurrent?: number;
	/** Wait timeout fallback. Default 120s. */
	defaultWaitTimeoutMs?: number;
	/**
	 * Build the kind-specific fields for synthetic terminal records
	 * returned by `wait()` for unknown ids. Specialisations should
	 * provide this so callers reading kind-specific fields (e.g.
	 * `task.question`) don't see undefined. The synthetic record's
	 * `BaseJob` fields (`id`, `status`, `error`, timestamps) are
	 * always populated by the mailbox itself — this just covers the
	 * remainder of the kind. Defaults to an empty object.
	 */
	synthesizeUnknown?: (id: string) => Partial<TJob>;
	/**
	 * Best-effort hook fired when the mailbox disposes. The dispatcher
	 * uses this to tear down its own resources (e.g. the persistent
	 * agent in explore's case).
	 */
	onDispose?: () => Promise<void> | void;
}

// ---- Defaults ---------------------------------------------------------------

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

// ---- Internals --------------------------------------------------------------

interface Waiter<TJob extends BaseJob> {
	resolve: (job: TJob) => void;
	timer?: NodeJS.Timeout;
}

function isTerminal(status: TaskStatus): boolean {
	return status === "done" || status === "error" || status === "timeout";
}

function snapshot<T extends object>(value: T): T {
	return { ...value };
}

// ---- Class ------------------------------------------------------------------

export class AsyncJobMailbox<
	TJob extends BaseJob,
	TNote extends BaseNotification,
> {
	private readonly opts: AsyncJobMailboxOptions<TJob, TNote>;
	private readonly maxConcurrent: number;
	private readonly defaultWaitTimeoutMs: number;

	private jobs: TJob[] = [];
	private jobById = new Map<string, TJob>();
	private notifications: TNote[] = [];
	/**
	 * Jobs picked up by {@link dispatchNext} but not yet visibly
	 * `running` (the dispatcher hasn't called `setRunning()` yet, or
	 * the job is mid-await before the status flip). Without this set
	 * the while-loop in `dispatchNext` would re-select the same
	 * `status === "queued"` job on the next iteration when
	 * `maxConcurrent > 1` — infinite re-dispatch.
	 */
	private claimedJobIds = new Set<string>();

	private waiters = new Map<string, Waiter<TJob>[]>();
	private listeners = new Set<(state: MailboxState<TJob, TNote>) => void>();

	private nextJobNum = 1;
	private nextNotifyNum = 1;
	private inFlight = 0;
	private abortControllers = new Map<string, AbortController>();
	private disposed = false;

	constructor(opts: AsyncJobMailboxOptions<TJob, TNote>) {
		this.opts = opts;
		this.maxConcurrent = opts.maxConcurrent ?? 1;
		this.defaultWaitTimeoutMs =
			opts.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
	}

	/** Subscribe to mailbox state changes. Returns an unsubscribe fn. */
	onChange(listener: (state: MailboxState<TJob, TNote>) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Enqueue a job. Caller passes a builder that receives a fresh id
	 * and timestamp and returns the kind-specific job shape. Dispatch
	 * is fired immediately if `maxConcurrent` allows; otherwise the
	 * job stays `queued` and {@link dispatchNext} picks it up.
	 *
	 * Returns the assigned id without awaiting completion — never
	 * blocks.
	 */
	enqueue(buildJob: (id: string, enqueuedAt: number) => TJob): { id: string } {
		if (this.disposed) throw new Error(`${this.opts.kind} mailbox is disposed`);
		const id = `${this.kindPrefix()}${this.nextJobNum++}`;
		const job = buildJob(id, Date.now());
		// Force the queued status — don't trust the builder to set it.
		job.status = "queued";
		this.jobs.push(job);
		this.jobById.set(id, job);
		this.emit();
		void this.dispatchNext();
		return { id };
	}

	/**
	 * Drain the mailbox. With no `id`, returns all pending tasks plus
	 * a snapshot of notifications, removing terminal tasks +
	 * notifications when `drain` (default true). With `id`, returns a
	 * single-task snapshot and never drains.
	 */
	check(opts: CheckOptions = {}): CheckResult<TJob, TNote> {
		const drain = opts.drain ?? true;

		if (opts.id) {
			const job = this.jobById.get(opts.id);
			return {
				tasks: job ? [snapshot(job)] : [],
				notifications: [],
			};
		}

		const taskSnapshots = this.jobs.map(snapshot);
		const noteSnapshots = this.notifications.map(snapshot);

		if (drain) {
			this.jobs = this.jobs.filter((j) => {
				if (isTerminal(j.status)) {
					this.jobById.delete(j.id);
					return false;
				}
				return true;
			});
			this.notifications = [];
			this.emit();
		}

		return { tasks: taskSnapshots, notifications: noteSnapshots };
	}

	/**
	 * Block until the named job reaches a terminal state, the timeout
	 * fires, or `signal` aborts. On timeout the underlying dispatcher
	 * keeps running; subsequent `check`/`wait` may still observe the real
	 * outcome. An abort settles the wait promptly (status `aborted`) so a
	 * caller holding an external slot — e.g. the subagent delegate
	 * semaphore — can release it; the dispatcher itself is unaffected.
	 */
	async wait(
		id: string,
		timeoutMs: number = this.defaultWaitTimeoutMs,
		signal?: AbortSignal,
	): Promise<TJob> {
		if (this.disposed) throw new Error(`${this.opts.kind} mailbox is disposed`);
		const job = this.jobById.get(id);
		if (!job) {
			const extras = this.opts.synthesizeUnknown?.(id) ?? {};
			return {
				...(extras as TJob),
				id,
				status: "error" as TaskStatus,
				error: `unknown task id: ${id}`,
				enqueuedAt: Date.now(),
				endedAt: Date.now(),
			};
		}
		if (isTerminal(job.status)) return snapshot(job);
		if (signal?.aborted) {
			return {
				...snapshot(job),
				status: "error",
				error: `wait(${id}) aborted`,
				endedAt: Date.now(),
			};
		}

		return new Promise<TJob>((resolve) => {
			let settled = false;
			let onAbort: (() => void) | undefined;
			const settle = (j: TJob) => {
				if (settled) return;
				settled = true;
				if (waiter.timer) clearTimeout(waiter.timer);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				resolve(j);
			};
			const removeWaiter = () => {
				const arr = this.waiters.get(id);
				if (arr) {
					const idx = arr.indexOf(waiter);
					if (idx >= 0) arr.splice(idx, 1);
				}
			};
			const waiter: Waiter<TJob> = {
				resolve: (j) => settle(snapshot(j)),
			};
			waiter.timer = setTimeout(() => {
				settle({
					...snapshot(job),
					status: "timeout",
					error: `wait(${id}) timed out after ${timeoutMs}ms`,
					endedAt: Date.now(),
				});
				removeWaiter();
			}, timeoutMs);
			if (signal) {
				onAbort = () => {
					settle({
						...snapshot(job),
						status: "error",
						error: `wait(${id}) aborted`,
						endedAt: Date.now(),
					});
					removeWaiter();
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}
			const arr = this.waiters.get(id) ?? [];
			arr.push(waiter);
			this.waiters.set(id, arr);
		});
	}

	/** True if any job is queued or running. */
	get hasInFlight(): boolean {
		return this.jobs.some((j) => !isTerminal(j.status));
	}

	getState(): MailboxState<TJob, TNote> {
		return {
			tasks: this.jobs.map(snapshot),
			notifications: this.notifications.map(snapshot),
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		// Cancel in-flight dispatchers.
		for (const ctrl of this.abortControllers.values()) {
			try {
				ctrl.abort();
			} catch {
				/* best-effort */
			}
		}
		this.abortControllers.clear();
		// Drop pending waiters.
		for (const arr of this.waiters.values()) {
			for (const w of arr) {
				if (w.timer) clearTimeout(w.timer);
			}
		}
		this.waiters.clear();
		try {
			await this.opts.onDispose?.();
		} catch {
			/* best-effort */
		}
	}

	// ---- internals --------------------------------------------------------

	private kindPrefix(): string {
		if (this.opts.idPrefix !== undefined) return this.opts.idPrefix;
		// Single-letter prefix derived from the kind so test ids stay
		// readable (`e1` for explore, `r1` for research). Falls back to
		// "j" (job) for any kind that doesn't start with a letter.
		const ch = this.opts.kind.charAt(0).toLowerCase();
		return /^[a-z]$/.test(ch) ? ch : "j";
	}

	/**
	 * Try to dispatch as many queued jobs as `maxConcurrent` allows.
	 * Each dispatch runs to completion in its own async context.
	 */
	private async dispatchNext(): Promise<void> {
		if (this.disposed) return;
		while (this.inFlight < this.maxConcurrent) {
			const next = this.jobs.find(
				(j) => j.status === "queued" && !this.claimedJobIds.has(j.id),
			);
			if (!next) return;
			this.inFlight++;
			this.claimedJobIds.add(next.id);
			void this.runJob(next);
		}
	}

	private async runJob(job: TJob): Promise<void> {
		const ctrl = new AbortController();
		this.abortControllers.set(job.id, ctrl);

		// `setRunning` is the dispatcher-side signal for "the underlying
		// agent has actually started" (e.g. `agent_start` event for
		// explore). Some kinds — research, today — start work immediately
		// in the dispatch fn, so they call setRunning themselves up
		// front. Either way, the queued→running transition is the
		// dispatcher's call.
		let runningMarked = false;
		const handle: DispatchHandle<TJob, TNote> = {
			job,
			signal: ctrl.signal,
			setRunning: () => {
				if (runningMarked) return;
				runningMarked = true;
				job.status = "running";
				job.startedAt = Date.now();
				this.emit();
			},
			update: (patch) => {
				Object.assign(job, patch);
				this.emit();
			},
			notify: (note) => {
				const full = {
					...(note as Partial<BaseNotification>),
					id: `n${this.nextNotifyNum++}`,
					at: Date.now(),
					jobId: job.id,
				} as unknown as TNote;
				this.notifications.push(full);
				this.emit();
			},
		};

		try {
			const out = await this.opts.dispatch(handle);
			if (out.jobPatch) Object.assign(job, out.jobPatch);
			job.text = out.text;
			job.status = "done";
		} catch (err) {
			job.error = err instanceof Error ? err.message : String(err);
			job.status = "error";
		} finally {
			job.endedAt = Date.now();
			this.abortControllers.delete(job.id);
			this.claimedJobIds.delete(job.id);
			this.inFlight = Math.max(0, this.inFlight - 1);
			this.resolveWaiters(job);
			this.emit();
			void this.dispatchNext();
		}
	}

	private resolveWaiters(job: TJob): void {
		const arr = this.waiters.get(job.id);
		if (!arr) return;
		this.waiters.delete(job.id);
		for (const w of arr) {
			w.resolve(job);
		}
	}

	private emit(): void {
		if (this.listeners.size === 0) return;
		const state = this.getState();
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch {
				/* best-effort */
			}
		}
	}
}

// ---- Helpers re-exported for specialisations -------------------------------

export { isTerminal };
