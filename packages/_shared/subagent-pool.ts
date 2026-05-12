import * as fs from "node:fs";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { RpcClient } from "@mariozechner/pi-coding-agent";

type RpcEventListener = (event: AgentEvent) => void;

/**
 * Unified subagent pool — manages persistent and one-shot RPC agents.
 *
 * Persistent agents stay alive across multiple prompts (used by the
 * reviewer pipeline during plan execution). One-shot agents are
 * syntactic sugar: spawn → prompt → waitForIdle → collect → dispose.
 *
 * All agents get usage tracking and optional progress callbacks via
 * the RPC event stream.
 */

// ---- Types ------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/**
 * Progress event emitted during agent execution. Callers use this
 * to drive TUI widget updates.
 */
export interface AgentProgress {
	agentId: string;
	/** Most recent tool call name (e.g. "read", "grep"). */
	lastToolCall?: string;
	/** Human-readable one-liner describing the last tool invocation. */
	lastToolSummary?: string;
	/** True when the agent is actively processing. */
	busy: boolean;
	/** Accumulated usage so far. */
	usage: UsageStats;
}

export interface AgentConfig {
	provider: string;
	model: string;
	/** Path to a markdown system prompt file (appended). */
	systemPromptPath: string;
	/** Tool set the agent may use. Defaults to read-only. */
	tools?: readonly string[];
	/** Working directory for the agent process. */
	cwd: string;
	/** Follow-up mode: "one-at-a-time" ensures each queued message
	 *  triggers its own turn. Default: "one-at-a-time". */
	followUpMode?: "all" | "one-at-a-time";
	/** Extra CLI args appended after `--tools`/`--append-system-prompt`.
	 *  Used by callers that need to load a custom extension into the
	 *  sub-agent process (e.g. to register a notify tool the parent
	 *  observes via the event stream). */
	extraArgs?: readonly string[];
	/** Optional progress callback invoked on tool calls and turn ends. */
	onProgress?: (progress: AgentProgress) => void;
}

export interface OneshotTask {
	/** Pre-assembled task payload. */
	task: string;
	/** Path to a markdown system prompt file (appended). */
	systemPromptPath: string;
	provider: string;
	model: string;
	/** Tool set. Defaults to read-only. */
	tools?: readonly string[];
	cwd: string;
	/** Timeout for the entire operation (spawn through collect). */
	timeoutMs?: number;
	/** Optional progress callback. */
	onProgress?: (progress: AgentProgress) => void;
}

export interface OneshotResult {
	/** The agent's last assistant text. */
	text: string;
	/** Populated on error (timeout, crash, abort). */
	error?: string;
	/** Token usage and cost. */
	usage: UsageStats;
}

// ---- Helpers ----------------------------------------------------------------

const DEFAULT_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
}

/**
 * Resolve the pi CLI entry point. Matches the pattern used by pi's
 * built-in subagent example and @tintinweb/pi-subagents.
 */
function getCliPath(): string | undefined {
	const currentScript = process.argv[1];
	if (!currentScript) return undefined;
	if (currentScript.startsWith("/$bunfs/root/")) return undefined;
	if (!fs.existsSync(currentScript)) return undefined;
	return currentScript;
}

/** Summarise a tool call for progress display. */
function summariseToolCall(
	name: string,
	args: Record<string, unknown>,
): string {
	switch (name) {
		case "bash": {
			const cmd = String(args.command ?? "").split("\n")[0];
			return cmd.length > 50 ? `$ ${cmd.slice(0, 50)}…` : `$ ${cmd}`;
		}
		case "read":
			return `read ${args.path ?? args.file_path ?? ""}`;
		case "grep":
			return `grep /${args.pattern ?? ""}/ in ${args.path ?? "."}`;
		case "find":
			return `find ${args.pattern ?? "*"} in ${args.path ?? "."}`;
		case "ls":
			return `ls ${args.path ?? "."}`;
		default:
			return name;
	}
}

// ---- PersistentAgent --------------------------------------------------------

export class PersistentAgent {
	readonly id: string;
	private client: RpcClient;
	private config: AgentConfig;
	private _usage: UsageStats = emptyUsage();
	private _busy = false;
	private _disposed = false;
	private unsubscribe: (() => void) | undefined;
	private externalListeners = new Set<RpcEventListener>();

	constructor(id: string, client: RpcClient, config: AgentConfig) {
		this.id = id;
		this.client = client;
		this.config = config;

		this.unsubscribe = client.onEvent((event: AgentEvent) => {
			this.handleEvent(event);
		});
	}

	get usage(): UsageStats {
		return { ...this._usage };
	}

	get busy(): boolean {
		return this._busy;
	}

	get disposed(): boolean {
		return this._disposed;
	}

	/**
	 * Subscribe to the raw RPC event stream. Returns an unsubscribe
	 * function. Listeners run after the pool's internal bookkeeping.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.externalListeners.add(listener);
		return () => {
			this.externalListeners.delete(listener);
		};
	}

	/** Send a prompt. If the agent is idle, starts a new turn. */
	async prompt(message: string): Promise<void> {
		this.assertAlive();
		this._busy = true;
		await this.client.prompt(message);
	}

	/**
	 * Queue a message as a follow-up. Delivered after the current turn
	 * finishes. Safe to call while the agent is busy.
	 */
	async followUp(message: string): Promise<void> {
		this.assertAlive();
		await this.client.followUp(message);
	}

	/** Wait for the agent to become idle (all turns complete). */
	async waitForIdle(timeoutMs?: number): Promise<void> {
		this.assertAlive();
		await this.client.waitForIdle(timeoutMs);
		this._busy = false;
	}

	/** Get the last assistant message text. */
	async getLastText(): Promise<string | null> {
		this.assertAlive();
		return this.client.getLastAssistantText();
	}

	/** Compact the agent's context. */
	async compact(instructions?: string): Promise<void> {
		this.assertAlive();
		await this.client.compact(instructions);
	}

	/**
	 * Start a fresh session (wipes context). The process stays alive
	 * but all prior conversation is discarded.
	 */
	async reset(): Promise<void> {
		this.assertAlive();
		await this.client.newSession();
		this._usage = emptyUsage();
	}

	/** Kill the agent process. */
	async dispose(): Promise<void> {
		if (this._disposed) return;
		this._disposed = true;
		this.unsubscribe?.();
		try {
			await this.client.stop();
		} catch {
			/* best-effort */
		}
	}

	private assertAlive(): void {
		if (this._disposed) {
			throw new Error(`Agent "${this.id}" has been disposed`);
		}
	}

	private handleEvent(event: AgentEvent): void {
		if (event.type === "agent_end") {
			this._busy = false;
			this.emitProgress();
		}

		// Fan out to external subscribers. Wrap each in try/catch so a
		// throwing listener doesn't break sibling subscribers or the pool's
		// own bookkeeping below.
		for (const listener of this.externalListeners) {
			try {
				listener(event);
			} catch {
				/* best-effort */
			}
		}

		if (event.type === "message_end") {
			const msg = event.message as unknown as Record<string, unknown>;
			if (msg.role === "assistant") {
				this._usage.turns++;
				const usage = msg.usage as Record<string, unknown> | undefined;
				if (usage) {
					this._usage.input += Number(usage.input) || 0;
					this._usage.output += Number(usage.output) || 0;
					this._usage.cacheRead += Number(usage.cacheRead) || 0;
					this._usage.cacheWrite += Number(usage.cacheWrite) || 0;
					const costObj = usage.cost as Record<string, unknown> | undefined;
					this._usage.cost += Number(costObj?.total) || 0;
				}
			}
			this.emitProgress();
		}

		if (event.type === "tool_execution_start") {
			const toolName = event.toolName;
			const args = (event.args ?? {}) as Record<string, unknown>;
			this.config.onProgress?.({
				agentId: this.id,
				lastToolCall: toolName,
				lastToolSummary: summariseToolCall(toolName, args),
				busy: true,
				usage: { ...this._usage },
			});
		}
	}

	private emitProgress(): void {
		this.config.onProgress?.({
			agentId: this.id,
			busy: this._busy,
			usage: { ...this._usage },
		});
	}
}

// ---- SubagentPool -----------------------------------------------------------

export class SubagentPool {
	private agents = new Map<string, PersistentAgent>();

	/**
	 * Spawn a persistent agent. Starts the RPC process and returns
	 * a handle for repeated interaction.
	 */
	async spawn(id: string, config: AgentConfig): Promise<PersistentAgent> {
		if (this.agents.has(id)) {
			throw new Error(`Agent "${id}" already exists in pool`);
		}

		const tools = (config.tools ?? DEFAULT_TOOLS).join(",");
		const cliPath = getCliPath();
		const extraArgs = config.extraArgs ?? [];

		const client = new RpcClient({
			...(cliPath ? { cliPath } : {}),
			cwd: config.cwd,
			provider: config.provider,
			model: config.model,
			args: [
				"--no-session",
				"--tools",
				tools,
				"--append-system-prompt",
				config.systemPromptPath,
				...extraArgs,
			],
		});

		await client.start();

		// Set follow-up mode so queued prompts trigger individual turns.
		const followUpMode = config.followUpMode ?? "one-at-a-time";
		await client.setFollowUpMode(followUpMode);

		const agent = new PersistentAgent(id, client, config);
		this.agents.set(id, agent);
		return agent;
	}

	/** Get a previously spawned agent by ID. */
	get(id: string): PersistentAgent | undefined {
		return this.agents.get(id);
	}

	/** Check if an agent exists in the pool. */
	has(id: string): boolean {
		return this.agents.has(id);
	}

	/** Number of agents in the pool. */
	get size(): number {
		return this.agents.size;
	}

	/**
	 * One-shot convenience: spawn an ephemeral agent, prompt it, wait
	 * for completion, collect the result, and dispose.
	 */
	async oneshot(task: OneshotTask): Promise<OneshotResult> {
		const id = `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const usage = emptyUsage();

		let agent: PersistentAgent | undefined;
		try {
			agent = await this.spawn(id, {
				provider: task.provider,
				model: task.model,
				systemPromptPath: task.systemPromptPath,
				tools: task.tools,
				cwd: task.cwd,
				onProgress: task.onProgress,
			});

			await agent.prompt(task.task);
			await agent.waitForIdle(task.timeoutMs);
			const text = (await agent.getLastText()) ?? "";

			return {
				text,
				usage: agent.usage,
			};
		} catch (err) {
			return {
				text: "",
				error: err instanceof Error ? err.message : String(err),
				usage: agent?.usage ?? usage,
			};
		} finally {
			if (agent) {
				await agent.dispose();
				this.agents.delete(id);
			}
		}
	}

	/** Shut down all agents in the pool. */
	async dispose(): Promise<void> {
		const disposals = [...this.agents.values()].map((a) => a.dispose());
		await Promise.allSettled(disposals);
		this.agents.clear();
	}
}
