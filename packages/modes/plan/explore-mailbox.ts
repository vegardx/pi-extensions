/**
 * Async mailbox for the codebase-exploration sub-agent.
 *
 * #159a introduced send/receive: ask returns immediately, check drains
 * answers, wait blocks opt-in. #159b adds the seed-and-children dispatch
 * model:
 *
 *   - Seed worker: a single persistent sub-agent owns the accumulating
 *     exploration context. New `explore_ask` jobs default to dispatching
 *     against the seed (FIFO).
 *   - Children: when the caller marks a question `related: false` AND
 *     the seed is busy, the mailbox spawns a short-lived child agent
 *     pre-loaded with a Q/A snapshot of recent seed exchanges. The
 *     child runs in parallel with the seed.
 *   - Graceful degradation: when no child spawner is configured, or
 *     when the child enqueue throws, the question falls back to the
 *     seed FIFO. Existing single-question flows keep their original
 *     wall-clock + context-accumulation behaviour.
 *
 * #159b open question (deferred to reviewer): the topic-relatedness
 * heuristic. This implementation chooses **explicit `related: boolean`**
 * — cheapest, predictable, no extra LLM calls. The agent decides via
 * the `explore_ask` parameter; the mailbox doesn't introspect the
 * question text. The context-snapshot scope is the **last 6 Q/A pairs
 * char-budgeted to ~3000 characters**, fed via the child's first prompt
 * (we have no API to mutate the system prompt of an already-spawned
 * agent).
 *
 * Internals: two {@link AsyncJobMailbox} instances backing one public
 * `ExploreMailbox`:
 *
 *   - `seedMailbox`  — `maxConcurrent: 1`, persistent agent, id prefix `q`.
 *   - `childMailbox` — `maxConcurrent: Infinity`, ephemeral per-job
 *     agents, id prefix `c`.
 *
 * Public surface (ask / check / wait / onChange / getState / dispose)
 * merges results across both. ID prefix tells callers which mailbox
 * owns the job.
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
	/** "seed" or "child" — which inner mailbox dispatched this job. */
	worker?: "seed" | "child";
}

export interface ExploreNotification extends BaseNotification {
	/** Task that was running when the sub-agent emitted the notify. */
	taskId?: string;
}

/** Caller-supplied flags on each ask. */
export interface AskOptions {
	/**
	 * Default `true`. When the agent knows its next question is
	 * orthogonal to recent seed work it can pass `related: false`,
	 * which lets the mailbox dispatch against a fresh child agent
	 * (in parallel with the seed) instead of queueing behind it.
	 *
	 * Children are only spawned when the seed is *busy*; when the
	 * seed is idle, `related: false` still goes through the seed so
	 * the answer accumulates into shared context.
	 */
	related?: boolean;
}

/**
 * Default values for {@link ExploreMailboxOptions}. `parallelism: 1`
 * preserves pre-#159c behaviour: the child mailbox stays disabled even
 * when {@link MailboxDeps.spawnChildAgent} is configured (the seed +
 * one running child would already exceed the cap).
 */
export const DEFAULT_PARALLELISM = 1;
export const DEFAULT_QUEUE_DEPTH_THRESHOLD = 4;

export interface ExploreMailboxOptions {
	/**
	 * Maximum simultaneous in-flight explore jobs across the seed
	 * and any children. The seed counts as one slot; the remaining
	 * `parallelism - 1` slots are available to children.
	 *
	 * `1` (default) keeps the pre-#159c single-FIFO behaviour: even
	 * `related: false` asks queue behind the seed because there's no
	 * spare slot for a child.
	 */
	parallelism?: number;
	/**
	 * Burst-mode trigger. When the seed mailbox has at least this many
	 * jobs queued-or-running at ask time, the next ask routes to a
	 * child *regardless of* the `related` hint — fanning out beats
	 * waiting in line.
	 *
	 * Has no effect when `parallelism: 1` (no children allowed) or
	 * when the per-call parallelism cap is already saturated.
	 */
	queueDepthThreshold?: number;
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

export interface SpawnedAgent {
	agent: PersistentAgent;
	dispose: () => Promise<void>;
}

export interface MailboxDeps {
	/**
	 * Spawn the seed sub-agent (long-lived, owns context). Injectable
	 * so tests can stub the underlying SubagentPool.
	 */
	spawnAgent(ctx: ExtensionContext): Promise<SpawnedAgent>;
	/**
	 * Spawn a short-lived child sub-agent for orthogonal queries.
	 * Optional: when omitted, `related: false` falls back to the seed
	 * FIFO. The child agent shares the seed's system prompt and tool
	 * set; the snapshot is delivered via the first prompt (we cannot
	 * mutate the system prompt post-spawn).
	 */
	spawnChildAgent?(ctx: ExtensionContext): Promise<SpawnedAgent>;
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

/** Max prior Q/A pairs surfaced to a child as context. */
const SNAPSHOT_MAX_PAIRS = 6;
/** Approximate char budget for the rendered Q/A snapshot. */
const SNAPSHOT_CHAR_BUDGET = 3000;
/** Per-entry char cap before truncation when assembling a snapshot. */
const SNAPSHOT_PER_ENTRY_BUDGET = 600;

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

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1).trimEnd()}…`;
}

interface JournalEntry {
	question: string;
	answer: string;
}

/**
 * Render a Q/A journal as a system-context block prefix. Returns an
 * empty string when the journal is empty so callers can prepend
 * unconditionally.
 */
export function renderJournalForChild(journal: JournalEntry[]): string {
	if (journal.length === 0) return "";

	const recent = journal.slice(-SNAPSHOT_MAX_PAIRS);

	const blocks: string[] = [];
	let used = 0;
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = recent[i];
		if (!entry) continue;
		const q = truncate(entry.question, SNAPSHOT_PER_ENTRY_BUDGET);
		const a = truncate(entry.answer, SNAPSHOT_PER_ENTRY_BUDGET);
		const block = `Q: ${q}\nA: ${a}`;
		if (used + block.length + 2 > SNAPSHOT_CHAR_BUDGET && blocks.length > 0) {
			break;
		}
		blocks.unshift(block);
		used += block.length + 2;
	}

	const body = blocks.join("\n\n");
	return [
		"---- prior exploration context (read-only) ----",
		"The seed explore agent ran these queries earlier in this session.",
		"Treat them as background — do NOT redo their work; build on it.",
		"",
		body,
		"---- end prior exploration context ----",
		"",
		"Now answer the next question:",
		"",
	].join("\n");
}

// ---- Default deps -----------------------------------------------------------

/**
 * Spawn an explore sub-agent backed by `SubagentPool`. Loads the
 * `notify` tool extension via `--extension` and applies the
 * `one-at-a-time` follow-up mode required for FIFO correlation.
 */
export function defaultMailboxDeps(): MailboxDeps {
	const buildSpawner = () => async (ctx: ExtensionContext) => {
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
	};

	return {
		spawnAgent: buildSpawner(),
		spawnChildAgent: buildSpawner(),
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
	private readonly parallelism: number;
	private readonly queueDepthThreshold: number;
	private readonly seedMailbox: AsyncJobMailbox<
		ExploreTask,
		ExploreNotification
	>;
	private readonly childMailbox: AsyncJobMailbox<
		ExploreTask,
		ExploreNotification
	>;

	private agent: PersistentAgent | null = null;
	private agentDispose: (() => Promise<void>) | null = null;
	private spawning: Promise<PersistentAgent> | null = null;
	private spawnError: string | null = null;
	private unsubscribe: (() => void) | null = null;
	/**
	 * Currently in-flight seed dispatch. Set when `dispatchSeed`
	 * begins, cleared on agent_end (or abort). The shared listener on
	 * the seed agent routes events through this slot. Single-slot is
	 * sufficient because the seed mailbox runs `maxConcurrent: 1`.
	 */
	private currentDispatch: CurrentDispatch | null = null;

	/** Q/A journal of completed seed exchanges (newest at end). */
	private readonly journal: JournalEntry[] = [];

	private readonly externalListeners = new Set<
		(state: MailboxState<ExploreTask, ExploreNotification>) => void
	>();
	private readonly listenerUnsubs: (() => void)[] = [];

	constructor(
		ctx: ExtensionContext,
		deps: MailboxDeps = defaultMailboxDeps(),
		opts: ExploreMailboxOptions = {},
	) {
		this.ctx = ctx;
		this.deps = deps;
		this.parallelism = sanitiseParallelism(opts.parallelism);
		this.queueDepthThreshold = sanitiseQueueDepthThreshold(
			opts.queueDepthThreshold,
		);

		this.seedMailbox = new AsyncJobMailbox<ExploreTask, ExploreNotification>({
			kind: "explore-seed",
			// Preserve the pre-#159a id scheme (`q1`, `q2`, ...).
			idPrefix: "q",
			maxConcurrent: 1,
			defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
			synthesizeUnknown: () => ({ question: "" }),
			dispatch: (handle) => this.dispatchSeed(handle),
			onDispose: () => this.disposeAgent(),
		});

		this.childMailbox = new AsyncJobMailbox<ExploreTask, ExploreNotification>({
			kind: "explore-child",
			idPrefix: "c",
			// Children are independent ephemeral processes.
			maxConcurrent: Number.POSITIVE_INFINITY,
			defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
			synthesizeUnknown: () => ({ question: "" }),
			dispatch: (handle) => this.dispatchChild(handle),
		});

		// Forward inner state to external listeners as a merged snapshot.
		this.listenerUnsubs.push(
			this.seedMailbox.onChange(() => this.emitMerged()),
		);
		this.listenerUnsubs.push(
			this.childMailbox.onChange(() => this.emitMerged()),
		);
	}

	/** Subscribe to mailbox state changes. Returns an unsubscribe fn. */
	onChange(
		listener: (state: MailboxState<ExploreTask, ExploreNotification>) => void,
	): () => void {
		this.externalListeners.add(listener);
		return () => {
			this.externalListeners.delete(listener);
		};
	}

	/**
	 * Enqueue a question.
	 *
	 * Routing:
	 *   - `opts.related === false` AND seed has an in-flight job AND
	 *     `deps.spawnChildAgent` is configured → child mailbox.
	 *   - Otherwise → seed mailbox.
	 *
	 * If child enqueue throws unexpectedly we still fall through to the
	 * seed FIFO. In practice this only fires for synchronous defects in
	 * the child mailbox that the seed mailbox doesn't share — disposal
	 * tears both down together, so a "mailbox disposed" failure on the
	 * child would also trip the seed fallback. The catch is defensive,
	 * not a graceful-disposal path.
	 */
	async ask(question: string, opts: AskOptions = {}): Promise<{ id: string }> {
		const seedBusy = this.seedMailbox.hasInFlight;
		const childAvailable = typeof this.deps.spawnChildAgent === "function";
		const maxChildren = Math.max(0, this.parallelism - 1);
		const childInFlight = this.countInFlight(this.childMailbox);
		const capRoom = childInFlight < maxChildren;
		const seedDepth = this.countInFlight(this.seedMailbox);
		const burst = seedDepth >= this.queueDepthThreshold;
		const orthogonal = opts.related === false;

		const wantsChild =
			childAvailable && seedBusy && capRoom && (orthogonal || burst);

		if (wantsChild) {
			try {
				return this.childMailbox.enqueue((id, enqueuedAt) => ({
					id,
					question,
					status: "queued" as TaskStatus,
					enqueuedAt,
					worker: "child",
				}));
			} catch {
				// fall through to seed
			}
		}

		return this.seedMailbox.enqueue((id, enqueuedAt) => ({
			id,
			question,
			status: "queued" as TaskStatus,
			enqueuedAt,
			worker: "seed",
		}));
	}

	check(
		opts: CheckOptions = {},
	): CheckResult<ExploreTask, ExploreNotification> {
		// `id`-targeted lookup: route to whichever mailbox owns it.
		if (opts.id) {
			const fromSeed = this.seedMailbox.check({ id: opts.id });
			if (fromSeed.tasks.length > 0) return fromSeed;
			return this.childMailbox.check({ id: opts.id });
		}

		const seedResult = this.seedMailbox.check(opts);
		const childResult = this.childMailbox.check(opts);
		return {
			tasks: [...seedResult.tasks, ...childResult.tasks],
			notifications: [
				...seedResult.notifications,
				...childResult.notifications,
			],
		};
	}

	async wait(
		id: string,
		timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
	): Promise<ExploreTask> {
		// Route by ownership rather than id-prefix literal: ask each inner
		// mailbox via a synchronous `check({ id })` whether it knows the id,
		// then `wait()` on the owner. Falls back to seed for unknown ids so
		// the unknown-id error still surfaces with the seed's mailbox kind.
		if (this.childMailbox.check({ id }).tasks.length > 0) {
			return this.childMailbox.wait(id, timeoutMs);
		}
		return this.seedMailbox.wait(id, timeoutMs);
	}

	get hasInFlight(): boolean {
		return this.seedMailbox.hasInFlight || this.childMailbox.hasInFlight;
	}

	getState(): MailboxState<ExploreTask, ExploreNotification> {
		return this.mergedState();
	}

	async dispose(): Promise<void> {
		for (const u of this.listenerUnsubs) u();
		this.listenerUnsubs.length = 0;
		// Drop external subscribers so closures they captured can be GC'd.
		this.externalListeners.clear();
		await Promise.allSettled([
			this.seedMailbox.dispose(),
			this.childMailbox.dispose(),
		]);
	}

	// ---- internals --------------------------------------------------------

	private mergedState(): MailboxState<ExploreTask, ExploreNotification> {
		const seed = this.seedMailbox.getState();
		const child = this.childMailbox.getState();
		// Notification ids are generated per-inner-mailbox starting at 1, so
		// the merged stream would contain colliding ids (e.g. seed's `n1`
		// alongside child's `n1`). Re-namespace them under the mailbox kind
		// so consumers using `notification.id` as a unique key (dedup, Map
		// storage, React keys) see globally-unique values.
		const seedNotifs = seed.notifications.map((n) => ({
			...n,
			id: `seed-${n.id}`,
		}));
		const childNotifs = child.notifications.map((n) => ({
			...n,
			id: `child-${n.id}`,
		}));
		return {
			tasks: [...seed.tasks, ...child.tasks],
			notifications: [...seedNotifs, ...childNotifs],
		};
	}

	/**
	 * Count jobs that are queued or running on `mailbox`. Terminal
	 * tasks (done/error/timeout) are excluded — they don't consume a
	 * slot any more.
	 */
	private countInFlight(
		mailbox: AsyncJobMailbox<ExploreTask, ExploreNotification>,
	): number {
		const { tasks } = mailbox.getState();
		let n = 0;
		for (const t of tasks) {
			if (t.status === "queued" || t.status === "running") n++;
		}
		return n;
	}

	private emitMerged(): void {
		if (this.externalListeners.size === 0) return;
		const state = this.mergedState();
		for (const listener of this.externalListeners) {
			try {
				listener(state);
			} catch {
				/* best-effort */
			}
		}
	}

	/**
	 * Seed dispatcher (formerly the only dispatcher in #159a). Runs
	 * the question against the persistent agent, captures notify()
	 * calls via the shared event listener, and records the (Q, A)
	 * pair in the journal for later child snapshots.
	 */
	private async dispatchSeed(
		handle: DispatchHandle<ExploreTask, ExploreNotification>,
	): Promise<{ text: string }> {
		let resolveEnded!: () => void;
		let rejectEnded!: (err: Error) => void;
		const ended = new Promise<void>((resolve, reject) => {
			resolveEnded = resolve;
			rejectEnded = reject;
		});
		ended.catch(() => {});
		// Set synchronously before any await — see #159a microtask-ordering note.
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

			const text = (await agent.getLastText()) ?? "";
			handle.update({ lastToolSummary: undefined });

			// Record into the journal so future children get context.
			this.journal.push({ question: handle.job.question, answer: text });
			// Cap the journal at the same window the renderer reads so we
			// don't accumulate entries no consumer ever sees.
			if (this.journal.length > SNAPSHOT_MAX_PAIRS) {
				this.journal.splice(0, this.journal.length - SNAPSHOT_MAX_PAIRS);
			}

			return { text };
		} finally {
			handle.signal.removeEventListener("abort", onAbort);
			this.currentDispatch = null;
		}
	}

	/**
	 * Child dispatcher: spawns a fresh ephemeral agent, prompts it
	 * with a snapshot-prefixed question, captures notify() calls via
	 * a per-job event listener, returns the answer, then disposes the
	 * agent. Child results do NOT feed back into the journal (only
	 * seed exchanges accumulate context).
	 */
	private async dispatchChild(
		handle: DispatchHandle<ExploreTask, ExploreNotification>,
	): Promise<{ text: string }> {
		const spawn = this.deps.spawnChildAgent;
		if (!spawn) {
			throw new Error(
				"explore child dispatcher invoked without spawnChildAgent dep",
			);
		}

		let resolveEnded!: () => void;
		let rejectEnded!: (err: Error) => void;
		const ended = new Promise<void>((resolve, reject) => {
			resolveEnded = resolve;
			rejectEnded = reject;
		});
		ended.catch(() => {});

		const onAbort = () => {
			rejectEnded(new Error("explore child dispatch aborted"));
		};
		handle.signal.addEventListener("abort", onAbort);

		let agent:
			| Awaited<
					ReturnType<NonNullable<MailboxDeps["spawnChildAgent"]>>
			  >["agent"]
			| null = null;
		let dispose: (() => Promise<void>) | null = null;
		let unsubscribe: (() => void) | null = null;
		try {
			// spawn() can reject; do it inside the try so the abort listener
			// is unconditionally cleaned up in `finally`.
			const spawned = await spawn(this.ctx);
			agent = spawned.agent;
			dispose = spawned.dispose;
			unsubscribe = agent.onEvent((event) =>
				this.handleChildEvent(event, handle, resolveEnded),
			);

			if (handle.signal.aborted) {
				throw new Error("aborted before dispatch");
			}
			const prefix = renderJournalForChild(this.journal);
			const finalPrompt =
				prefix.length > 0 ? prefix + handle.job.question : handle.job.question;
			await agent.prompt(finalPrompt);
			await ended;

			const text = (await agent.getLastText()) ?? "";
			handle.update({ lastToolSummary: undefined });
			return { text };
		} finally {
			handle.signal.removeEventListener("abort", onAbort);
			unsubscribe?.();
			if (dispose) {
				try {
					await dispose();
				} catch {
					/* best-effort */
				}
			}
		}
	}

	private handleChildEvent(
		event: AgentEvent,
		handle: DispatchHandle<ExploreTask, ExploreNotification>,
		resolveEnded: () => void,
	): void {
		switch (event.type) {
			case "agent_start":
				handle.setRunning();
				break;
			case "tool_execution_start": {
				const args = (event.args ?? {}) as Record<string, unknown>;
				handle.update({
					lastToolSummary: summariseToolCall(event.toolName, args),
				});
				if (event.toolName === "notify") {
					const text = typeof args.text === "string" ? args.text : "";
					if (text.length > 0) {
						const kind = typeof args.kind === "string" ? args.kind : undefined;
						handle.notify({
							text,
							taskId: handle.job.id,
							...(kind !== undefined ? { kind } : {}),
						});
					}
				}
				break;
			}
			case "agent_end":
				resolveEnded();
				break;
			default:
				break;
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

/**
 * Coerce a user-supplied parallelism value into a positive integer.
 * Invalid values fall back to {@link DEFAULT_PARALLELISM} \u2014 callers
 * surface the warning to the user before constructing the mailbox.
 */
export function sanitiseParallelism(raw: unknown): number {
	if (typeof raw !== "number") return DEFAULT_PARALLELISM;
	if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PARALLELISM;
	return Math.floor(raw);
}

/**
 * Coerce a user-supplied queueDepthThreshold value into a positive
 * integer. Invalid values fall back to
 * {@link DEFAULT_QUEUE_DEPTH_THRESHOLD}.
 */
export function sanitiseQueueDepthThreshold(raw: unknown): number {
	if (typeof raw !== "number") return DEFAULT_QUEUE_DEPTH_THRESHOLD;
	if (!Number.isFinite(raw) || raw < 1) return DEFAULT_QUEUE_DEPTH_THRESHOLD;
	return Math.floor(raw);
}
