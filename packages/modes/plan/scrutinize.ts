/**
 * Plan scrutinizer — runs a one-shot sub-agent that reviews the plan for
 * gaps, risks, and missing considerations before you implement.
 *
 * The sub-agent uses `tools: []` (pure reasoning). Input is a stripped-down
 * JSON representation of the plan to keep the prompt tight. Output is parsed
 * back to a typed findings array.
 *
 * Runs on demand only — via the `/scrutinize` command or the "Scrutinize
 * plan" option in the implement picker. The secondary-heavy model adds
 * ~20–40s of latency, so it never runs automatically.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { candidateJsonPayloads } from "@vegardx/pi-extensions-shared/json-extraction.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	deliverables,
	effectiveWorkItemKind,
	ownWorkItems,
	type Plan,
	type WorkItem,
	type WorkItemKind,
} from "./schema.js";
import { topLevelLeaves } from "./tree.js";

const PROMPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"prompts",
);

const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, "scrutinize-plan.md");

/** Maximum body length included in the plan payload sent to the sub-agent. */
const MAX_BODY_CHARS = 500;

/**
 * waitForIdle timeout. The scrutinizer now investigates with read-only
 * tools (codebase + web), so it does real multi-step I/O, not just
 * one-shot reasoning — give it room.
 */
const TIMEOUT_MS = 180_000;

export interface ScrutinyFinding {
	severity: "high" | "medium" | "low";
	/** Phase ID, or null for cross-cutting findings. */
	phase: string | null;
	/** ≤ 10-word imperative summary. */
	finding: string;
	/** Concrete explanation of the gap or risk. */
	detail: string;
}

export interface ScrutinyResult {
	findings: ScrutinyFinding[];
	/** Present when the sub-agent failed or returned unparseable output. */
	error?: string;
}

/** Compact plan representation sent to the sub-agent. */
interface PlanPayloadTask {
	id: string;
	title: string;
	body: string;
	done: boolean;
	kind: WorkItemKind;
}

interface PlanPayloadPhase {
	id: string;
	title: string;
	goal: string;
	status: string;
	dependsOn: string[];
	tasks: PlanPayloadTask[];
}

interface PlanPayload {
	phases: PlanPayloadPhase[];
	followUps: PlanPayloadTask[];
}

/**
 * Serialise the plan to the compact JSON payload sent to the scrutinizer.
 *
 * Strips `phase.summary` (implementation narrative — not useful for gap
 * analysis) and truncates `task.body` to MAX_BODY_CHARS to keep the prompt
 * within reason.
 *
 * Carries `kind` and `dependsOn` so the scrutinizer knows which tasks
 * gate completion vs which are reviewer notes, and which phases are
 * actually allowed to depend on which.
 */
function serialisePlan(plan: Plan): string {
	const toTask = (task: WorkItem): PlanPayloadTask => ({
		id: task.id,
		title: task.title,
		body:
			task.body.length > MAX_BODY_CHARS
				? `${task.body.slice(0, MAX_BODY_CHARS)}…`
				: task.body,
		done: task.done,
		kind: effectiveWorkItemKind(task),
	});
	const payload: PlanPayload = {
		phases: deliverables(plan).map((phase) => ({
			id: phase.id,
			title: phase.title,
			goal: phase.body,
			status: phase.status,
			dependsOn: phase.dependsOn ?? [],
			tasks: ownWorkItems(phase).map(toTask),
		})),
		followUps: topLevelLeaves(plan).map(toTask),
	};
	return JSON.stringify(payload);
}

function isValidFinding(item: unknown): item is ScrutinyFinding {
	if (!item || typeof item !== "object") return false;
	const f = item as Record<string, unknown>;
	return (
		(f.severity === "high" ||
			f.severity === "medium" ||
			f.severity === "low") &&
		(f.phase === null || typeof f.phase === "string") &&
		typeof f.finding === "string" &&
		typeof f.detail === "string"
	);
}

/**
 * Run the scrutinizer sub-agent against `plan`.
 *
 * Model resolution order:
 *   1. backgroundModels.secondary.heavy (falls back to primary.heavy inside
 *      the resolver when secondary.heavy is not configured)
 *   2. Active session model (ctx.model) when neither heavy tier is configured
 */
export async function scrutinizePlan(
	plan: Plan,
	ctx: ExtensionContext,
	opts?: { signal?: AbortSignal },
): Promise<ScrutinyResult> {
	// Resolve model: secondary.heavy → primary.heavy (resolver handles that
	// fallback internally) → session model
	const resolved = await resolveModel(ctx, {
		name: "modes",
		tier: "heavy",
		set: "secondary",
	});

	const provider = resolved?.model.provider ?? ctx.model?.provider;
	const model = resolved?.model.id ?? ctx.model?.id;

	if (!provider || !model) {
		return {
			findings: [],
			error:
				"no model configured for scrutinize (set backgroundModels.secondary.heavy or backgroundModels.primary.heavy)",
		};
	}

	const planJson = serialisePlan(plan);
	const task = `Scrutinize this plan and return a JSON array of findings.\n\n${planJson}`;

	const outcome = await runSubagent({
		tag: "scrutinize",
		task,
		systemPromptPath: SYSTEM_PROMPT_PATH,
		// Read-only investigative tools so the scrutinizer can ground its
		// findings against the actual repo + web, not just reason over the
		// plan JSON. read/grep/find/ls are built-in; websearch/webfetch come
		// from the exa/webfetch extensions, re-enabled via env below. bash is
		// deliberately excluded (no plan-mode write-block in a subagent), and
		// delegate is excluded (needs modes → fork bomb, and is redundant
		// since this is already an isolated subagent that can search inline).
		tools: ["read", "grep", "find", "ls", "websearch", "webfetch"],
		env: { PI_EXT_EXA: "on", PI_EXT_WEBFETCH: "on" },
		provider,
		model,
		cwd: ctx.cwd,
		timeoutMs: TIMEOUT_MS,
		signal: opts?.signal,
	});

	if (outcome.error) {
		return { findings: [], error: outcome.error };
	}

	if (!outcome.rawText.trim()) {
		return { findings: [], error: "scrutinizer produced no output" };
	}

	// Try each candidate JSON payload in order; first valid parse wins.
	for (const candidate of candidateJsonPayloads(outcome.rawText)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;

		const all = parsed as unknown[];
		const findings = all.filter(isValidFinding);
		const dropped = all.length - findings.length;
		if (dropped > 0) {
			return {
				findings,
				error: `scrutinizer returned ${dropped} malformed entr${
					dropped === 1 ? "y" : "ies"
				} (kept ${findings.length} valid)`,
			};
		}
		return { findings };
	}

	return {
		findings: [],
		error: `scrutinizer output is not valid JSON: ${outcome.rawText.slice(0, 120)}`,
	};
}
