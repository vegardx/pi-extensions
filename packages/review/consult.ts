/**
 * Consult stage — an independent second opinion on findings the
 * curator could not confidently confirm. Runs between the curator and
 * the confidence split, behind `review.consult.enabled`.
 *
 * For each candidate finding (non-high confidence, CRITICAL/IMPORTANT,
 * capped at {@link MAX_CONSULTS} per run) a one-shot subagent with the
 * consult prompt evaluates it against the diff:
 *   - agree    → confidence bumps one level (low→medium, medium→high);
 *                a returned fix fills a missing suggestedAction.
 *   - disagree → confidence drops to low (the split then drops
 *                IMPORTANT and surfaces CRITICAL with a caveat).
 *   - error    → finding is left untouched.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateJsonPayloads } from "@vegardx/pi-extensions-shared/json-extraction.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import type { OrchestratedFinding } from "./findings.js";

const CONSULT_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"consult.md",
);

/** Bound the second-opinion fan-out so consult can't dominate cost. */
export const MAX_CONSULTS = 5;

export interface ConsultVerdict {
	agree: boolean;
	reason?: string;
	suggestedAction?: string;
}

export interface RunConsultOpts {
	provider: string;
	model: string;
	findings: OrchestratedFinding[];
	diff: string;
	scopeLabel: string;
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Test seam. Defaults to a real subagent run. */
	consultOne?: (
		finding: OrchestratedFinding,
		opts: RunConsultOpts,
	) => Promise<ConsultVerdict | null>;
}

export function parseConsultVerdict(raw: string): ConsultVerdict | null {
	for (const candidate of candidateJsonPayloads(raw)) {
		try {
			const parsed = JSON.parse(candidate) as Record<string, unknown>;
			if (typeof parsed.agree === "boolean") {
				return {
					agree: parsed.agree,
					...(typeof parsed.reason === "string"
						? { reason: parsed.reason }
						: {}),
					...(typeof parsed.suggestedAction === "string" &&
					parsed.suggestedAction.trim()
						? { suggestedAction: parsed.suggestedAction }
						: {}),
				};
			}
		} catch {
			// try next candidate
		}
	}
	return null;
}

/** Findings worth a second opinion. */
export function consultCandidates(
	findings: readonly OrchestratedFinding[],
): OrchestratedFinding[] {
	return findings
		.filter(
			(f) =>
				f.confidence !== "high" &&
				(f.severity === "CRITICAL" || f.severity === "IMPORTANT"),
		)
		.slice(0, MAX_CONSULTS);
}

async function defaultConsultOne(
	finding: OrchestratedFinding,
	opts: RunConsultOpts,
): Promise<ConsultVerdict | null> {
	const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
	const task = [
		"Evaluate this finding per your system prompt and reply with the JSON verdict.",
		"",
		"## Finding to evaluate",
		"",
		`- **File**: ${loc}`,
		`- **Severity**: ${finding.severity}`,
		`- **Title**: ${finding.title}`,
		`- **Description**: ${finding.description}`,
		`- **Proposed fix**: ${finding.suggestedAction?.trim() || "none proposed"}`,
		"",
		`## Code diff (scope: ${opts.scopeLabel})`,
		"",
		"```diff",
		opts.diff.trimEnd(),
		"```",
	].join("\n");
	const out = await runSubagent({
		tag: "consult",
		task,
		systemPromptPath: CONSULT_PROMPT_PATH,
		tools: ["read", "grep", "find", "ls"],
		provider: opts.provider,
		model: opts.model,
		cwd: opts.cwd,
		signal: opts.signal,
		timeoutMs: opts.timeoutMs,
	});
	if (out.error || !out.rawText) return null;
	return parseConsultVerdict(out.rawText);
}

export interface ConsultResult {
	/** Findings with adjusted confidence (same array order as input). */
	findings: OrchestratedFinding[];
	consulted: number;
	errors: number;
}

/**
 * Adjust confidence on contested findings via the consult model.
 * Returns a new array; input is not mutated.
 */
export async function runConsult(opts: RunConsultOpts): Promise<ConsultResult> {
	const consultOne = opts.consultOne ?? defaultConsultOne;
	const candidates = new Set(consultCandidates(opts.findings));
	let consulted = 0;
	let errors = 0;
	const out: OrchestratedFinding[] = [];
	for (const f of opts.findings) {
		if (!candidates.has(f)) {
			out.push(f);
			continue;
		}
		consulted++;
		const verdict = await consultOne(f, opts);
		if (!verdict) {
			errors++;
			out.push(f);
			continue;
		}
		if (verdict.agree) {
			out.push({
				...f,
				confidence: f.confidence === "low" ? "medium" : "high",
				...(verdict.suggestedAction && !f.suggestedAction?.trim()
					? { suggestedAction: verdict.suggestedAction }
					: {}),
				orchestratorNote: verdict.reason
					? `consult agreed: ${verdict.reason}`
					: f.orchestratorNote,
			});
		} else {
			out.push({
				...f,
				confidence: "low",
				orchestratorNote: verdict.reason
					? `consult disagreed: ${verdict.reason}`
					: f.orchestratorNote,
			});
		}
	}
	return { findings: out, consulted, errors };
}
