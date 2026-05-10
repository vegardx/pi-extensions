/**
 * Phase-boundary compaction for the modes plan/phase model.
 *
 * Goal: a byte-stable prompt prefix across phase boundaries. Instead of
 * pi's default rolling re-summarisation (which regenerates the entire
 * summary on every compaction and flushes the prompt cache), modes
 * compacts at well-defined points — plan → implement, and phase end —
 * and the summary grows by **append only**:
 *
 *   <prev summary verbatim> + "\n\n## Phase p-X — title (status)\n<body>"
 *
 * Because pi's `buildSessionContext` only emits the latest CompactionEntry
 * (verified in dist/core/session-manager.js), and because `convertToLlm`
 * wraps the summary in deterministic prefix/suffix constants
 * (dist/core/messages.js), the summary string IS the prompt prefix the
 * provider sees after the system prompt. As long as we never regenerate
 * old sections, the prefix stays byte-identical and the prompt cache
 * keeps hitting across phases.
 *
 * This module is intentionally pure: rendering helpers, tree introspection,
 * and orchestrators that take an injected `summarise` callback. The actual
 * LLM client wiring lives at the call site in index.ts.
 *
 * Coupling to the modes plan model is deliberate. If another plan-shaped
 * extension emerges, this could be lifted into a standalone package — see
 * the deferred-improvements note at the bottom of the file.
 */

import type {
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import type { Plan, Phase as PlanPhase } from "./schema.js";
import { TERMINAL_STATUSES } from "./schema.js";

/** Type alias to avoid importing AgentMessage directly from pi-agent-core. */
type AgentMessage = SessionMessageEntry["message"];

/**
 * customType for the breadcrumb entry written just before each modes
 * compaction. The compaction's `firstKeptEntryId` points at this marker,
 * which makes the kept-message span empty and routes the next turn's
 * input directly to the post-compaction tail.
 */
export const PHASE_BOUNDARY_CUSTOM_TYPE = "modes:phase-boundary";

/**
 * Default per-phase summary OUTPUT budget in tokens. Caps `maxTokens`
 * on the summariser call AND is stated in the preamble so the model
 * self-budgets. Override via:
 *   extensionConfig.modes.compaction.phaseTokens
 *
 * Input to the summariser (the conversation being summarised) is
 * unbounded — the cap is on the frozen output that ends up in the
 * prompt prefix on every subsequent turn.
 */
export const DEFAULT_PHASE_TOKENS = 8000;

/** Stored on `CompactionEntry.details` to identify modes compactions. */
export interface ModesCompactionDetails {
	modesKind: "plan-to-implement" | "phase-end";
	/** Phase activated (plan-to-implement) or shipped (phase-end). */
	modesPhaseId: string;
}

/** Data stored on the breadcrumb custom entry. */
export interface PhaseBoundaryData {
	phaseId: string;
	kind: "plan-to-implement" | "phase-end";
}

export type SummariseFn = (args: {
	messages: AgentMessage[];
	preamble: string;
	maxTokens: number;
	signal?: AbortSignal;
}) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Plan-aware rendering — pure functions, byte-stable for given inputs.
// ---------------------------------------------------------------------------

/**
 * Build the summariser preamble. Names upcoming phases (id, title, goal)
 * so the model knows which details to retain in the limited output budget.
 *
 * @param plan - current plan
 * @param completedPhase - phase whose work is being summarised; null for
 *   the plan→implement transition (planning conversation, no completed
 *   phase yet)
 * @param maxTokens - output token cap, also stated in the prompt
 */
export function buildSummariserPreamble(
	plan: Plan,
	completedPhase: PlanPhase | null,
	maxTokens: number,
): string {
	const upcoming = plan.phases.filter(
		(p) => !TERMINAL_STATUSES.includes(p.status) && p.id !== completedPhase?.id,
	);

	const lines: string[] = [
		"You are summarising work on a software project so the next phases can",
		"continue without re-reading the full conversation.",
		"",
	];

	if (completedPhase) {
		lines.push(
			`Just completed: phase \`${completedPhase.id}\` — ${completedPhase.title}`,
		);
		lines.push(`Goal: ${completedPhase.goal}`);
	} else {
		lines.push(
			"This summarises the planning conversation that preceded execution.",
		);
	}
	lines.push("");

	if (upcoming.length > 0) {
		lines.push(
			"Upcoming phases — information bearing on these MUST be retained verbatim",
			"(file paths, exact identifiers, schema fragments, decisions, error messages):",
		);
		for (const p of upcoming) {
			lines.push(`  - \`${p.id}\` — ${p.title}: ${p.goal}`);
		}
		lines.push("");
	}

	lines.push("Write a structured summary covering:");
	lines.push("  ## Done");
	lines.push("  - what was completed (concise bullets)");
	lines.push("  ## Key decisions");
	lines.push("  - decisions and their rationale");
	lines.push("  ## Carry-forward context");
	lines.push("  - file paths, function names, schema fragments, identifiers,");
	lines.push("    and error messages relevant to upcoming phases");
	lines.push("");
	lines.push(
		`Stay within ~${maxTokens} output tokens. Do not restate phase goals.`,
	);

	return lines.join("\n");
}

/** `## Plan` section emitted at plan→implement. Stable for stable plan input. */
export function renderPlanSection(plan: Plan): string {
	const lines: string[] = [`## Plan: ${plan.title} (slug: ${plan.slug})`];
	for (const p of plan.phases) {
		const pr = p.prNumber !== undefined ? ` PR #${p.prNumber}` : "";
		lines.push(`- \`${p.id}\` [${p.status}]${pr} — ${p.title}: ${p.goal}`);
	}
	return lines.join("\n");
}

/** `## Phase ...` section emitted at phase-end. */
export function renderPhaseSection(phase: PlanPhase, body: string): string {
	const pr = phase.prNumber !== undefined ? `, PR #${phase.prNumber}` : "";
	return `## Phase \`${phase.id}\` — ${phase.title} (${phase.status}${pr})\n\n${body}`;
}

/**
 * Append-only concatenation. The whole point of this scheme: previous
 * summary text is reused byte-for-byte, never regenerated.
 */
export function buildSummary(prevSummary: string, newSection: string): string {
	if (!prevSummary) return newSection;
	return `${prevSummary}\n\n${newSection}`;
}

// ---------------------------------------------------------------------------
// Tree introspection — read-only walks of the current branch.
// ---------------------------------------------------------------------------

/** Walk current branch backwards; return latest CompactionEntry's summary, or "". */
export function findLatestCompactionSummary(sm: SessionManager): string {
	const branch = sm.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "compaction") return e.summary;
	}
	return "";
}

function getModesDetails(
	entry: SessionEntry,
): ModesCompactionDetails | undefined {
	if (entry.type !== "compaction") return undefined;
	const details = (entry as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const d = details as Partial<ModesCompactionDetails>;
	if (d.modesKind !== "plan-to-implement" && d.modesKind !== "phase-end") {
		return undefined;
	}
	if (typeof d.modesPhaseId !== "string") return undefined;
	return { modesKind: d.modesKind, modesPhaseId: d.modesPhaseId };
}

/** Idempotency check for `/ship` retries. */
export function hasPhaseEndCompaction(
	sm: SessionManager,
	phaseId: string,
): boolean {
	for (const e of sm.getBranch()) {
		const d = getModesDetails(e);
		if (d?.modesKind === "phase-end" && d.modesPhaseId === phaseId) return true;
	}
	return false;
}

/** True if a plan→implement compaction has been recorded on this branch. */
export function hasPlanToImplementCompaction(sm: SessionManager): boolean {
	for (const e of sm.getBranch()) {
		const d = getModesDetails(e);
		if (d?.modesKind === "plan-to-implement") return true;
	}
	return false;
}

/**
 * Messages on the current branch from after the latest CompactionEntry
 * (or session start) to the current leaf. This is the slice we feed to
 * the summariser — note that the only thing earlier than this slice is
 * already-frozen summary content, which we never re-summarise.
 */
export function collectMessagesSinceLastCompaction(
	sm: SessionManager,
): AgentMessage[] {
	const branch = sm.getBranch();
	let startIdx = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			startIdx = i + 1;
			break;
		}
	}
	const messages: AgentMessage[] = [];
	for (let i = startIdx; i < branch.length; i++) {
		const e = branch[i];
		if (e.type === "message") messages.push(e.message);
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Orchestrators — write to the session.
// ---------------------------------------------------------------------------

export interface AppendCompactionOptions {
	sm: SessionManager;
	plan: Plan;
	summarise: SummariseFn;
	/** Output token cap for the summariser. Caller resolves from settings. */
	maxTokens: number;
	/** Estimated context tokens before compaction (diagnostic; pass 0 if unknown). */
	tokensBefore: number;
	signal?: AbortSignal;
}

/**
 * Compact at the plan → implement transition. Summarises the planning
 * conversation; produces the initial rolling summary with `## Plan` +
 * `## Planning notes`.
 *
 * Returns the compaction entry id, or null when the summariser fails
 * (in which case nothing is appended — clean rollback).
 *
 * No-op when there are zero messages to summarise: still appends marker
 * + compaction so the byte-stable prefix is established for subsequent
 * phases. Skips the LLM call in that case.
 */
export async function appendPlanToImplementCompaction(
	opts: AppendCompactionOptions & { activePhaseId: string },
): Promise<string | null> {
	const {
		sm,
		plan,
		summarise,
		maxTokens,
		tokensBefore,
		signal,
		activePhaseId,
	} = opts;

	const planning = collectMessagesSinceLastCompaction(sm);

	let body = "";
	if (planning.length > 0) {
		const preamble = buildSummariserPreamble(plan, null, maxTokens);
		const out = await summarise({
			messages: planning,
			preamble,
			maxTokens,
			signal,
		});
		if (out === null) return null;
		body = out.trim();
	}

	const sections = [renderPlanSection(plan)];
	if (body) sections.push(`## Planning notes\n\n${body}`);
	const summary = sections.join("\n\n");

	const markerId = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {
		phaseId: activePhaseId,
		kind: "plan-to-implement",
	} satisfies PhaseBoundaryData);

	return sm.appendCompaction(
		summary,
		markerId,
		tokensBefore,
		{
			modesKind: "plan-to-implement",
			modesPhaseId: activePhaseId,
		} satisfies ModesCompactionDetails,
		true,
	);
}

/**
 * Compact at /ship (phase-end). Reads the previous compaction's summary
 * verbatim, appends a new `## Phase p-X` section produced by summarising
 * messages-since-last-compaction.
 *
 * Idempotent: returns null without appending if a phase-end compaction
 * for this phase already exists. Returns null without appending on
 * summariser error (clean rollback).
 *
 * Throws if `phaseId` is not in the plan (indicates a wiring bug).
 */
export async function appendPhaseEndCompaction(
	opts: AppendCompactionOptions & { phaseId: string },
): Promise<string | null> {
	const { sm, plan, summarise, maxTokens, tokensBefore, signal, phaseId } =
		opts;

	if (hasPhaseEndCompaction(sm, phaseId)) return null;

	const phase = plan.phases.find((p) => p.id === phaseId);
	if (!phase) {
		throw new Error(
			`appendPhaseEndCompaction: phase ${phaseId} not found in plan ${plan.slug}`,
		);
	}

	const messages = collectMessagesSinceLastCompaction(sm);

	let body = "(no recorded work)";
	if (messages.length > 0) {
		const preamble = buildSummariserPreamble(plan, phase, maxTokens);
		const out = await summarise({
			messages,
			preamble,
			maxTokens,
			signal,
		});
		if (out === null) return null;
		body = out.trim();
	}

	const prev = findLatestCompactionSummary(sm);
	const summary = buildSummary(prev, renderPhaseSection(phase, body));

	const markerId = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {
		phaseId,
		kind: "phase-end",
	} satisfies PhaseBoundaryData);

	return sm.appendCompaction(
		summary,
		markerId,
		tokensBefore,
		{
			modesKind: "phase-end",
			modesPhaseId: phaseId,
		} satisfies ModesCompactionDetails,
		true,
	);
}

// ---------------------------------------------------------------------------
// Deferred improvements — tracked here, not in the plan:
//
// 1. Threshold-gate the plan→implement compaction by planning-conversation
//    token count. Currently we always compact at /implement for byte-stable
//    prefix invariants; for very small plans this wastes an LLM call.
//
// 2. The compaction module is coupled to the modes plan/phase model. If
//    another plan-shaped extension emerges with the same compaction needs,
//    extract this into a standalone package and parametrise the rendering
//    helpers (renderPlanSection / renderPhaseSection) over a phase shape.
//
// 3. Per-phase token budget could become adaptive (e.g. weight by phase
//    size, or split a remaining-budget pool dynamically). Currently a flat
//    cap from settings — simpler and predictable.
// ---------------------------------------------------------------------------
