/**
 * Polish step for /derp.
 *
 * Spawns a one-shot RPC subagent (read-only tool set) to turn a
 * `DerpContext` into a polished `{ title, body }` issue draft. Runs
 * outside the host pi session — never calls `pi.sendMessage`, never
 * triggers a host turn.
 *
 * Failure modes (timeout, malformed JSON, no model, abort) are
 * reported via a discriminated `PolishOutcome` so the caller can
 * fall back to the deterministic template without try/catch noise.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateJsonPayloads } from "@vegardx/pi-extensions-shared/json-extraction.js";
import {
	runSubagent,
	type SubagentTask,
} from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import type { DerpContext } from "./context.js";
import {
	buildPolishTask,
	type IssueDraft,
	validatePolishOutput,
} from "./template.js";

const SYSTEM_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"system-prompt.md",
);

const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;

export type PolishOutcome =
	| { ok: true; draft: IssueDraft }
	| {
			ok: false;
			reason: "no-model" | "subagent-error" | "empty-output" | "bad-json";
			detail: string;
	  };

export interface PolishInput {
	ctx: DerpContext;
	provider: string;
	model: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * Seam for tests: the production runner is `runSubagent`, but tests
 * inject a stub so they don't spawn an actual pi process.
 */
export type SubagentRunner = (
	task: SubagentTask<"derp">,
) => Promise<{ rawText: string; error?: string }>;

/**
 * Polish a `DerpContext` into a GitHub issue draft. Single-purpose:
 * if anything goes wrong it returns a structured failure rather than
 * throwing, so the caller can quietly fall back to the deterministic
 * template.
 */
export async function polishReport(
	input: PolishInput,
	runner: SubagentRunner = runSubagent,
): Promise<PolishOutcome> {
	const out = await runner({
		tag: "derp",
		task: buildPolishTask(input.ctx),
		systemPromptPath: SYSTEM_PROMPT_PATH,
		tools: DEFAULT_TOOLS,
		provider: input.provider,
		model: input.model,
		cwd: input.cwd,
		signal: input.signal,
		timeoutMs: input.timeoutMs,
	});

	if (out.error) {
		return { ok: false, reason: "subagent-error", detail: out.error };
	}

	const raw = out.rawText?.trim() ?? "";
	if (!raw) {
		return {
			ok: false,
			reason: "empty-output",
			detail: "polish subagent returned no text",
		};
	}

	for (const candidate of candidateJsonPayloads(raw)) {
		try {
			const parsed = JSON.parse(candidate);
			const draft = validatePolishOutput(parsed);
			if (draft) return { ok: true, draft };
		} catch {
			/* try next candidate */
		}
	}

	return {
		ok: false,
		reason: "bad-json",
		detail: `polish output was not valid {title, body} JSON: ${raw.slice(0, 300)}`,
	};
}
