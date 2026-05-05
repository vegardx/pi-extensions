import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	parseReviewerOutput,
	type RawFinding,
	type ReviewerRole,
} from "./findings.js";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts");

function promptFileFor(role: ReviewerRole): string {
	return join(PROMPTS_DIR, `${role}.md`);
}

export interface ReviewerInvocation {
	role: ReviewerRole;
	/** Task payload: a pre-assembled markdown message with diff / file list. */
	task: string;
	provider: string;
	model: string;
	cwd: string;
	/** Abort signal — wired to the active agent turn when one exists. */
	signal?: AbortSignal;
}

export interface ReviewerOutcome {
	role: ReviewerRole;
	findings: RawFinding[];
	/** Populated when the reviewer failed to start, crashed, or emitted non-JSON. */
	error?: string;
}

/**
 * Spawn one reviewer subagent, send it the task, collect its JSON
 * reply, then tear it down. Thin wrapper over the shared
 * `runSubagent` helper that adds reviewer-specific output parsing.
 */
export async function runReviewer(
	input: ReviewerInvocation,
): Promise<ReviewerOutcome> {
	const out = await runSubagent({
		tag: input.role,
		task: input.task,
		systemPromptPath: promptFileFor(input.role),
		provider: input.provider,
		model: input.model,
		cwd: input.cwd,
		signal: input.signal,
	});

	if (out.error) {
		return { role: input.role, findings: [], error: out.error };
	}

	const parsed = parseReviewerOutput(out.rawText);
	if (parsed === null) {
		return {
			role: input.role,
			findings: [],
			error: `reviewer output was not valid JSON:\n${out.rawText.slice(0, 500)}`,
		};
	}
	return { role: input.role, findings: parsed };
}
