/**
 * Phase-boundary compaction for the modes plan/phase model.
 *
 * Modes compacts at three trigger points, all using the same shape:
 * summarise a slice of raw messages exactly once, freeze it, append to
 * the rolling summary. Triggers:
 *
 *   1. plan → implement (`/implement` command):
 *      collapses planning chatter into `## Plan` + `## Planning notes`.
 *
 *   2. mid-phase (`turn_end` when context tokens > maxContextTokens):
 *      bounds in-flight context. Section: `## Phase p-X (part N, in progress)`.
 *      A phase that overflows N times produces N+1 slices.
 *
 *   3. phase-end (`/ship` command):
 *      freezes the just-completed phase. Section: `## Phase p-X (part N, shipped, PR #M)`.
 *
 * The append-only invariant: each compaction's summary reuses the
 * previous compaction's summary byte-for-byte as a prefix. Sections are
 * never re-summarised. A phase that ran long is captured as a chain of
 * slices, each summarised once from raw messages — no summary-of-
 * summaries, no quality drift.
 *
 * Pi's `buildSessionContext` only emits the LATEST CompactionEntry on
 * the path (verified in dist/core/session-manager.js), so the most
 * recent summary IS the prompt prefix the model sees after the system
 * prompt. As long as we never regenerate old sections, the prefix stays
 * byte-identical and the prompt cache keeps hitting across phases.
 *
 * This module is intentionally pure: rendering helpers, tree
 * introspection, and orchestrators that take an injected `summarise`
 * callback. The actual LLM client wiring lives at the call site in
 * index.ts.
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
 * Default per-slice summary OUTPUT budget in tokens. Caps `maxTokens`
 * on the summariser call AND is stated in the preamble so the model
 * self-budgets. Override via:
 *   extensionConfig.modes.compaction.phaseTokens
 *
 * Input to the summariser (the conversation being summarised) is
 * unbounded — the cap is on the frozen output that ends up in the
 * prompt prefix on every subsequent turn.
 */
export const DEFAULT_PHASE_TOKENS = 8000;

/**
 * Default mid-phase compaction trigger threshold in tokens. When
 * `getContextUsage().tokens` exceeds this on `turn_end` (in auto mode
 * with an active phase), a `phase-slice` compaction fires. Override via:
 *   extensionConfig.modes.compaction.maxContextTokens
 */
export const DEFAULT_MAX_CONTEXT_TOKENS = 170000;

/** Stored on `CompactionEntry.details` to identify modes compactions. */
export interface ModesCompactionDetails {
	modesKind: "plan-to-implement" | "phase-slice" | "phase-end";
	/**
	 * Phase activated (plan-to-implement), in progress (phase-slice),
	 * or shipped (phase-end).
	 */
	modesPhaseId: string;
}

/** Data stored on the breadcrumb custom entry. */
export interface PhaseBoundaryData {
	phaseId: string;
	kind: "plan-to-implement" | "phase-slice" | "phase-end";
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
 * @param partN - 1-indexed part number for slice/end compactions; when
 *   > 1, the preamble notes that earlier parts are already captured.
 *   Use 0 (or omit) for plan→implement.
 */
export function buildSummariserPreamble(
	plan: Plan,
	completedPhase: PlanPhase | null,
	maxTokens: number,
	partN: number = 0,
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
		if (partN > 1) {
			lines.push("");
			lines.push(
				`This is **part ${partN}** of the phase. Earlier parts are already captured`,
				"verbatim in the rolling summary above. Focus on what this slice adds —",
				"do NOT restate work covered by previous parts.",
			);
		}
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
		`Stay within ~${maxTokens} output tokens — this is a MAXIMUM, not a quota.`,
		"If the slice contains little of value, return a short summary. Do not pad.",
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

/**
 * `## Phase ...` section emitted at phase-slice or phase-end compactions.
 * Title format is locked:
 *   in-progress: ## Phase `p-X` — Title (part N, in progress)
 *   end:         ## Phase `p-X` — Title (part N, shipped, PR #M)
 *
 * `partN` is always emitted, even for N=1, so the rendering code is
 * conditional-free.
 */
export function renderPhaseSection(args: {
	phase: PlanPhase;
	body: string;
	partN: number;
	kind: "in-progress" | "end";
}): string {
	const { phase, body, partN, kind } = args;
	let stateText: string;
	if (kind === "in-progress") {
		stateText = "in progress";
	} else {
		stateText =
			phase.prNumber !== undefined
				? `shipped, PR #${phase.prNumber}`
				: "shipped";
	}
	return `## Phase \`${phase.id}\` — ${phase.title} (part ${partN}, ${stateText})\n\n${body}`;
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
	if (
		d.modesKind !== "plan-to-implement" &&
		d.modesKind !== "phase-slice" &&
		d.modesKind !== "phase-end"
	) {
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
 * Count phase-slice + phase-end compactions for the given phaseId on
 * the current branch. Used to compute the next slice's `part N` index.
 * Returns 0 for phases with no slices yet (so the next slice will be
 * `part 1`).
 */
export function countPhaseSlicesOnBranch(
	sm: SessionManager,
	phaseId: string,
): number {
	let n = 0;
	for (const e of sm.getBranch()) {
		const d = getModesDetails(e);
		if (
			(d?.modesKind === "phase-slice" || d?.modesKind === "phase-end") &&
			d.modesPhaseId === phaseId
		) {
			n++;
		}
	}
	return n;
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
 * Append a phase slice compaction. Two flavours:
 *
 *   - `kind: "in-progress"` — fired by the mid-phase trigger when context
 *     exceeds `maxContextTokens`. Multiple slices per phase are valid;
 *     no idempotency check.
 *   - `kind: "end"` — fired by `/ship` when the phase is shipped.
 *     Idempotent: returns null without appending if a phase-end
 *     compaction for this phase already exists.
 *
 * Both flavours: summarise messages-since-last-compaction with a
 * preamble that names upcoming phases, append a marker + compaction.
 * The new compaction's summary = previous summary verbatim + new
 * `## Phase` section.
 *
 * Section title:
 *   in-progress: `## Phase p-X (part N, in progress)`
 *   end:         `## Phase p-X (part N, shipped, PR #M)`
 *
 * Returns the new compaction's id, or null on summariser error
 * (clean rollback) or idempotency skip.
 *
 * Throws if `phaseId` is not in the plan (indicates a wiring bug).
 */
export async function appendPhaseSliceCompaction(
	opts: AppendCompactionOptions & {
		phaseId: string;
		kind: "in-progress" | "end";
	},
): Promise<string | null> {
	const {
		sm,
		plan,
		summarise,
		maxTokens,
		tokensBefore,
		signal,
		phaseId,
		kind,
	} = opts;

	if (kind === "end" && hasPhaseEndCompaction(sm, phaseId)) return null;

	const phase = plan.phases.find((p) => p.id === phaseId);
	if (!phase) {
		throw new Error(
			`appendPhaseSliceCompaction: phase ${phaseId} not found in plan ${plan.slug}`,
		);
	}

	const partN = countPhaseSlicesOnBranch(sm, phaseId) + 1;
	const messages = collectMessagesSinceLastCompaction(sm);

	let body = "(no recorded work)";
	if (messages.length > 0) {
		const preamble = buildSummariserPreamble(plan, phase, maxTokens, partN);
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
	const summary = buildSummary(
		prev,
		renderPhaseSection({ phase, body, partN, kind }),
	);

	const boundaryKind = kind === "in-progress" ? "phase-slice" : "phase-end";
	const markerId = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {
		phaseId,
		kind: boundaryKind,
	} satisfies PhaseBoundaryData);

	return sm.appendCompaction(
		summary,
		markerId,
		tokensBefore,
		{
			modesKind: boundaryKind,
			modesPhaseId: phaseId,
		} satisfies ModesCompactionDetails,
		true,
	);
}

// ---------------------------------------------------------------------------
// Mid-phase compaction trigger gate
// ---------------------------------------------------------------------------

export interface MidPhaseTriggerInput {
	/** Runtime probe result; false disables the entire feature. */
	compactionApiAvailable: boolean;
	/** Current modes mode, or null when no session has hydrated. */
	mode: "plan" | "auto" | "hack" | null;
	/** True while a compaction is in flight. Re-entrancy guard. */
	compactionInFlight: boolean;
	/** Whether the plan has an active phase. */
	hasActivePhase: boolean;
	/**
	 * Latest token count from `getContextUsage().tokens`. Pi reports
	 * `null` immediately after a compaction — we treat that as "don't
	 * fire yet, wait for the next turn".
	 */
	tokens: number | null | undefined;
	/** Configured trigger threshold (extensionConfig.modes.compaction.maxContextTokens). */
	maxContextTokens: number;
}

/**
 * Pure gate for the mid-phase compaction `turn_end` handler. Returns
 * true iff a phase-slice compaction should fire this turn.
 *
 * Order matters: cheaper checks come first so most turn_end events
 * short-circuit without touching the plan tree or session manager.
 *
 *   1. compactionApiAvailable — runtime probe at session_start
 *   2. mode === "auto" — only modes-driven execution; hack/plan/ask skip
 *   3. !compactionInFlight — re-entrancy guard for slow LLM calls
 *   4. plan + active phase exist
 *   5. tokens (number) > maxContextTokens
 *
 * Caller is responsible for setting/clearing `compactionInFlight`
 * around the actual fire.
 */
export function shouldCompactMidPhase(input: MidPhaseTriggerInput): boolean {
	if (!input.compactionApiAvailable) return false;
	if (input.mode !== "auto") return false;
	if (input.compactionInFlight) return false;
	if (!input.hasActivePhase) return false;
	if (typeof input.tokens !== "number") return false;
	if (input.tokens <= input.maxContextTokens) return false;
	return true;
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
// 3. `maxContextTokens` is currently an absolute number. Could accept a
//    `"70%"` string for percentage of the active model's contextWindow,
//    so the threshold tracks the model.
// ---------------------------------------------------------------------------
