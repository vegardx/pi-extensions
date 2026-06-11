/**
 * One review lens = one subagent run. Thin wrapper over the shared
 * `runSubagent` helper that adds lens-specific output parsing.
 * Successor to the role-based `reviewer-client.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import { parseReviewerOutput, type RawFinding } from "./findings.js";
import type { LensId } from "./models.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function promptFileFor(lens: LensId): string {
	return join(PROMPTS_DIR, `${lens}.md`);
}

// ---- Lens timeout heuristic -------------------------------------------
//
// Each lens subagent reads a diff in full; heavy models on a
// non-trivial diff routinely need 2-5 minutes. We scale the budget
// with the diff byte-count so small changesets stay fast and large
// ones don't time out.
//
// BASE_REVIEW_TIMEOUT_MS  matches the RpcClient 60s default doubled
// (reviewers do more than verifiers).
// PER_10K_CHARS_MS        adds 15s per 10 000 chars of diff.
// MAX_REVIEW_TIMEOUT_MS   caps at 10 minutes.

export const BASE_REVIEW_TIMEOUT_MS = 120_000;
export const PER_10K_CHARS_MS = 15_000;
export const MAX_REVIEW_TIMEOUT_MS = 600_000;

/**
 * Budget for one lens subagent's `waitForIdle`, in ms.
 * `120s + 15s per 10k diff chars`, capped at 10 minutes.
 * Exported so unit tests can pin the heuristic without booting
 * the extension.
 */
export function reviewTimeoutMs(diffChars: number): number {
	const safe = Number.isFinite(diffChars) && diffChars > 0 ? diffChars : 0;
	const scaled =
		BASE_REVIEW_TIMEOUT_MS + Math.floor(safe / 10_000) * PER_10K_CHARS_MS;
	return Math.min(MAX_REVIEW_TIMEOUT_MS, scaled);
}

export interface LensInvocation {
	lens: LensId;
	/** Task payload: a pre-assembled markdown message with diff / file list. */
	task: string;
	provider: string;
	model: string;
	cwd: string;
	/** Abort signal — wired to the active agent turn when one exists. */
	signal?: AbortSignal;
	/**
	 * `waitForIdle` budget in milliseconds. Callers should pass
	 * `reviewTimeoutMs(diff.length)` (possibly clamped by an overall
	 * delegate budget) to get a diff-proportional value.
	 */
	timeoutMs?: number;
}

export interface LensOutcome {
	lens: LensId;
	findings: RawFinding[];
	/** Populated when the lens failed to start, crashed, or emitted non-JSON. */
	error?: string;
}

/**
 * Spawn one lens subagent, send it the task, collect its JSON reply,
 * then tear it down.
 */
export async function runLens(input: LensInvocation): Promise<LensOutcome> {
	const out = await runSubagent({
		tag: input.lens,
		task: input.task,
		systemPromptPath: promptFileFor(input.lens),
		provider: input.provider,
		model: input.model,
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
	});

	if (out.error) {
		return { lens: input.lens, findings: [], error: out.error };
	}

	if (!out.rawText || out.rawText.trim().length === 0) {
		return {
			lens: input.lens,
			findings: [],
			error: "lens produced no output (empty response)",
		};
	}

	const parsed = parseReviewerOutput(out.rawText);
	if (parsed === null) {
		return {
			lens: input.lens,
			findings: [],
			error: `lens output was not valid JSON:\n${out.rawText.slice(0, 500)}`,
		};
	}
	return { lens: input.lens, findings: parsed };
}
