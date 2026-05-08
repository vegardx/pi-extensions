import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentProgress,
	PersistentAgent,
	SubagentPool,
	UsageStats,
} from "@vegardx/pi-extensions-shared/subagent-pool.js";
import { parseReviewerOutput, type RawFinding } from "./findings.js";

const REVIEWER_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"persistent-reviewer.md",
);

/** Context token threshold for mid-plan safety compaction. */
const COMPACT_THRESHOLD_TOKENS = 500_000;

// ---- Types ------------------------------------------------------------------

export interface ReviewerPoolConfig {
	/** The shared SubagentPool instance. */
	pool: SubagentPool;
	/** Primary model spec: "provider/id". */
	primary: { provider: string; model: string };
	/** Optional secondary model for cross-validation. */
	secondary?: { provider: string; model: string };
	/** Working directory for agent processes. */
	cwd: string;
	/** Optional progress callback (routed from agents). */
	onProgress?: (progress: AgentProgress) => void;
}

export interface StepReviewTask {
	/** Unified diff for this step. */
	diff: string;
	/** Human-readable description of what the step did. */
	stepDescription: string;
	/** Step number (1-based). */
	stepNumber: number;
}

export interface CollectedFindings {
	primary: RawFinding[];
	secondary?: RawFinding[];
	/** Aggregate usage across all reviewer agents. */
	usage: UsageStats;
}

// ---- ReviewerPool -----------------------------------------------------------

/**
 * Manages persistent reviewer agents that watch an implementation
 * unfold step-by-step. Spawns 1-2 agents at start, feeds them
 * incremental diffs, and collects accumulated findings at the end.
 */
export class ReviewerPool {
	private pool: SubagentPool;
	private config: ReviewerPoolConfig;
	private primaryAgent: PersistentAgent | null = null;
	private secondaryAgent: PersistentAgent | null = null;
	private started = false;

	constructor(config: ReviewerPoolConfig) {
		this.pool = config.pool;
		this.config = config;
	}

	/** Spawn persistent reviewer agents. Call once at /implement start. */
	async start(): Promise<void> {
		if (this.started) return;

		this.primaryAgent = await this.pool.spawn("reviewer-primary", {
			provider: this.config.primary.provider,
			model: this.config.primary.model,
			systemPromptPath: REVIEWER_PROMPT_PATH,
			cwd: this.config.cwd,
			followUpMode: "one-at-a-time",
			onProgress: this.config.onProgress,
		});

		if (this.config.secondary) {
			this.secondaryAgent = await this.pool.spawn("reviewer-secondary", {
				provider: this.config.secondary.provider,
				model: this.config.secondary.model,
				systemPromptPath: REVIEWER_PROMPT_PATH,
				cwd: this.config.cwd,
				followUpMode: "one-at-a-time",
				onProgress: this.config.onProgress,
			});
		}

		this.started = true;
	}

	/**
	 * Feed a completed step's diff to all running reviewers.
	 * Non-blocking — uses followUp() if the agent is still processing
	 * a previous step.
	 */
	async reviewStep(task: StepReviewTask): Promise<void> {
		if (!this.started) return;

		const message = buildStepMessage(task);

		// Use followUp if the agent is busy (queues for after current turn).
		// Use prompt if idle (starts a new turn immediately).
		const send = async (agent: PersistentAgent | null) => {
			if (!agent || agent.disposed) return;
			if (agent.busy) {
				await agent.followUp(message);
			} else {
				await agent.prompt(message);
			}
		};

		await Promise.all([send(this.primaryAgent), send(this.secondaryAgent)]);
	}

	/**
	 * Wait for all reviewers to finish and collect their accumulated
	 * findings. Call at plan completion.
	 */
	async collect(timeoutMs?: number): Promise<CollectedFindings> {
		const primaryFindings = await this.collectFrom(
			this.primaryAgent,
			timeoutMs,
		);
		const secondaryFindings = this.secondaryAgent
			? await this.collectFrom(this.secondaryAgent, timeoutMs)
			: undefined;

		const usage = this.aggregateUsage();

		return {
			primary: primaryFindings,
			...(secondaryFindings !== undefined
				? { secondary: secondaryFindings }
				: {}),
			usage,
		};
	}

	/**
	 * Check if any agent's context has grown beyond the safety
	 * threshold and compact it. Call between steps.
	 */
	async compactIfNeeded(): Promise<void> {
		for (const agent of this.activeAgents()) {
			if (agent.usage.input > COMPACT_THRESHOLD_TOKENS) {
				await agent.compact(
					"Preserve all findings emitted so far as a summary list. " +
						"Discard raw diffs — only keep findings.",
				);
			}
		}
	}

	/** Wipe context on all agents (call after plan completes). */
	async reset(): Promise<void> {
		for (const agent of this.activeAgents()) {
			await agent.reset();
		}
	}

	/** Shut down all reviewer agents. */
	async dispose(): Promise<void> {
		for (const agent of this.activeAgents()) {
			await agent.dispose();
		}
		this.primaryAgent = null;
		this.secondaryAgent = null;
		this.started = false;
	}

	/** Whether the pool has been started. */
	get isStarted(): boolean {
		return this.started;
	}

	/** Aggregate usage across all reviewer agents. */
	aggregateUsage(): UsageStats {
		const agents = this.activeAgents();
		return {
			input: agents.reduce((sum, a) => sum + a.usage.input, 0),
			output: agents.reduce((sum, a) => sum + a.usage.output, 0),
			cacheRead: agents.reduce((sum, a) => sum + a.usage.cacheRead, 0),
			cacheWrite: agents.reduce((sum, a) => sum + a.usage.cacheWrite, 0),
			cost: agents.reduce((sum, a) => sum + a.usage.cost, 0),
			turns: agents.reduce((sum, a) => sum + a.usage.turns, 0),
		};
	}

	private activeAgents(): PersistentAgent[] {
		const agents: PersistentAgent[] = [];
		if (this.primaryAgent && !this.primaryAgent.disposed) {
			agents.push(this.primaryAgent);
		}
		if (this.secondaryAgent && !this.secondaryAgent.disposed) {
			agents.push(this.secondaryAgent);
		}
		return agents;
	}

	/**
	 * Wait for one agent to finish, then prompt it to consolidate all
	 * findings into a single JSON array. This ensures we get findings
	 * from ALL steps, not just the last one.
	 */
	private async collectFrom(
		agent: PersistentAgent | null,
		timeoutMs?: number,
	): Promise<RawFinding[]> {
		if (!agent || agent.disposed) return [];

		try {
			await agent.waitForIdle(timeoutMs);
		} catch {
			// Timeout or error — try to collect anyway.
		}

		// Ask the agent to consolidate all findings from all steps into
		// a single JSON array. This handles the case where each step
		// produced its own array in a separate turn.
		try {
			await agent.prompt(
				"Emit a single consolidated JSON array of ALL findings from " +
					"every step you reviewed. Deduplicate: if the same issue was " +
					"flagged in multiple steps, include it only once. If you have " +
					"no findings, emit `[]`.",
			);
			await agent.waitForIdle(timeoutMs);
		} catch {
			// Fall back to the last message if consolidation fails.
		}

		const text = await agent.getLastText();
		if (!text) return [];

		const parsed = parseReviewerOutput(text);
		return parsed ?? [];
	}
}

// ---- Helpers ----------------------------------------------------------------

function buildStepMessage(task: StepReviewTask): string {
	const lines: string[] = [
		`## Step ${task.stepNumber}: ${task.stepDescription}`,
		"",
		"Review the following diff. Emit findings as a JSON array.",
		"",
		"```diff",
		task.diff.trimEnd(),
		"```",
	];
	return lines.join("\n");
}
