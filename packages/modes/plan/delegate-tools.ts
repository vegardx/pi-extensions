/**
 * Session-scoped delegate agents for plan and auto modes.
 *
 * Two agents reduce main-context bloat:
 *
 *   - explore  — persistent sub-agent for codebase questions via
 *                read/grep/find/ls. Accumulates context across turns.
 *                Available in plan mode only.
 *
 *   - research — one-shot per call, fully parallel. Each question
 *                spawns a fresh process with websearch/webfetch.
 *                Multiple concurrent calls run simultaneously.
 *                Available in plan mode and auto/ask mode.
 *
 * Callers receive the agent's summary as a plain string. Errors are
 * returned as bracketed messages — never thrown — so the main agent
 * can decide how to proceed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import { SubagentPool } from "@vegardx/pi-extensions-shared/subagent-pool.js";

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const EXPLORE_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
const RESEARCH_TOOLS: readonly string[] = ["websearch", "webfetch"];

const EXPLORE_TIMEOUT_MS = 60_000;
const RESEARCH_TIMEOUT_MS = 90_000;

export class DelegateAgents {
	private pool: SubagentPool;
	private readonly ctx: ExtensionContext;
	private readonly activeResearch = new Map<number, string>();
	private nextResearchId = 0;

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
		this.pool = new SubagentPool();
	}

	/**
	 * Ask the codebase-exploration agent a question. Spawns on first call;
	 * subsequent calls reuse the same agent and its accumulated context.
	 */
	async explore(question: string): Promise<string> {
		return this.ask(
			"explore",
			join(PROMPTS_DIR, "explore-agent.md"),
			EXPLORE_TOOLS,
			EXPLORE_TIMEOUT_MS,
			question,
		);
	}

	/**
	 * Ask the research agent a question. Each call spawns a fresh one-shot
	 * process so multiple concurrent questions run fully in parallel.
	 */
	async research(question: string): Promise<string> {
		const id = this.nextResearchId++;
		const topic = question.length > 60 ? `${question.slice(0, 57)}…` : question;
		this.activeResearch.set(id, topic);
		this.updateResearchWidget();
		try {
			const resolved = await resolveModel(this.ctx, {
				name: "modes",
				tier: "fast",
			});
			if (!resolved) {
				return "[research: no fast-tier model configured — add backgroundModels.primary.fast to settings.json]";
			}
			const outcome = await runSubagent({
				tag: id,
				task: question,
				systemPromptPath: join(PROMPTS_DIR, "research-agent.md"),
				tools: RESEARCH_TOOLS,
				provider: resolved.model.provider,
				model: resolved.model.id,
				cwd: this.ctx.cwd,
				timeoutMs: RESEARCH_TIMEOUT_MS,
			});
			if (outcome.error) return `[research error: ${outcome.error}]`;
			return outcome.rawText || "[research: no response]";
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

	/** Tear down all agents. Best-effort — does not throw. */
	async dispose(): Promise<void> {
		const oldPool = this.pool;
		// Reset first so any concurrent calls get a fresh pool.
		this.pool = new SubagentPool();
		try {
			await oldPool.dispose();
		} catch {
			/* best-effort */
		}
	}

	private async ask(
		id: string,
		systemPromptPath: string,
		tools: readonly string[],
		timeoutMs: number,
		question: string,
	): Promise<string> {
		// Tracks whether we passed the spawn phase. Errors before this flag
		// is set may be concurrent-spawn races; errors after are execution
		// failures that should always reset the pool.
		let pastSpawn = false;
		try {
			if (!this.pool.has(id)) {
				const resolved = await resolveModel(this.ctx, {
					name: "modes",
					tier: "fast",
				});
				if (!resolved) {
					return `[${id}: no fast-tier model configured — add backgroundModels.primary.fast to settings.json]`;
				}
				await this.pool.spawn(id, {
					provider: resolved.model.provider,
					model: resolved.model.id,
					systemPromptPath,
					tools,
					cwd: this.ctx.cwd,
				});
			}

			const agent = this.pool.get(id);
			if (!agent) {
				return `[${id}: agent failed to start]`;
			}

			pastSpawn = true;
			await agent.prompt(question);
			await agent.waitForIdle(timeoutMs);
			return (await agent.getLastText()) ?? `[${id}: no response]`;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Race guard: if we failed before running the agent and another
			// concurrent spawn already put the agent in the pool, reuse it.
			if (!pastSpawn && this.pool.has(id)) {
				const existing = this.pool.get(id);
				if (existing) {
					try {
						await existing.prompt(question);
						await existing.waitForIdle(timeoutMs);
						return (await existing.getLastText()) ?? `[${id}: no response]`;
					} catch {
						// Genuine failure — fall through to pool reset.
					}
				}
			}
			// Reset the pool so the next call gets a clean slate. Both
			// agents are lost, but crashes are rare and a fresh start is
			// safer than leaving a half-dead process in the pool.
			void this.pool.dispose().catch(() => {});
			this.pool = new SubagentPool();
			return `[${id} error: ${msg}]`;
		}
	}
}
