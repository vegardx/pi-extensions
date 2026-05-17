/**
 * Async mailbox for the codebase-exploration sub-agent.
 *
 * Replaces the previous synchronous `explore(question)` contract with
 * three operations:
 *
 *   - ask(question)              — non-blocking; returns a task id.
 *   - check({ id?, drain? })     — non-blocking; drains completed tasks
 *                                  and any `notify()` calls the sub-agent
 *                                  emitted mid-turn.
 *   - wait(id, timeoutMs)        — opt-in blocking; resolves when the
 *                                  named task reaches a terminal state.
 *
 * Why this exists: the sync API blocked the main agent for up to 60s
 * and disposed the pool on a single timeout, wiping all accumulated
 * exploration context. Splitting send and receive lets the orchestrator
 * fire several questions at once, keep planning, then drain answers
 * when ready.
 *
 * #159a: this file is now a thin specialisation over the generic
 * {@link AsyncJobMailbox}. The queue / waiter / drain machinery lives
 * there; this file owns the explore-specific dispatcher (persistent
 * agent + agent-event correlation + `notify()` tool capture).
 *
 * Correlation rule: each task is dispatched via a fresh
 * `agent.prompt(question)` once the agent is idle. Each prompt
 * produces exactly one `agent_start` … `agent_end` cycle. The
 * dispatcher subscribes to those events and to `tool_execution_start`
 * for live status + notify capture. We deliberately do not use
 * `agent.followUp()` for orchestrator-level FIFO: real pi only drains
 * follow-ups inside an active run, so queued follow-ups on an idle
 * agent are silently dropped, and multiple follow-ups within a
 * single run share one `agent_start`/`agent_end` pair (which would
 * break correlation).
 *
 * `notify()` channel: a tiny extension shipped via `--extension`
 * registers a `notify({ text, kind? })` tool inside the sub-agent
 * process. The handler is a no-op; we observe the call via the
 * `tool_execution_start` event and surface the args via the generic
 * mailbox's notification queue.
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
	AsyncJobMailbox,
	type BaseJob,
	type BaseNotification,
	type CheckOptions,
	type CheckResult,
	type DispatchHandle,
	type MailboxState,
	type TaskStatus,
} from "./async-job-mailbox.js";

// ---- Public types -----------------------------------------------------------

// Re-export TaskStatus so existing imports keep working.
export type { TaskStatus } from "./async-job-mailbox.js";

export interface ExploreTask extends BaseJob {
	question: string;
	/** Last tool the sub-agent invoked; for the live status widget. */
	lastToolSummary?: string;
}

export interface ExploreNotification extends BaseNotification {
	/** Task that was running when the sub-agent emitted the notify. */
	taskId?: string;
}

/**
 * Returns true when the explore panel should be hidden: no tasks are
 * actively running or queued, and there are no pending notifications.
 * Done/error/timeout tasks without active work are intentionally hidden.
 *
 * Exported as a pure function so it can be unit-tested independently of
 * the extension rendering loop.
 */
export function exploreWidgetShouldHide(
	tasks: ExploreTask[],
	notifications: ExploreNotification[],
): boolean {
	const running = tasks.filter((t) => t.status === "running").length;
	const queued = tasks.filter((t) => t.status === "queued").length;
	return running === 0 && queued === 0 && notifications.length === 0;
}

// Re-export from the generic so callers can import locally.
export type {
	CheckOptions,
	CheckResult,
	MailboxState,
} from "./async-job-mailbox.js";

export interface MailboxDeps {
	/**
	 * Spawn the sub-agent. Injectable so tests can stub the
	 * underlying SubagentPool. Returns the agent and a teardown
	 * fn for the mailbox to call on dispose.
	 */
	spawnAgent(
		ctx: ExtensionContext,
	): Promise<{ agent: PersistentAgent; dispose: () => Promise<void> }>;
}

// ---- Defaults ---------------------------------------------------------------

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const EXPLORE_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"notify",
];
const EXPLORE_AGENT_PROMPT = join(PROMPTS_DIR, "explore-agent.md");
const NOTIFY_EXTENSION_PATH = join(PROMPTS_DIR, "explore-notify-tool.ts");

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

// ---- Helpers ----------------------------------------------------------------

function summariseToolCall(
	name: string,
	args: Record<string, unknown>,
): string {
	switch (name) {
		case "read":
			return `read ${args.path ?? args.file_path ?? ""}`;
		case "grep":
			return `grep /${args.pattern ?? ""}/ in ${args.path ?? "."}`;
		case "find":
			return `find ${args.pattern ?? "*"} in ${args.path ?? "."}`;
		case "ls":
			return `ls ${args.path ?? "."}`;
		case "notify":
			return "notify";
		default:
			return name;
	}
}

// ---- Default deps -----------------------------------------------------------

/**
 * Spawn an explore sub-agent backed by `SubagentPool`. Loads the
 * `notify` tool extension via `--extension` and applies the
 * `one-at-a-time` follow-up mode required for FIFO correlation.
 */
export function defaultMailboxDeps(): MailboxDeps {
	return {
		async spawnAgent(ctx) {
			const resolved = await resolveModel(ctx, {
				name: "modes",
				tier: "fast",
			});
			if (!resolved) {
				throw new Error(
					"no fast-tier model configured — add backgroundModels.primary.fast to settings.json",
				);
			}
			const pool = new SubagentPool();
			const agent = await pool.spawn("explore", {
				provider: resolved.model.provider,
				model: resolved.model.id,
				systemPromptPath: EXPLORE_AGENT_PROMPT,
				tools: EXPLORE_TOOLS,
				cwd: ctx.cwd,
				followUpMode: "one-at-a-time",
				extraArgs: ["--extension", NOTIFY_EXTENSION_PATH],
			});
			return {
				agent,
				dispose: () => pool.dispose(),
			};
		},
	};
}

// ---- Mailbox ----------------------------------------------------------------

interface CurrentDispatch {
	handle: DispatchHandle<ExploreTask, ExploreNotification>;
	resolveEnded: () => void;
	rejectEnded: (err: Error) => void;
}

export class ExploreMailbox {
	private readonly ctx: ExtensionContext;
	private readonly deps: MailboxDeps;
	private readonly inner: AsyncJobMailbox<ExploreTask, ExploreNotification>;

	private agent: PersistentAgent | null = null;
	private agentDispose: (() => Promise<void>) | null = null;
	private spawning: Promise<PersistentAgent> | null = null;
	private spawnError: string | null = null;
	private unsubscribe: (() => void) | null = null;
	/**
	 * The currently in-flight dispatch's handle + barrier. Set when
	 * `dispatchExplore` enters its prompt phase, cleared on agent_end
	 * (or abort). The eager listener installed in {@link ensureAgent}
	 * routes incoming agent events through whichever dispatch is
	 * active. Single-slot is sufficient because the inner mailbox runs
	 * with `maxConcurrent: 1`.
	 */
	private currentDispatch: CurrentDispatch | null = null;

	constructor(ctx: ExtensionContext, deps: MailboxDeps = defaultMailboxDeps()) {
		this.ctx = ctx;
		this.deps = deps;
		this.inner = new AsyncJobMailbox<ExploreTask, ExploreNotification>({
			kind: "explore",
			// Preserve the pre-#159a id scheme (`q1`, `q2`, ...) so existing
			// tests + log scrapers keep working.
			idPrefix: "q",
			maxConcurrent: 1,
			defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
			synthesizeUnknown: () => ({ question: "" }),
			dispatch: (handle) => this.dispatchExplore(handle),
			onDispose: () => this.disposeAgent(),
		});
	}

	/** Subscribe to mailbox state changes. Returns an unsubscribe fn. */
	onChange(
		listener: (state: MailboxState<ExploreTask, ExploreNotification>) => void,
	): () => void {
		return this.inner.onChange(listener);
	}

	/**
	 * Enqueue a question. Spawns the sub-agent on first call. Returns
	 * immediately with a task id — never blocks on the answer.
	 */
	async ask(question: string): Promise<{ id: string }> {
		return this.inner.enqueue((id, enqueuedAt) => ({
			id,
			question,
			status: "queued" as TaskStatus,
			enqueuedAt,
		}));
	}

	check(
		opts: CheckOptions = {},
	): CheckResult<ExploreTask, ExploreNotification> {
		return this.inner.check(opts);
	}

	async wait(
		id: string,
		timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
	): Promise<ExploreTask> {
		return this.inner.wait(id, timeoutMs);
	}

	get hasInFlight(): boolean {
		return this.inner.hasInFlight;
	}

	getState(): MailboxState<ExploreTask, ExploreNotification> {
		return this.inner.getState();
	}

	async dispose(): Promise<void> {
		await this.inner.dispose();
	}

	// ---- internals --------------------------------------------------------

	/**
	 * The dispatcher. Spawn the agent on first use (eager-registers a
	 * permanent agent-event listener via {@link ensureAgent}), set up a
	 * per-dispatch barrier, fire `prompt(question)`, and resolve when
	 * the agent emits `agent_end`. The listener routes intermediate
	 * events (agent_start, tool_execution_start, notify capture)
	 * through the live handle.
	 */
	private async dispatchExplore(
		handle: DispatchHandle<ExploreTask, ExploreNotification>,
	): Promise<{ text: string }> {
		let resolveEnded!: () => void;
		let rejectEnded!: (err: Error) => void;
		const ended = new Promise<void>((resolve, reject) => {
			resolveEnded = resolve;
			rejectEnded = reject;
		});
		// Suppress "unhandled rejection" if the abort handler rejects
		// `ended` while we're still awaiting `agent.prompt()` (rather
		// than `ended` itself). The same Promise is awaited later, so
		// the rejection still surfaces — this just declares an explicit
		// handler to keep Vitest's unhandled-rejection guard quiet.
		ended.catch(() => {});
		// Set currentDispatch synchronously — BEFORE awaiting ensureAgent —
		// so the eager agent-event listener installed by ensureAgent on its
		// first invocation finds a non-null dispatch context the moment
		// `agent_start` fires. Without this, microtask ordering can deliver
		// agent_start before dispatchExplore's continuation resumes, and
		// the FIFO head never advances to "running".
		this.currentDispatch = { handle, resolveEnded, rejectEnded };

		const onAbort = () => {
			rejectEnded(new Error("explore dispatch aborted"));
		};
		handle.signal.addEventListener("abort", onAbort);

		try {
			const agent = await this.ensureAgent();
			if (handle.signal.aborted) {
				throw new Error("aborted before dispatch");
			}
			await agent.prompt(handle.job.question);
			await ended;

			// `getLastText()` is RPC; read after agent_end so the just-
			// finished turn's last text is what comes back.
			const text = (await agent.getLastText()) ?? "";
			// Clear live tool summary now that the turn is done — the
			// generic mailbox doesn't know about our kind-specific field.
			handle.update({ lastToolSummary: undefined });
			return { text };
		} finally {
			handle.signal.removeEventListener("abort", onAbort);
			this.currentDispatch = null;
		}
	}

	private handleEvent(event: AgentEvent): void {
		const cd = this.currentDispatch;
		if (!cd) return;
		switch (event.type) {
			case "agent_start": {
				cd.handle.setRunning();
				break;
			}
			case "tool_execution_start": {
				const args = (event.args ?? {}) as Record<string, unknown>;
				cd.handle.update({
					lastToolSummary: summariseToolCall(event.toolName, args),
				});
				if (event.toolName === "notify") {
					const text = typeof args.text === "string" ? args.text : "";
					if (text.length > 0) {
						const kind = typeof args.kind === "string" ? args.kind : undefined;
						cd.handle.notify({
							text,
							// Keep the legacy `taskId` field on the notification
							// alongside the generic `jobId`. Existing consumers
							// (widgets, tests) read `taskId`; the generic
							// AsyncJobMailbox always populates `jobId`.
							taskId: cd.handle.job.id,
							...(kind !== undefined ? { kind } : {}),
						});
					}
				}
				break;
			}
			case "agent_end": {
				cd.resolveEnded();
				break;
			}
			default:
				break;
		}
	}

	private async ensureAgent(): Promise<PersistentAgent> {
		if (this.agent) return this.agent;
		if (this.spawning) return this.spawning;
		if (this.spawnError) throw new Error(this.spawnError);

		this.spawning = (async () => {
			try {
				const { agent, dispose } = await this.deps.spawnAgent(this.ctx);
				this.agent = agent;
				this.agentDispose = dispose;
				this.unsubscribe = agent.onEvent((event) => this.handleEvent(event));
				return agent;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.spawnError = msg;
				throw err;
			} finally {
				this.spawning = null;
			}
		})();
		return this.spawning;
	}

	private async disposeAgent(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		const dispose = this.agentDispose;
		this.agentDispose = null;
		this.agent = null;
		if (dispose) {
			try {
				await dispose();
			} catch {
				/* best-effort */
			}
		}
	}
}
