/**
 * Session-scoped research delegate for plan/auto/ask modes.
 *
 * Kept narrow on purpose: the codebase-exploration sub-agent moved
 * to `ExploreMailbox` so the main agent never blocks on it. Research
 * stays request/response — each call spawns a fresh process and they
 * already run in parallel without main-context bloat.
 *
 * Errors are returned as bracketed messages — never thrown — so the
 * main agent can decide how to proceed.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const RESEARCH_TOOLS: readonly string[] = ["websearch", "webfetch"];
const RESEARCH_TIMEOUT_MS = 90_000;

export class DelegateAgents {
	private readonly ctx: ExtensionContext;
	private readonly activeResearch = new Map<number, string>();
	private nextResearchId = 0;

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	/**
	 * Ask the research agent a question. Each call spawns a fresh
	 * one-shot process so multiple concurrent questions run fully in
	 * parallel.
	 */
	async research(question: string): Promise<string> {
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

	/** No persistent state — present as a no-op for symmetry with the
	 *  prior API; future additions can hook teardown here. */
	async dispose(): Promise<void> {
		/* no-op */
	}
}
