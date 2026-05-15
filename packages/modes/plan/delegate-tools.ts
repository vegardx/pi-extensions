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

	constructor(ctx: ExtensionContext) {
		this.ctx = ctx;
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
				signal: opts.signal,
				timeoutMs,
			});
			const elapsedMs = Date.now() - start;
			if (outcome.error) {
				// `RpcClient.waitForIdle` rejects with "Timeout waiting for
				// agent to become idle…" when the deadline fires. We could
				// pattern-match the message, but elapsed-vs-deadline is
				// more robust against upstream message changes.
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
		/* no-op */
	}
}
