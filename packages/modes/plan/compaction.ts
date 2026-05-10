/**
 * Phase-boundary compaction for the modes plan/phase model.
 *
 * ---------------------------------------------------------------------
 * Two flows live in this file (transitionally).
 * ---------------------------------------------------------------------
 *
 * (A) Mid-phase compaction — the post-fix path.
 *
 *     Driven by pi via `ctx.compact()` → `session_before_compact` event
 *     → our handler returns `{ compaction: { summary, firstKeptEntryId,
 *     tokensBefore, details } }`. Pi then runs `appendCompaction` AND
 *     rebuilds `agent.state.messages = sessionContext.messages` — the
 *     rebuild step that the legacy direct-write path skipped, which is
 *     the bug that made every prior modes compaction a runtime no-op
 *     (the LLM kept seeing the full pre-compaction transcript and the
 *     mid-phase trigger re-fired every turn).
 *
 *     Builder: `buildPhaseSliceCompactionResult(...)`. Pure. The
 *     `firstKeptEntryId` and `tokensBefore` come from pi's
 *     `preparation` (it computed them via `findCutPoint` and we trust
 *     it). `previousSummary` is read off the branch via
 *     `findLatestCompactionSummary` and prefixed to the new section,
 *     preserving the append-only invariant below.
 *
 * (B) Plan→implement compaction — legacy direct-write path.
 *
 *     `appendPlanToImplementCompaction` still calls
 *     `sm.appendCompaction` directly. It carries the same bug as the
 *     pre-fix mid-phase path (the agent.state.messages rebuild never
 *     happens), but is being deleted in Phase 2 of the plan in favour
 *     of a deterministic plan-doc seed written via `ctx.newSession({
 *     setup })`. Not worth fixing in the current PR.
 *
 *     Phase-end compaction at /ship has been deleted; per-phase
 *     summaries move onto the plan doc in Phase 2 (also see
 *     `compactPhaseEnd` in index.ts — currently a stub).
 *
 * ---------------------------------------------------------------------
 * Append-only summary invariant.
 * ---------------------------------------------------------------------
 *
 * Each compaction's summary reuses the previous compaction's summary
 * byte-for-byte as a prefix. Sections are never re-summarised. A phase
 * that ran long is captured as a chain of slices, each summarised once
 * from raw messages — no summary-of-summaries, no quality drift.
 *
 * Pi's `buildSessionContext` only emits the LATEST CompactionEntry on
 * the path (verified in dist/core/session-manager.js), so the most
 * recent summary IS the prompt prefix the model sees after the system
 * prompt. As long as we never regenerate old sections, the prefix stays
 * byte-identical and the prompt cache keeps hitting across phases.
 *
 * This module is intentionally pure: rendering helpers, tree
 * introspection, and builders/orchestrators that take an injected
 * `summarise` callback. The actual LLM client wiring lives at the call
 * site in index.ts.
 *
 * ---------------------------------------------------------------------
 * Three-bucket context budget model
 * ---------------------------------------------------------------------
 *
 * The live context is decomposed into three buckets, in prefix order
 * (sys → summary → work). Order matches the API request layout and the
 * direction the KV-cache reuses (longest stable prefix first):
 *
 *   sys      — system prompt + active tool schemas. Stable prefix.
 *   summary  — rolling compaction summary (latest CompactionEntry on
 *              the branch). Grows on each compaction.
 *   work     — live messages since the most recent compaction. Hot
 *              tail; resets at every compaction.
 *
 * Two configurable budgets:
 *
 *   workingTokens  — covers `sys + work`. Mid-phase compaction fires
 *                    when this is exceeded.
 *   summaryTokens  — covers `summary`. Soft-warn when exceeded; not
 *                    enforced.
 *
 * (Phase 2 of the plan reframes `summaryTokens` as the cumulative
 * cross-phase carry-forward budget once per-phase summaries move onto
 * the plan doc. The shape of the soft-warn stays the same.)
 *
 * Total target ceiling = workingTokens + summaryTokens. Tune both so
 * the total fits the active model's contextWindow.
 *
 * Mid-phase trigger semantics:
 *
 *   fire iff (total - summary) > workingTokens
 *
 * i.e. the working portion (sys + work) crossed its budget. Summary
 * tokens never trigger compaction themselves — they live in their own
 * budget. Compaction shrinks `work` and grows `summary` by ~phaseTokens;
 * net effect is the working budget relaxes while the summary budget
 * incrementally fills.
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
 *
 * @deprecated The new mid-phase path reuses pi's chosen `firstKeptEntryId`
 * from `preparation` (no marker needed). Kept exported for one release
 * so old session files containing these custom entries still type-check
 * if anyone walks them.
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
export const DEFAULT_PHASE_TOKENS = 10000;

/**
 * Default working-budget threshold in tokens. Working budget covers
 * `sys + work` (system prompt + tool schemas + live messages since the
 * last compaction). Mid-phase compaction fires when this is exceeded.
 * Summary tokens live in their own budget (see `summaryTokens`) and do
 * NOT count toward this trigger. Override via:
 *   extensionConfig.modes.compaction.workingTokens
 */
export const DEFAULT_WORKING_TOKENS = 150000;

/**
 * Default rolling-summary budget in tokens. Each mid-phase compaction
 * adds to the summary. Soft-warns when exceeded; not enforced. Total
 * target ceiling = `workingTokens + summaryTokens` — tune so the total
 * fits the active model's `contextWindow`. Override via:
 *   extensionConfig.modes.compaction.summaryTokens
 */
export const DEFAULT_SUMMARY_TOKENS = 100000;

/**
 * Default plan-mode footer cap in tokens. 0 is a sentinel meaning
 * "use the active model's contextWindow" — plan mode is exempt from
 * modes' mid-phase compaction (see `shouldCompactMidPhase`), so the
 * cap is purely a footer display threshold. Override via:
 *   extensionConfig.modes.compaction.planMaxContextTokens
 */
export const DEFAULT_PLAN_MAX_CONTEXT_TOKENS = 0;

/** Stored on `CompactionEntry.details` to identify modes compactions. */
export interface ModesCompactionDetails {
	modesKind: "phase-slice";
	/** Phase whose slice this compaction summarises. */
	modesPhaseId: string;
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
 * @param activePhase - phase whose work is being summarised
 * @param maxTokens - output token cap, also stated in the prompt
 * @param partN - 1-indexed part number; when > 1, the preamble notes
 *   that earlier parts are already captured in the rolling summary.
 */
export function buildSummariserPreamble(
	plan: Plan,
	activePhase: PlanPhase,
	maxTokens: number,
	partN: number = 1,
): string {
	const upcoming = plan.phases.filter(
		(p) => !TERMINAL_STATUSES.includes(p.status) && p.id !== activePhase.id,
	);

	const lines: string[] = [
		"You are summarising work on a software project so the next phases can",
		"continue without re-reading the full conversation.",
		"",
		`Currently working on phase \`${activePhase.id}\` — ${activePhase.title}`,
		`Goal: ${activePhase.goal}`,
		"",
		"This phase is NOT done yet — context grew large enough to trigger a",
		"mid-phase compaction. Summarise the work-so-far accurately; the phase",
		"will continue after this slice. Do NOT claim the phase is finished.",
	];
	if (partN > 1) {
		lines.push("");
		lines.push(
			`This is **part ${partN}** of the phase. Earlier parts are already captured`,
			"verbatim in the rolling summary above. Focus on what this slice adds —",
			"do NOT restate work covered by previous parts.",
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
 * Preamble for the phase-end summary written to `phase.summary` at
 * /ship time. Different framing from the mid-phase preamble: this
 * summary will be carried forward into FUTURE phases' seeds, so the
 * model needs to think about what diverged from the original plan,
 * not just what was done.
 *
 * Quote: "Everyone has a plan until they get hit in the face." The
 * captured-divergence framing is the whole point — the plan-doc
 * already says what we INTENDED, the summary captures what actually
 * happened that future phases should know about.
 */
export function buildPhaseEndSummaryPreamble(
	plan: Plan,
	phase: PlanPhase,
	maxTokens: number,
): string {
	const upcoming = plan.phases.filter(
		(p) => !TERMINAL_STATUSES.includes(p.status) && p.id !== phase.id,
	);

	const lines: string[] = [
		`Phase \`${phase.id}\` (${phase.title}) is shipping. Future phases of`,
		"this plan need to know what was discovered, decided, or changed that",
		"they otherwise might miss or rediscover the hard way.",
		"",
		"*Everyone has a plan until they get hit in the face* — capture what",
		"diverged from the original plan, what new constraints surfaced, and",
		"what future phases must know to avoid repeating mistakes.",
		"",
		`Goal of the just-shipped phase: ${phase.goal}`,
		"",
	];

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
	lines.push("  ## What shipped");
	lines.push("  - concrete outcomes; commits, files, behavioural changes");
	lines.push("  ## Discoveries that change the plan");
	lines.push(
		"  - things the original plan didn't anticipate that downstream phases",
	);
	lines.push("    must accommodate");
	lines.push("  ## Files / identifiers future phases will touch");
	lines.push(
		"  - file paths, function names, schema fragments, type names — verbatim",
	);
	lines.push("  ## Don't repeat / pitfalls");
	lines.push(
		"  - failed attempts, dead ends, gotchas the next phase shouldn't rediscover",
	);
	lines.push("");
	lines.push(
		`Stay within ~${maxTokens} output tokens — this is a MAXIMUM, not a quota.`,
		"If a section has nothing valuable, write `(none)`. Do not pad.",
	);

	return lines.join("\n");
}

/**
 * `## Phase ...` section emitted at mid-phase compactions. Title format
 * is locked: `## Phase \`p-X\` — Title (part N, in progress)`. `partN`
 * is always emitted, even for N=1.
 */
export function renderPhaseSection(args: {
	phase: PlanPhase;
	body: string;
	partN: number;
}): string {
	const { phase, body, partN } = args;
	return `## Phase \`${phase.id}\` — ${phase.title} (part ${partN}, in progress)\n\n${body}`;
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
	if (d.modesKind !== "phase-slice") return undefined;
	if (typeof d.modesPhaseId !== "string") return undefined;
	return { modesKind: d.modesKind, modesPhaseId: d.modesPhaseId };
}

/**
 * Count phase-slice compactions for the given phaseId on the current
 * branch. Used to compute the next slice's `part N` index. Returns 0
 * for phases with no slices yet (so the next slice will be `part 1`).
 */
export function countPhaseSlicesOnBranch(
	sm: SessionManager,
	phaseId: string,
): number {
	let n = 0;
	for (const e of sm.getBranch()) {
		const d = getModesDetails(e);
		if (d?.modesKind === "phase-slice" && d.modesPhaseId === phaseId) {
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
// Mid-phase summary builder for the `session_before_compact` extension hook
// ---------------------------------------------------------------------------
//
// This is the path used by mid-phase compaction post-fix. Pi drives the
// flow via `ctx.compact()` → `session_before_compact` event → our handler
// returns `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`.
// Pi then runs `appendCompaction` AND rebuilds `agent.state.messages` from
// the post-compaction session context, which is what the legacy
// `appendPhaseSliceCompaction` path failed to do.
//
// Pi's `prepareCompaction` already supplies:
//   - firstKeptEntryId (computed from `keepRecentTokens` cut point — pi
//     keeps the last ~20k tokens of recent turns to preserve the agent's
//     train of thought; we reuse this verbatim).
//   - tokensBefore (estimateContextTokens of the pre-compaction context).
//   - previousSummary (the latest CompactionEntry's summary on the branch,
//     i.e. the rolling-summary prefix we extend).
//   - messagesToSummarize (boundaryStart..historyEnd; we ignore this and
//     summarise everything since the last compaction ourselves, since
//     `collectMessagesSinceLastCompaction` already encodes the modes shape).

/** Output of `buildPhaseSliceCompactionResult`, fed back to pi. */
export interface PhaseSliceCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: ModesCompactionDetails;
}

export interface BuildPhaseSliceCompactionOptions {
	sm: SessionManager;
	plan: Plan;
	summarise: SummariseFn;
	/** Output token cap for the summariser. */
	maxTokens: number;
	/** From `preparation.tokensBefore`. */
	tokensBefore: number;
	/** From `preparation.firstKeptEntryId` — what pi wants to keep. */
	firstKeptEntryId: string;
	phaseId: string;
	signal?: AbortSignal;
}

/**
 * Pure builder for a phase-slice (mid-phase) compaction. Returns the
 * payload pi expects from `session_before_compact`, or null when the
 * summariser fails.
 *
 * When there are zero messages since the last compaction (a phase
 * slice fired immediately after a previous compaction with no
 * intervening turns) the body is set to a `(no recorded work)`
 * placeholder and a non-null result is returned — the rolling-summary
 * prefix invariant still wants a fresh section appended.
 *
 * Throws if `phaseId` is not in the plan (indicates a wiring bug).
 *
 * Notes vs. the legacy `appendPhaseSliceCompaction`:
 *   - No `appendCustomEntry` marker. We pass through pi's chosen
 *     `firstKeptEntryId` directly — pi computed it via `findCutPoint`
 *     and we trust it.
 *   - No `appendCompaction` here. Pi appends after our handler returns,
 *     and (critically) refreshes `agent.state.messages` afterwards.
 *   - `kind` is fixed to `"in-progress"` (`modesKind: "phase-slice"`).
 *     Phase-end compaction is being deleted; per-phase summaries move
 *     onto the plan doc in Phase 2 of the plan.
 */
export async function buildPhaseSliceCompactionResult(
	opts: BuildPhaseSliceCompactionOptions,
): Promise<PhaseSliceCompactionResult | null> {
	const {
		sm,
		plan,
		summarise,
		maxTokens,
		tokensBefore,
		firstKeptEntryId,
		phaseId,
		signal,
	} = opts;

	const phase = plan.phases.find((p) => p.id === phaseId);
	if (!phase) {
		throw new Error(
			`buildPhaseSliceCompactionResult: phase ${phaseId} not found in plan ${plan.slug}`,
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
		renderPhaseSection({ phase, body, partN }),
	);

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: {
			modesKind: "phase-slice",
			modesPhaseId: phaseId,
		} satisfies ModesCompactionDetails,
	};
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
	/** Configured working budget (extensionConfig.modes.compaction.workingTokens). */
	workingTokens: number;
	/**
	 * Observed rolling-summary token count (NOT the budget). Estimated
	 * from the latest CompactionEntry's summary text. Subtracted from
	 * `tokens` before comparing against `workingTokens` so summary
	 * growth alone never triggers compaction.
	 */
	summaryTokens: number;
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
 *   5. (tokens − summaryTokens) > workingTokens
 *
 * Step 5 isolates the working budget: summary tokens live in their
 * own budget (`summaryTokens`) and never trigger compaction
 * themselves. The trigger only fires when sys + work crosses
 * `workingTokens`.
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
	const workingUsed = input.tokens - input.summaryTokens;
	if (workingUsed <= input.workingTokens) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Pure context-bucket computation — shared between footer and trigger.
// ---------------------------------------------------------------------------

/**
 * Snapshot of how the live context decomposes into the three buckets.
 * All token values are estimates derived from chars/4, matching pi's
 * internal `estimateTokens` heuristic for text content.
 */
export interface ContextBuckets {
	/** System prompt + active tool schemas (stable prefix). */
	sys: number;
	/** Latest compaction summary (rolling summary text). */
	summary: number;
	/**
	 * Live messages since last compaction breadcrumb.
	 * Computed as `max(0, total − sys − summary)` when total is known.
	 */
	work: number;
	/** Authoritative total from `getContextUsage().tokens`, or null. */
	total: number | null;
}

/**
 * Compute the three-bucket breakdown from raw character counts plus
 * pi's reported total. Pure, deterministic; no I/O.
 *
 * Inputs are character counts (not token estimates) so the chars/4
 * conversion happens in one place. `total` is taken verbatim from
 * `getContextUsage().tokens` — it's authoritative; the bucket numbers
 * are estimates that should approximately sum to it.
 *
 * When `total` is null (e.g. immediately after a compaction, before
 * the next LLM response), `work` is reported as 0 — the working
 * portion is genuinely unknown until pi reports a fresh count. `sys`
 * and `summary` remain valid (they don't depend on `total`).
 */
export function computeContextBuckets(input: {
	total: number | null;
	systemPromptChars: number;
	toolSchemaChars: number;
	summaryChars: number;
}): ContextBuckets {
	const sys = Math.ceil((input.systemPromptChars + input.toolSchemaChars) / 4);
	const summary = Math.ceil(input.summaryChars / 4);
	const work =
		input.total === null ? 0 : Math.max(0, input.total - sys - summary);
	return { sys, summary, work, total: input.total };
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
// ---------------------------------------------------------------------------
