/**
 * modes' delegate targets — `researcher` (web research, every mode)
 * and `explorer` (codebase questions, plan mode only) — registered
 * into the shared delegate registry consumed by pi-ext-subagent's
 * generic `delegate` tool.
 *
 * Targets return failures as text + `details.error`; they never throw.
 * Concurrency capping lives in the subagent host's semaphore now, so
 * `researcher` wraps the plain blocking `research()` call.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type DelegateTargetResult,
	registerDelegateTarget,
} from "@vegardx/pi-extensions-shared/delegate-registry.js";
import type { DelegateAgents, ResearchOutcome } from "./delegate-tools.js";
import type { ExploreMailbox } from "./explore-mailbox.js";

export interface ModesDelegateTargetDeps {
	getDelegateAgents(ctx: ExtensionContext): DelegateAgents;
	getExploreMailbox(ctx: ExtensionContext): ExploreMailbox;
	/** Config-resolved fallback when the caller passes no timeoutMs. */
	readResearchTimeoutMs(ctx: ExtensionContext): number;
	isPlanMode(): boolean;
	/** Surface a warning toast (research timeouts). */
	notifyWarning(ctx: ExtensionContext, message: string): void;
}

/**
 * Map a `ResearchOutcome` to a target result. The agent-facing text
 * keeps the historical `[research …]` bracketed-message convention so
 * existing prompts continue to recognise failure shapes; `details`
 * carries the structured outcome verbatim. Timeout outcomes also fire
 * a warning notify so the user knows a research call was reaped.
 */
function formatResearchOutcome(
	deps: ModesDelegateTargetDeps,
	ctx: ExtensionContext,
	outcome: ResearchOutcome,
): DelegateTargetResult {
	if (outcome.ok) {
		return { text: outcome.text, details: { elapsedMs: outcome.elapsedMs } };
	}
	let text: string;
	if (outcome.reason === "timeout") {
		deps.notifyWarning(
			ctx,
			`research timed out after ${outcome.elapsedMs}ms (limit ${outcome.timeoutMs}ms)`,
		);
		text = `[research timeout: no response after ${outcome.elapsedMs}ms (limit ${outcome.timeoutMs}ms)]`;
	} else if (outcome.reason === "no-model") {
		text = `[research: ${outcome.detail}]`;
	} else if (outcome.reason === "subagent-error") {
		text = `[research error: ${outcome.detail}]`;
	} else {
		text = "[research: no response]";
	}
	return { text, details: { error: outcome.reason, outcome } };
}

/** Register modes' targets. Called once from the extension factory. */
export function registerModesDelegateTargets(
	deps: ModesDelegateTargetDeps,
): void {
	registerDelegateTarget({
		name: "researcher",
		description:
			"web research via a one-shot search/fetch sub-agent; returns a distilled answer",
		execute: async ({ message, ctx, signal, timeoutMs }) => {
			const effectiveTimeout = timeoutMs ?? deps.readResearchTimeoutMs(ctx);
			const outcome = await deps
				.getDelegateAgents(ctx)
				.research(message, { timeoutMs: effectiveTimeout, signal });
			return formatResearchOutcome(deps, ctx, outcome);
		},
	});

	registerDelegateTarget({
		name: "explorer",
		description:
			"codebase questions answered by the persistent explore agent (plan mode only)",
		isAvailable: () => deps.isPlanMode(),
		execute: async ({ message, ctx, timeoutMs }) => {
			const mailbox = deps.getExploreMailbox(ctx);
			const { id } = await mailbox.ask(message);
			const task = await mailbox.wait(id, timeoutMs);
			if (task.status === "error" || task.status === "timeout") {
				return {
					text: `[delegate explorer ${task.status}] ${task.error ?? "no answer"}`,
					details: { error: task.status, detail: task.error },
				};
			}
			return { text: task.text ?? "" };
		},
	});
}
