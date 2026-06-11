/**
 * Async delegate jobs. `delegate({..., async: true})` enqueues here and
 * returns a job id immediately; on completion the capped result is
 * surfaced to the conversation as a follow-up message.
 *
 * One mailbox with `maxConcurrent: Infinity` — the semaphore inside
 * the dispatcher is the real concurrency gate, shared with the
 * blocking delegate path so sync + async executions count against the
 * same budget.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	AsyncJobMailbox,
	type BaseJob,
	type BaseNotification,
} from "@vegardx/pi-extensions-shared/async-job-mailbox.js";
import type {
	DelegateTarget,
	DelegateTargetResult,
} from "@vegardx/pi-extensions-shared/delegate-registry.js";
import { capDelegatedAnswer } from "./config.js";
import { type Semaphore, SemaphoreAbortedError } from "./semaphore.js";

export interface DelegateJob extends BaseJob {
	to: string;
	message: string;
	/** Concurrency cap captured at submit time (config is per-cwd). */
	limit: number;
	/** Answer-size cap captured at submit time. */
	capChars: number;
	/**
	 * Bound executor closing over target/params/ctx. Jobs are
	 * in-memory only, so a closure is fine here.
	 */
	run(signal: AbortSignal): Promise<DelegateTargetResult>;
	/** Set when the dispatcher resolves; `status` alone says "finished". */
	ok?: boolean;
}

export interface SurfacedDelegateResult {
	jobId: string;
	to: string;
	ok: boolean;
	/** Already capped — safe to inject into the conversation. */
	text: string;
}

export interface DelegateJobsOpts {
	semaphore: Semaphore;
	/** Deliver a finished job's result to the conversation. */
	surface(result: SurfacedDelegateResult): void;
}

export interface SubmitJobRequest {
	target: DelegateTarget;
	message: string;
	params?: unknown;
	timeoutMs?: number;
	limit: number;
	capChars: number;
	ctx: ExtensionContext;
}

export class DelegateJobs {
	private readonly mailbox: AsyncJobMailbox<DelegateJob, BaseNotification>;

	constructor(opts: DelegateJobsOpts) {
		this.mailbox = new AsyncJobMailbox<DelegateJob, BaseNotification>({
			kind: "delegate",
			maxConcurrent: Number.POSITIVE_INFINITY,
			dispatch: async (handle) => {
				handle.setRunning();
				const job = handle.job;
				let release: (() => void) | null = null;
				try {
					release = await opts.semaphore.acquire({
						limit: job.limit,
						signal: handle.signal,
					});
					const result = await job.run(handle.signal);
					const text = capDelegatedAnswer(result.text, job.capChars);
					opts.surface({ jobId: job.id, to: job.to, ok: true, text });
					return {
						text,
						jobPatch: { ok: true } satisfies Partial<DelegateJob>,
					};
				} catch (err) {
					const detail =
						err instanceof SemaphoreAbortedError
							? err.message
							: err instanceof Error
								? err.message
								: String(err);
					const text = `[delegate ${job.to} error] ${detail}`;
					opts.surface({ jobId: job.id, to: job.to, ok: false, text });
					return {
						text,
						jobPatch: { ok: false } satisfies Partial<DelegateJob>,
					};
				} finally {
					release?.();
				}
			},
		});
	}

	/** Enqueue; returns the job id synchronously. */
	submit(req: SubmitJobRequest): { id: string } {
		const { target, message, params, timeoutMs, limit, capChars, ctx } = req;
		return this.mailbox.enqueue((id, enqueuedAt) => ({
			id,
			status: "queued",
			enqueuedAt,
			to: target.name,
			message,
			limit,
			capChars,
			run: (signal) =>
				target.execute({ message, params, ctx, signal, timeoutMs }),
		}));
	}

	get hasInFlight(): boolean {
		return this.mailbox.hasInFlight;
	}

	async dispose(): Promise<void> {
		await this.mailbox.dispose();
	}
}
