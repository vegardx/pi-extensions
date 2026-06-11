/**
 * Counting semaphore gating concurrent delegate executions.
 *
 * Modeled on the waiter loop that backed modes' `cappedResearch`: the
 * limit is evaluated per `acquire` (config can change between calls),
 * waiters are FIFO, and an abort while queued surfaces as a typed
 * error so the caller can return a structured failure instead of
 * holding a slot.
 */

/** Thrown by {@link Semaphore.acquire} when the signal fires while queued. */
export class SemaphoreAbortedError extends Error {
	constructor() {
		super("aborted while queued for a delegate slot");
		this.name = "SemaphoreAbortedError";
	}
}

export class Semaphore {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	/** Currently held slots (diagnostics/tests). */
	get activeCount(): number {
		return this.active;
	}

	/** Callers blocked waiting for a slot (diagnostics/tests). */
	get queuedCount(): number {
		return this.waiters.length;
	}

	/**
	 * Acquire a slot, blocking FIFO while `activeCount >= limit`.
	 * Returns an idempotent release function. `limit` values that are
	 * non-finite or < 1 mean uncapped (mirrors the config readers'
	 * fallback semantics).
	 */
	async acquire(opts: {
		limit: number;
		signal?: AbortSignal;
	}): Promise<() => void> {
		const { signal } = opts;
		const limit =
			Number.isFinite(opts.limit) && opts.limit >= 1
				? Math.floor(opts.limit)
				: Number.POSITIVE_INFINITY;
		for (;;) {
			if (signal?.aborted) throw new SemaphoreAbortedError();
			if (this.active < limit) break;
			await new Promise<void>((resolve) => {
				const cleanup = () => {
					const i = this.waiters.indexOf(waiter);
					if (i >= 0) this.waiters.splice(i, 1);
					signal?.removeEventListener("abort", onAbort);
				};
				const waiter = () => {
					cleanup();
					resolve();
				};
				const onAbort = () => {
					cleanup();
					resolve(); // loop top re-checks and throws
				};
				this.waiters.push(waiter);
				signal?.addEventListener("abort", onAbort);
			});
		}
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.waiters.shift()?.();
		};
	}
}
