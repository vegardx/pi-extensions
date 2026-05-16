/**
 * Session-scoped research delegate for plan/auto/ask modes.
 *
 * Kept narrow on purpose: the codebase-exploration sub-agent moved
 * to `ExploreMailbox` so the main agent never blocks on it. Research
 * stays request/response — each call spawns a fresh process and they
 * already run in parallel without main-context bloat.
 *
 * Errors are returned as a structured discriminated outcome — never
 * thrown — so the main agent can decide how to proceed and the host
 * tool can format / notify based on the failure reason.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	AsyncJobMailbox,
	type BaseJob,
	type BaseNotification,
	type CheckOptions,
	type CheckResult,
	type MailboxState,
} from "./async-job-mailbox.js";

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const RESEARCH_TOOLS: readonly string[] = ["websearch", "webfetch"];

/**
 * Fallback timeout when neither the per-call `timeoutMs` nor the
 * `extensionConfig.modes.researchTimeoutMs` setting is provided.
 *
 * 90s matches the historical hard-coded value before the timeout
 * became configurable (issue #167).
 */
export const DEFAULT_RESEARCH_TIMEOUT_MS = 90_000;

export interface ResearchOptions {
	/**
	 * Hard timeout in milliseconds. When unset, falls back to
	 * {@link DEFAULT_RESEARCH_TIMEOUT_MS}. Forwarded to
	 * `runSubagent` → `RpcClient.waitForIdle`.
	 */
	timeoutMs?: number;
	/** Host abort signal — propagated into `runSubagent`. */
	signal?: AbortSignal;
}

/**
 * Discriminated outcome of a `research()` call. The host tool maps
 * this to a tool-call result + optional notify. Internal callers can
 * branch on `reason` without parsing bracketed strings.
 */
export type ResearchOutcome =
	| { ok: true; text: string; elapsedMs: number }
	| {
			ok: false;
			reason: "no-model";
			detail: string;
			elapsedMs: number;
	  }
	| {
			ok: false;
			reason: "timeout";
			elapsedMs: number;
			timeoutMs: number;
	  }
	| {
			ok: false;
			reason: "subagent-error";
			detail: string;
			elapsedMs: number;
	  }
	| {
			ok: false;
			reason: "empty";
			detail: string;
			elapsedMs: number;
	  };

export class DelegateAgents {
	private readonly ctx: ExtensionContext;
	private readonly activeResearch = new Map<number, string>();
	private nextResearchId = 0;
	/**
	 * Non-blocking research mailbox (#159a). `research_ask` enqueues
	 * a job here; `research_check` / `research_wait` drain it.
	 * `maxConcurrent: Infinity` because each research call spawns a
	 * fresh subprocess and they're already parallel-safe.
	 *
	 * Lazily created so the legacy blocking `research()` path doesn't
	 * pay any setup cost.
	 */
	private researchMailboxInstance: AsyncJobMailbox<
		ResearchTask,
		ResearchNotification
	> | null = null;

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	// ---- non-blocking research mailbox (#159a) -------------------------

	private get researchMailbox(): AsyncJobMailbox<
		ResearchTask,
		ResearchNotification
	> {
		if (this.researchMailboxInstance) return this.researchMailboxInstance;
		this.researchMailboxInstance = new AsyncJobMailbox<
			ResearchTask,
			ResearchNotification
		>({
			kind: "research",
			// Each research job spawns its own subprocess — they're already
			// parallel-safe, no FIFO needed. Infinity matches today's
			// blocking-research semantics where N concurrent calls fan out
			// to N subprocesses.
			maxConcurrent: Number.POSITIVE_INFINITY,
			defaultWaitTimeoutMs: DEFAULT_RESEARCH_TIMEOUT_MS,
			dispatch: async (handle) => {
				handle.setRunning();
				const outcome = await this.research(handle.job.question, {
					timeoutMs: handle.job.timeoutMs,
					signal: handle.signal,
				});
				// Pack outcome into the job so callers can read structured
				// failure reasons via `check`/`wait`. `text` is the agent-
				// facing summary; on failure we synthesise a one-liner so
				// the bare `text` field still tells the story.
				const text = outcome.ok ? outcome.text : formatOutcomeFailure(outcome);
				return {
					text,
					jobPatch: { outcome } satisfies Partial<ResearchTask>,
				};
			},
		});
		return this.researchMailboxInstance;
	}

	async researchAsk(
		question: string,
		opts: ResearchOptions = {},
	): Promise<{ id: string }> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS;
		return this.researchMailbox.enqueue((id, enqueuedAt) => ({
			id,
			status: "queued",
			enqueuedAt,
			question,
			timeoutMs,
		}));
	}

	researchCheck(
		opts: CheckOptions = {},
	): CheckResult<ResearchTask, ResearchNotification> {
		if (!this.researchMailboxInstance) return { tasks: [], notifications: [] };
		return this.researchMailboxInstance.check(opts);
	}

	async researchWait(id: string, timeoutMs?: number): Promise<ResearchTask> {
		return this.researchMailbox.wait(id, timeoutMs);
	}

	onResearchChange(
		listener: (state: MailboxState<ResearchTask, ResearchNotification>) => void,
	): () => void {
		return this.researchMailbox.onChange(listener);
	}

	get hasResearchInFlight(): boolean {
		return this.researchMailboxInstance?.hasInFlight ?? false;
	}

	/**
	 * Ask the research agent a question. Each call spawns a fresh
	 * one-shot process so multiple concurrent questions run fully in
	 * parallel.
	 *
	 * Returns a structured {@link ResearchOutcome}. Never throws —
	 * abort/timeout/no-model failures all surface as `ok: false` with
	 * a discriminating `reason`.
	 */
	async research(
		question: string,
		opts: ResearchOptions = {},
	): Promise<ResearchOutcome> {
		const timeoutMs = opts.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS;
		const start = Date.now();
		const id = this.nextResearchId++;
		const flat = question.replace(/\s+/g, " ").trim();
		const topic = flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
		this.activeResearch.set(id, topic);
		this.updateResearchWidget();
		try {
			const resolved = await resolveModel(this.ctx, {
				name: "modes",
				tier: "fast",
			});
			if (!resolved) {
				return {
					ok: false,
					reason: "no-model",
					detail:
						"no fast-tier model configured — add backgroundModels.primary.fast to settings.json",
					elapsedMs: Date.now() - start,
				};
			}
			const outcome = await runSubagent({
				tag: id,
				task: question,
				systemPromptPath: join(PROMPTS_DIR, "research-agent.md"),
				tools: RESEARCH_TOOLS,
				provider: resolved.model.provider,
				model: resolved.model.id,
				cwd: this.ctx.cwd,
				// Use AbortSignal.timeout so the deadline covers client.start() and
				// client.prompt() too, not just waitForIdle. Combine with the
				// caller's signal so either abort source cancels cleanly.
				signal: opts.signal
					? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
					: AbortSignal.timeout(timeoutMs),
				timeoutMs,
			});
			const elapsedMs = Date.now() - start;
			if (outcome.error) {
				// AbortSignal.timeout fires at exactly timeoutMs ms, so any error
				// with elapsed ≥ timeoutMs was caused by the deadline (not a
				// coincidentally slow non-timeout failure). This is more precise
				// than matching the upstream "Timeout waiting…" message string.
				if (elapsedMs >= timeoutMs) {
					return { ok: false, reason: "timeout", elapsedMs, timeoutMs };
				}
				return {
					ok: false,
					reason: "subagent-error",
					detail: outcome.error,
					elapsedMs,
				};
			}
			if (!outcome.rawText) {
				return {
					ok: false,
					reason: "empty",
					detail: "subagent returned no text",
					elapsedMs,
				};
			}
			return { ok: true, text: outcome.rawText, elapsedMs };
		} finally {
			this.activeResearch.delete(id);
			this.updateResearchWidget();
		}
	}

	private updateResearchWidget(): void {
		if (!this.ctx.hasUI) return;
		if (this.activeResearch.size === 0) {
			this.ctx.ui.setWidget("delegate-research", undefined);
			return;
		}
		const rows = Array.from(this.activeResearch.values()).map(
			(t) => `  ⏳ ${t}`,
		);
		this.ctx.ui.setWidget("delegate-research", ["🌐 Research", ...rows]);
	}

	/** No persistent state — present as a no-op for symmetry with the
	 *  prior API; future additions can hook teardown here. */
	async dispose(): Promise<void> {
		await this.researchMailboxInstance?.dispose();
		this.researchMailboxInstance = null;
	}
}

// ---- Research mailbox types (#159a) ----------------------------------------

export interface ResearchTask extends BaseJob {
	question: string;
	timeoutMs: number;
	/**
	 * Structured outcome of the underlying `research()` call — set
	 * once the dispatcher resolves. Even on `ok: false` the task's
	 * `status` is `"done"`: the run finished, the result just isn't
	 * useful. Callers branch on `outcome.ok` rather than `status`.
	 */
	outcome?: ResearchOutcome;
}

export interface ResearchNotification extends BaseNotification {
	/* room to extend: severity, source, etc. */
}

function formatOutcomeFailure(
	outcome: ResearchOutcome & { ok: false },
): string {
	switch (outcome.reason) {
		case "no-model":
			return `[research no-model] ${outcome.detail}`;
		case "timeout":
			return `[research timeout] ${outcome.elapsedMs}ms (limit ${outcome.timeoutMs}ms)`;
		case "subagent-error":
			return `[research error] ${outcome.detail}`;
		case "empty":
			return `[research empty] ${outcome.detail}`;
	}
}
