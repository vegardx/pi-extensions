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
 * Correlation rule: relies on the RPC client's `one-at-a-time`
 * follow-up mode. Each queued prompt produces exactly one
 * `agent_start` … `agent_end` cycle. We track tasks in FIFO order;
 * `agent_start` advances the head to "running", `agent_end` resolves
 * it with the agent's last assistant text.
 *
 * `notify()` channel: a tiny extension shipped via `--extension`
 * registers a `notify({ text, kind? })` tool inside the sub-agent
 * process. The handler is a no-op; we observe the call via the
 * `tool_execution_start` event on the parent side and surface the
 * args on the next `check()`.
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

// ---- Public types -----------------------------------------------------------

export type TaskStatus = "queued" | "running" | "done" | "error" | "timeout";

export interface ExploreTask {
	id: string;
	question: string;
	status: TaskStatus;
	text?: string;
	error?: string;
	enqueuedAt: number;
	startedAt?: number;
	endedAt?: number;
	/** Last tool the sub-agent invoked; for the live status widget. */
	lastToolSummary?: string;
}

export interface ExploreNotification {
	id: string;
	text: string;
	kind?: string;
	/** Task that was running when the sub-agent emitted the notify. */
	taskId?: string;
	at: number;
}

export interface CheckOptions {
	/** When set, return only this task; do not drain. */
	id?: string;
	/** Default true — remove returned terminal tasks/notifications. */
	drain?: boolean;
}

export interface CheckResult {
	tasks: ExploreTask[];
	notifications: ExploreNotification[];
}

export interface MailboxState {
	tasks: ExploreTask[];
	notifications: ExploreNotification[];
}

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

interface Waiter {
	resolve: (task: ExploreTask) => void;
	timer?: NodeJS.Timeout;
}

export class ExploreMailbox {
	private readonly ctx: ExtensionContext;
	private readonly deps: MailboxDeps;

	private tasks: ExploreTask[] = [];
	private taskById = new Map<string, ExploreTask>();
	private notifications: ExploreNotification[] = [];

	private agent: PersistentAgent | null = null;
	private agentDispose: (() => Promise<void>) | null = null;
	private spawning: Promise<PersistentAgent> | null = null;
	private spawnError: string | null = null;
	private unsubscribe: (() => void) | null = null;

	private nextTaskNum = 1;
	private nextNotifyNum = 1;
	private hasPrompted = false;
	/** Head of the queued FIFO that the next `agent_start` will activate. */
	private runningTaskId: string | null = null;
	private waiters = new Map<string, Waiter[]>();
	private listeners = new Set<(state: MailboxState) => void>();
	private disposed = false;

	constructor(ctx: ExtensionContext, deps: MailboxDeps = defaultMailboxDeps()) {
		this.ctx = ctx;
		this.deps = deps;
	}

	/** Subscribe to mailbox state changes. Returns an unsubscribe fn. */
	onChange(listener: (state: MailboxState) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Enqueue a question. Spawns the sub-agent on first call. Returns
	 * immediately with a task id — never blocks on the answer.
	 */
	async ask(question: string): Promise<{ id: string }> {
		if (this.disposed) throw new Error("ExploreMailbox is disposed");

		const id = `q${this.nextTaskNum++}`;
		const task: ExploreTask = {
			id,
			question,
			status: "queued",
			enqueuedAt: Date.now(),
		};
		this.tasks.push(task);
		this.taskById.set(id, task);
		this.emit();

		try {
			const agent = await this.ensureAgent();
			if (!this.hasPrompted) {
				this.hasPrompted = true;
				await agent.prompt(question);
			} else {
				await agent.followUp(question);
			}
		} catch (err) {
			task.status = "error";
			task.error = err instanceof Error ? err.message : String(err);
			task.endedAt = Date.now();
			this.resolveWaiters(task);
			this.emit();
		}

		return { id };
	}

	/**
	 * Drain the mailbox. With no `id`, returns all terminal tasks plus
	 * any pending tasks (so the caller sees status), and drains
	 * notifications. With `id`, returns just that one and never drains.
	 */
	check(opts: CheckOptions = {}): CheckResult {
		const drain = opts.drain ?? true;

		if (opts.id) {
			const task = this.taskById.get(opts.id);
			return {
				tasks: task ? [snapshot(task)] : [],
				notifications: [],
			};
		}

		const taskSnapshots = this.tasks.map(snapshot);
		const notificationSnapshots = this.notifications.map((n) => ({ ...n }));

		if (drain) {
			// Remove only terminal tasks; keep queued/running so the next
			// check can observe the rest of their lifecycle.
			const terminal = new Set(["done", "error", "timeout"]);
			this.tasks = this.tasks.filter((t) => {
				if (terminal.has(t.status)) {
					this.taskById.delete(t.id);
					return false;
				}
				return true;
			});
			this.notifications = [];
			this.emit();
		}

		return { tasks: taskSnapshots, notifications: notificationSnapshots };
	}

	/**
	 * Block until the named task reaches a terminal state, or the
	 * timeout fires. On timeout, the task is marked `timeout` but the
	 * underlying agent keeps running — the next `check`/`wait` may
	 * still observe the eventual completion.
	 */
	async wait(
		id: string,
		timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
	): Promise<ExploreTask> {
		if (this.disposed) throw new Error("ExploreMailbox is disposed");

		const task = this.taskById.get(id);
		if (!task) {
			return {
				id,
				question: "",
				status: "error",
				error: `unknown task id: ${id}`,
				enqueuedAt: Date.now(),
				endedAt: Date.now(),
			};
		}
		if (isTerminal(task.status)) return snapshot(task);

		return new Promise<ExploreTask>((resolve) => {
			let settled = false;
			const settle = (t: ExploreTask) => {
				if (settled) return;
				settled = true;
				if (waiter.timer) clearTimeout(waiter.timer);
				resolve(t);
			};
			const waiter: Waiter = {
				resolve: (t) => settle(snapshot(t)),
			};
			waiter.timer = setTimeout(() => {
				// Don't mutate the task itself — it may still complete.
				// Surface the timeout to the caller as a synthetic
				// terminal record; future `check` calls will still see
				// the real outcome.
				settle({
					...snapshot(task),
					status: "timeout",
					error: `wait(${id}) timed out after ${timeoutMs}ms`,
					endedAt: Date.now(),
				});
				const arr = this.waiters.get(id);
				if (arr) {
					const idx = arr.indexOf(waiter);
					if (idx >= 0) arr.splice(idx, 1);
				}
			}, timeoutMs);
			const arr = this.waiters.get(id) ?? [];
			arr.push(waiter);
			this.waiters.set(id, arr);
		});
	}

	/** True if any task is currently queued or running. */
	get hasInFlight(): boolean {
		return this.tasks.some((t) => !isTerminal(t.status));
	}

	/** Read-only snapshot of the mailbox state. */
	getState(): MailboxState {
		return {
			tasks: this.tasks.map(snapshot),
			notifications: this.notifications.map((n) => ({ ...n })),
		};
	}

	/** Tear down. Best-effort. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		for (const arr of this.waiters.values()) {
			for (const w of arr) {
				if (w.timer) clearTimeout(w.timer);
			}
		}
		this.waiters.clear();
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

	// ---- internals --------------------------------------------------------

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

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start": {
				const next = this.tasks.find((t) => t.status === "queued");
				if (next) {
					next.status = "running";
					next.startedAt = Date.now();
					this.runningTaskId = next.id;
					this.emit();
				}
				break;
			}
			case "agent_end": {
				if (this.runningTaskId) {
					const task = this.taskById.get(this.runningTaskId);
					this.runningTaskId = null;
					if (task) void this.completeTask(task);
				}
				break;
			}
			case "tool_execution_start": {
				const args = (event.args ?? {}) as Record<string, unknown>;
				const running = this.runningTaskId
					? this.taskById.get(this.runningTaskId)
					: undefined;
				if (running) {
					running.lastToolSummary = summariseToolCall(event.toolName, args);
					this.emit();
				}
				if (event.toolName === "notify") {
					const text = typeof args.text === "string" ? args.text : "";
					if (text.length > 0) {
						const kind = typeof args.kind === "string" ? args.kind : undefined;
						const note: ExploreNotification = {
							id: `n${this.nextNotifyNum++}`,
							text,
							at: Date.now(),
							...(kind !== undefined ? { kind } : {}),
							...(running ? { taskId: running.id } : {}),
						};
						this.notifications.push(note);
						this.emit();
					}
				}
				break;
			}
			default:
				break;
		}
	}

	private async completeTask(task: ExploreTask): Promise<void> {
		try {
			const text = (await this.agent?.getLastText()) ?? "";
			task.text = text;
			task.status = "done";
		} catch (err) {
			task.error = err instanceof Error ? err.message : String(err);
			task.status = "error";
		}
		task.endedAt = Date.now();
		task.lastToolSummary = undefined;
		this.resolveWaiters(task);
		this.emit();
	}

	private resolveWaiters(task: ExploreTask): void {
		const arr = this.waiters.get(task.id);
		if (!arr) return;
		this.waiters.delete(task.id);
		for (const w of arr) {
			w.resolve(task);
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

// ---- helpers ----------------------------------------------------------------

function snapshot(task: ExploreTask): ExploreTask {
	return { ...task };
}

function isTerminal(status: TaskStatus): boolean {
	return status === "done" || status === "error" || status === "timeout";
}
