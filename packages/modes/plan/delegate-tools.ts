/**
 * Session-scoped research delegate for plan/auto/ask modes.
 *
 * Kept narrow on purpose: the codebase-exploration sub-agent moved
 * to `ExploreMailbox` so the main agent never blocks on it. Research
 * stays request/response — each call spawns a fresh process and they
 * already run in parallel without main-context bloat. Concurrency
 * capping and answer capping live in pi-ext-subagent's delegate host,
 * which calls `research()` via the registered `researcher` target.
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
 * `extensionConfig.modes.research.timeoutMs` setting is provided.
 *
 * Two minutes gives web-heavy research agents enough time for a small
 * search/fetch loop while still bounding a stuck subprocess.
 */
export const DEFAULT_RESEARCH_TIMEOUT_MS = 120_000;

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
	/** Optional host hook fired whenever the active research set changes. */
	private activeResearchChangeHook: (() => void) | null = null;
	/**
	 * Predicate the host sets to suppress the below-editor research widget when
	 * the same data is already shown in the sidebar Info box (avoids duplicate
	 * rendering when the sidebar is toggled on).
	 */
	private widgetSuppressed: () => boolean = () => false;

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

	/**
	 * Register a callback fired whenever the active-research set changes (a run
	 * starts or finishes). Lets the host mirror research rows into other surfaces
	 * (e.g. the sidebar Info box) without polling.
	 */
	setOnResearchChange(cb: (() => void) | null): void {
		this.activeResearchChangeHook = cb;
	}

	/** Set the predicate that hides the research widget (e.g. sidebar shown). */
	setWidgetSuppressed(fn: () => boolean): void {
		this.widgetSuppressed = fn;
	}

	/** Re-evaluate the research widget (used after the sidebar toggles). */
	refreshResearchWidget(): void {
		this.updateResearchWidget();
	}

	/** Topics of the currently-running research delegates. */
	getActiveResearch(): string[] {
		return Array.from(this.activeResearch.values());
	}

	private updateResearchWidget(): void {
		if (!this.ctx.hasUI) return;
		this.activeResearchChangeHook?.();
		// Sidebar owns this data when shown — don't also paint it under the editor.
		if (this.widgetSuppressed()) {
			this.ctx.ui.setWidget("delegate-research", undefined);
			return;
		}
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
	async dispose(): Promise<void> {}
}
