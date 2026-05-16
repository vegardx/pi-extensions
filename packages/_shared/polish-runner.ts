/**
 * Polish runner for fire-and-forget issue filers (`/derp`, `/idea`,
 * …).
 *
 * Spawns a one-shot RPC subagent (read-only tool set) to turn a
 * caller-prepared markdown task into a polished `{ title, body }`
 * issue draft. Runs outside the host pi session — never calls
 * `pi.sendMessage`, never triggers a host turn.
 *
 * Callers supply the system prompt path, tools, and the rendered
 * task markdown. Failure modes (timeout, malformed JSON, no model,
 * abort) are reported via a discriminated `PolishOutcome` so the
 * caller can fall back to its own deterministic template without
 * try/catch noise.
 */

import { candidateJsonPayloads } from "./json-extraction.js";
import { runSubagent, type SubagentTask } from "./parallel-subagent.js";

export interface IssueDraft {
	title: string;
	body: string;
}

export type PolishOutcome =
	| { ok: true; draft: IssueDraft }
	| {
			ok: false;
			reason: "no-model" | "subagent-error" | "empty-output" | "bad-json";
			detail: string;
	  };

export interface PolishInput {
	/** Tag passed through to the subagent runner for telemetry. */
	tag: string;
	/** Pre-rendered markdown task handed to the subagent. */
	task: string;
	/** Absolute path to the system prompt markdown. */
	systemPromptPath: string;
	/** Read-only tool set the subagent may invoke. */
	tools: readonly string[];
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
	task: SubagentTask<string>,
) => Promise<{ rawText: string; error?: string }>;

/**
 * Validate that a parsed JSON value has the `{ title, body }` shape
 * the polish subagent is supposed to emit. Returns the typed draft
 * or `null` for anything malformed.
 */
export function validatePolishOutput(value: unknown): IssueDraft | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const title = typeof v.title === "string" ? v.title.trim() : "";
	const body = typeof v.body === "string" ? v.body : "";
	if (!title || !body) return null;
	return { title, body };
}

/**
 * Polish a markdown task into a GitHub issue draft. Single-purpose:
 * if anything goes wrong it returns a structured failure rather than
 * throwing, so the caller can quietly fall back to the deterministic
 * template.
 */
export async function polishReport(
	input: PolishInput,
	runner: SubagentRunner = runSubagent,
): Promise<PolishOutcome> {
	const out = await runner({
		tag: input.tag,
		task: input.task,
		systemPromptPath: input.systemPromptPath,
		tools: input.tools,
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
