/**
 * Curator — the synthesis stage of the review pipeline. Receives raw
 * findings from every lens (and static tools), deduplicates fuzzily,
 * cross-validates with read-only code access, and assigns confidence
 * levels. Successor to `orchestrator.ts`, aligned on the shared
 * `runSubagent` helper.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	type OrchestratedFinding,
	parseOrchestratorOutput,
	type RawFinding,
} from "./findings.js";

const CURATOR_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"curator.md",
);

const CURATOR_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export interface CuratorInput {
	/** Source label (e.g. "generic", "security", "static:tsc"). */
	source: string;
	findings: RawFinding[];
	/** When true, findings came from a deterministic static analysis tool. */
	staticTool?: boolean;
}

export interface RunCuratorOpts {
	provider: string;
	model: string;
	/** All findings from lenses and static tools. */
	inputs: CuratorInput[];
	/** The full diff (for context). */
	diff: string;
	/** Scope label (e.g. "current branch vs. main"). */
	scopeLabel: string;
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface CuratorResult {
	findings: OrchestratedFinding[];
	ran: boolean;
	error?: string;
}

/**
 * Run the curator as a one-shot subagent with read-only code access.
 * Callers decide whether to invoke it at all (see
 * `shouldSkipCurator` in run-reviewer.ts) — an empty-input run is a
 * waste of a heavy-model call.
 */
export async function runCurator(opts: RunCuratorOpts): Promise<CuratorResult> {
	const task = buildCuratorTask(opts.inputs, opts.diff, opts.scopeLabel);

	const out = await runSubagent({
		tag: "curator",
		task,
		systemPromptPath: CURATOR_PROMPT_PATH,
		tools: CURATOR_TOOLS,
		provider: opts.provider,
		model: opts.model,
		cwd: opts.cwd,
		signal: opts.signal,
		timeoutMs: opts.timeoutMs ?? 600_000,
	});

	if (out.error) {
		return { findings: [], ran: false, error: out.error };
	}

	const parsed = parseOrchestratorOutput(out.rawText);
	if (parsed === null) {
		return {
			findings: [],
			ran: false,
			error: `curator output not parseable: ${out.rawText.slice(0, 300)}`,
		};
	}

	return { findings: parsed, ran: true };
}

function buildCuratorTask(
	inputs: CuratorInput[],
	diff: string,
	scopeLabel: string,
): string {
	const lines: string[] = [
		"## Input findings from all review lenses",
		"",
		"Each entry has a `source` label. Same real issue may appear under",
		"different titles from different lenses or models — your job is to",
		"recognise and merge them.",
		"",
		"```json",
		JSON.stringify(
			inputs.map((b) => ({
				source: b.source,
				...(b.staticTool ? { staticTool: true } : {}),
				findings: b.findings,
			})),
			null,
			2,
		),
		"```",
		"",
		`## Diff (scope: ${scopeLabel})`,
		"",
		"```diff",
		diff.trimEnd(),
		"```",
	];
	return lines.join("\n");
}
