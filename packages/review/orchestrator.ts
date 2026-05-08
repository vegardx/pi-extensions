import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentPool } from "@vegardx/pi-extensions-shared/subagent-pool.js";
import {
	type OrchestratedFinding,
	parseOrchestratorOutput,
	type RawFinding,
} from "./findings.js";

const ORCHESTRATOR_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"orchestrator.md",
);

// ---- Types ------------------------------------------------------------------

export interface OrchestratorInput {
	/** Source label (e.g. "primary", "secondary", "static"). */
	source: string;
	findings: RawFinding[];
}

export interface RunOrchestratorOpts {
	pool: SubagentPool;
	/** The model to use for orchestration. */
	provider: string;
	model: string;
	/** All findings from reviewers and static tools. */
	inputs: OrchestratorInput[];
	/** The full branch diff (for context). */
	diff: string;
	/** Scope label (e.g. "current branch vs. main"). */
	scopeLabel: string;
	/** Working directory. */
	cwd: string;
	/** Timeout for the orchestrator. */
	timeoutMs?: number;
}

export interface OrchestratorResult {
	findings: OrchestratedFinding[];
	ran: boolean;
	error?: string;
}

// ---- Implementation ---------------------------------------------------------

/**
 * Run the orchestrator as a one-shot subagent. It receives pre-collected
 * findings from persistent reviewers and static analysis, cross-validates
 * them, deduplicates, and assigns confidence levels.
 *
 * No custom tools needed — both model perspectives are already available
 * as input findings. The orchestrator only needs read-only code access
 * for verification.
 */
export async function runOrchestrator(
	opts: RunOrchestratorOpts,
): Promise<OrchestratorResult> {
	const totalFindings = opts.inputs.reduce((n, b) => n + b.findings.length, 0);

	if (totalFindings === 0) {
		return { findings: [], ran: false };
	}

	const task = buildOrchestratorTask(opts.inputs, opts.diff, opts.scopeLabel);

	const result = await opts.pool.oneshot({
		task,
		systemPromptPath: ORCHESTRATOR_PROMPT_PATH,
		provider: opts.provider,
		model: opts.model,
		tools: ["read", "grep", "find", "ls"],
		cwd: opts.cwd,
		timeoutMs: opts.timeoutMs ?? 600_000,
	});

	if (result.error) {
		return { findings: [], ran: false, error: result.error };
	}

	const parsed = parseOrchestratorOutput(result.text);
	if (parsed === null) {
		return {
			findings: [],
			ran: false,
			error: `orchestrator output not parseable: ${result.text.slice(0, 300)}`,
		};
	}

	return { findings: parsed, ran: true };
}

// ---- Helpers ----------------------------------------------------------------

function buildOrchestratorTask(
	inputs: OrchestratorInput[],
	diff: string,
	scopeLabel: string,
): string {
	const lines: string[] = [
		"## Input findings from all reviewer agents",
		"",
		"Each entry has a `source` label. Same real issue may appear under",
		"different titles from different models — your job is to recognise",
		"and merge them.",
		"",
		"```json",
		JSON.stringify(
			inputs.map((b) => ({
				source: b.source,
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
