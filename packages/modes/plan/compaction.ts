/**
 * Phase-boundary compaction for the modes plan/phase model.
 *
 * ---------------------------------------------------------------------
 * Mid-phase compaction flow.
 * ---------------------------------------------------------------------
 *
 * Driven by pi via `ctx.compact()` → `session_before_compact` event →
 * our handler returns `{ compaction: { summary, firstKeptEntryId,
 * tokensBefore, details } }`. Pi then runs `appendCompaction` AND
 * rebuilds `agent.state.messages = sessionContext.messages` — the
 * rebuild step that the pre-Phase-1 direct-write path skipped, which is
 * the bug that made every prior modes compaction a runtime no-op
 * (the LLM kept seeing the full pre-compaction transcript and the
 * mid-phase trigger re-fired every turn).
 *
 * Builder: `buildPhaseSliceCompactionResult(...)`. Pure. The
 * `firstKeptEntryId` and `tokensBefore` come from pi's `preparation`
 * (it computed them via `findCutPoint` and we trust it).
 * `previousSummary` is read off the branch via
 * `findLatestCompactionSummary` and prefixed to the new section,
 * preserving the append-only invariant below.
 *
 * Plan→implement compaction is gone (replaced by `seedPlanDoc` in
 * `plan/seed.ts`). Phase-end compaction is gone (replaced by the
 * per-phase `phase.summary` written at /ship time and inlined into
 * future phases' seeds; see `buildPhaseEndSummaryPreamble`).
 *
 * ---------------------------------------------------------------------
 * Append-only summary invariant (within one auto session).
 * ---------------------------------------------------------------------
 *
 * Each mid-phase compaction's summary reuses the previous compaction's
 * summary byte-for-byte as a prefix. Sections are never re-summarised.
 * A phase that ran long is captured as a chain of slices, each
 * summarised once from raw messages — no summary-of-summaries, no
 * quality drift.
 *
 * Pi's `buildSessionContext` only emits the LATEST CompactionEntry on
 * the path (verified in dist/core/session-manager.js), so the most
 * recent summary IS the prompt prefix the model sees after the system
 * prompt. As long as we never regenerate old sections, the prefix stays
 * byte-identical and the prompt cache keeps hitting across mid-phase
 * boundaries within the auto session.
 *
 * This module is intentionally pure: rendering helpers, tree
 * introspection, and builders that take an injected `summarise`
 * callback. The actual LLM client wiring lives at the call site in
 * index.ts.
 *
 * ---------------------------------------------------------------------
 * Four-bucket context budget model
 * ---------------------------------------------------------------------
 *
 * The live auto-session context is decomposed into four buckets, in
 * prefix order (sys → seed → summary → work). Order matches the API
 * request layout and the direction the KV-cache reuses (longest stable
 * prefix first):
 *
 *   sys      — system prompt + active tool schemas. Stable.
 *   seed     — plan-doc seed entry written at
 *              `ctx.newSession({ setup })`. Stable for the phase's
 *              lifetime.
 *   summary  — rolling compaction summary (latest CompactionEntry on
 *              the branch). Grows on each mid-phase compaction.
 *   work     — live messages since the most recent compaction. Hot
 *              tail; resets at every compaction.
 *
 * Two configurable budgets:
 *
 *   workingTokens  — covers `sys + work`. Mid-phase compaction fires
 *                    when this is exceeded.
 *   summaryTokens  — cumulative cross-phase carry-forward cap (Σ
 *                    `phase.summary` chars across shipped phases).
 *                    Soft-warn when exceeded; not enforced.
 *
 * Total target ceiling = workingTokens + summaryTokens. Tune both so
 * the total fits the active model's contextWindow.
 *
 * Mid-phase trigger semantics:
 *
 *   fire iff (total − summary − seed) > workingTokens
 *
 * i.e. the working portion (sys + work) crossed its budget. Both the
 * rolling summary AND the carry-forward seed are stable prefix content
 * and never trigger compaction themselves. Compaction shrinks `work`
 * and grows `summary` by ~phaseTokens; net effect is the working budget
 * relaxes while the summary budget incrementally fills.
 */

import type {
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import type { Plan, Phase as PlanPhase, TokenUsage } from "./schema.js";
import { effectivePhaseKind, TERMINAL_STATUSES } from "./schema.js";

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
 * Default cumulative cross-phase carry-forward budget in tokens.
 * Bounds the sum of `phase.summary` chars across all shipped phases
 * — i.e. the total carry-forward weight inlined into a future phase's
 * `seedPlanDoc`. Soft-warns once when exceeded; not enforced (dropping
 * older summaries silently would lose the discovery signal).
 *
 * Total target ceiling = `workingTokens + summaryTokens` — tune so the
 * total fits the active model's `contextWindow`. Override via:
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

/**
 * Result of a single summariser invocation. `text` is the assistant's
 * text reply (already trimmed). `usage` is the LLM call's token cost
 * when available — absent when the underlying provider didn't expose
 * one. The pre-#143 surface was just `string | null`; widened so
 * callers can record per-phase token telemetry.
 */
export interface SummariseOutput {
	text: string;
	usage?: TokenUsage;
}

export type SummariseFn = (args: {
	messages: AgentMessage[];
	preamble: string;
	maxTokens: number;
	signal?: AbortSignal;
}) => Promise<SummariseOutput | null>;

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
		const kind = effectivePhaseKind(p);
		const kindMarker = kind === "regular" ? "" : ` [${kind}]`;
		lines.push(
			`- \`${p.id}\`${kindMarker} [${p.status}]${pr} — ${p.title}: ${p.goal}`,
		);
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
	/**
	 * Token usage of the summariser call that produced `summary`.
	 * Absent when the body fell back to `(no recorded work)` (no LLM
	 * call fired) or when the provider didn't expose usage data. Used
	 * by the caller to populate `phase.tokens.midPhase[]`.
	 */
	usage?: TokenUsage;
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
	let usage: TokenUsage | undefined;
	if (messages.length > 0) {
		const preamble = buildSummariserPreamble(plan, phase, maxTokens, partN);
		const out = await summarise({
			messages,
			preamble,
			maxTokens,
			signal,
		});
		if (out === null) return null;
		body = out.text.trim();
		usage = out.usage;
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
		usage,
	};
}

// ---------------------------------------------------------------------------
// Mid-phase compaction trigger gate
// ---------------------------------------------------------------------------

/**
 * Cumulative cross-phase carry-forward summary chars. Sum of
 * `phase.summary.length` across every shipped phase preceding the
 * active one. This is what `compaction.summaryTokens` actually
 * bounds in the post-Phase-2 model: the size of the carry-forward
 * payload that future phases' seeds will inline. Pure; no I/O.
 */
export function computeCarryForwardSummaryChars(
	plan: Pick<Plan, "phases">,
): number {
	let n = 0;
	for (const phase of plan.phases) {
		if (phase.status === "shipped" && phase.summary) {
			n += phase.summary.length;
		}
	}
	return n;
}

export interface MidPhaseTriggerInput {
	/** Runtime probe result; false disables the entire feature. */
	compactionApiAvailable: boolean;
	/** Current modes mode, or null when no session has hydrated. */
	mode: "plan" | "auto" | "ask" | "hack" | null;
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
	/**
	 * Observed plan-doc seed token count for this auto session.
	 * Estimated from the `modes:plan-seed` custom message entry.
	 * Subtracted from `tokens` before comparing against `workingTokens`
	 * so a large carry-forward seed doesn't penalise the working
	 * budget. 0 when no seed is present (legacy / orphan / off-plan
	 * sessions).
	 */
	seedTokens: number;
}

/**
 * Pure gate for the mid-phase compaction `turn_end` handler. Returns
 * true iff a phase-slice compaction should fire this turn.
 *
 * Order matters: cheaper checks come first so most turn_end events
 * short-circuit without touching the plan tree or session manager.
 *
 *   1. compactionApiAvailable — runtime probe at session_start
 *   2. mode ∈ {"auto", "ask"} — modes-driven plan execution; hack/plan skip
 *   3. !compactionInFlight — re-entrancy guard for slow LLM calls
 *   4. plan + active phase exist
 *   5. (tokens − summaryTokens − seedTokens) > workingTokens
 *
 * Step 5 isolates the working budget: both the rolling summary AND the
 * plan-doc seed are stable prefix content that never trigger compaction
 * themselves. The trigger only fires when `sys + work` crosses
 * `workingTokens`.
 *
 * Caller is responsible for setting/clearing `compactionInFlight`
 * around the actual fire.
 */
export function shouldCompactMidPhase(input: MidPhaseTriggerInput): boolean {
	if (!input.compactionApiAvailable) return false;
	if (input.mode !== "auto" && input.mode !== "ask") return false;
	if (input.compactionInFlight) return false;
	if (!input.hasActivePhase) return false;
	if (typeof input.tokens !== "number") return false;
	const workingUsed = input.tokens - input.summaryTokens - input.seedTokens;
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
	/** System prompt + active tool schemas. Stable per session. */
	sys: number;
	/**
	 * Plan-doc seed (the `modes:plan-seed` custom message entry written
	 * at `ctx.newSession({ setup })` time). Stable for the phase's
	 * lifetime. Reported separately from `sys` so the footer can show
	 * carry-forward weight, but treated as part of the stable prefix
	 * for the working-budget trigger — the trigger only cares about
	 * the hot tail.
	 */
	seed: number;
	/** Latest compaction summary (rolling summary text). */
	summary: number;
	/**
	 * Live messages since last compaction breadcrumb.
	 * Computed as `max(0, total − sys − seed − summary)` when total is known.
	 */
	work: number;
	/** Authoritative total from `getContextUsage().tokens`, or null. */
	total: number | null;
}

/**
 * Compute the four-bucket breakdown from raw character counts plus
 * pi's reported total. Pure, deterministic; no I/O.
 *
 * Inputs are character counts (not token estimates) so the chars/4
 * conversion happens in one place. `total` is taken verbatim from
 * `getContextUsage().tokens` — it's authoritative; the bucket numbers
 * are estimates that should approximately sum to it.
 *
 * When `total` is null (e.g. immediately after a compaction, before
 * the next LLM response), `work` is reported as 0 — the working
 * portion is genuinely unknown until pi reports a fresh count.
 * `sys`, `seed`, and `summary` remain valid (they don't depend on
 * `total`).
 */
export function computeContextBuckets(input: {
	total: number | null;
	systemPromptChars: number;
	toolSchemaChars: number;
	summaryChars: number;
	/**
	 * Char count of the active session's `modes:plan-seed` entry, or 0
	 * when no seed exists (plan-mode session, hack mode, off-plan auto).
	 */
	seedChars: number;
}): ContextBuckets {
	const sys = Math.ceil((input.systemPromptChars + input.toolSchemaChars) / 4);
	const seed = Math.ceil(input.seedChars / 4);
	const summary = Math.ceil(input.summaryChars / 4);
	const work =
		input.total === null ? 0 : Math.max(0, input.total - sys - seed - summary);
	return { sys, seed, summary, work, total: input.total };
}

// ---------------------------------------------------------------------------
// Post-compaction continuation gate
// ---------------------------------------------------------------------------

/**
 * Inputs to {@link shouldResumeAfterCompaction}. Pure-function shape
 * mirrors what the call site can cheaply gather from `modeState` plus
 * the loaded plan; no session-manager access.
 */
export interface ResumeAfterCompactionInput {
	/** True iff `ctx.compact()` resolved without throwing. */
	compacted: boolean;
	/** Stage captured at compactPhaseSlice entry. */
	stageAtEntry: string | null | undefined;
	/** Mode captured at compactPhaseSlice entry. */
	modeAtEntry: string | null | undefined;
	/** Stage on `modeState` right now (after `ctx.compact()` resolved). */
	currentStage: string | null | undefined;
	/** Mode on `modeState` right now (after `ctx.compact()` resolved). */
	currentMode: string | null | undefined;
	/**
	 * Number of incomplete tasks in the active phase. 0 when there's no
	 * active phase or every task is done.
	 */
	remainingTaskCount: number;
}

/**
 * Decide whether to kick a follow-up turn after a successful mid-phase
 * compaction.
 *
 * Five gates:
 *
 *   1. The compaction actually completed. On rejection (no compaction
 *      model, summariser failure, pi already-compacted) we let pi's
 *      auto-compaction handle the next overflow rather than poking
 *      the agent into a turn it isn't ready for.
 *
 *   2. We entered compactPhaseSlice while `executing`. The Shift+Tab
 *      hack→plan transition path also calls compactPhaseSlice, but
 *      with `idle` (the user is leaving auto, not staying in it) — we
 *      must not synthesise a turn for them.
 *
 *   3. We're _still_ executing now. `ctx.compact()` is async; while it
 *      ran the user could have hit Shift+Tab and left auto. If the
 *      stage drifted, the original kick is no longer wanted.
 *
 *   4. The mode hasn't changed mid-flight. Same drift concern: a
 *      Shift+Tab from auto to hack/plan during compaction must not
 *      result in an auto-mode follow-up turn.
 *
 *   5. The active phase has work left. If every task is already toggled
 *      done, the agent_end exec-complete handler is the right driver,
 *      not us.
 */
export function shouldResumeAfterCompaction(
	input: ResumeAfterCompactionInput,
): boolean {
	if (!input.compacted) return false;
	if (input.stageAtEntry !== "executing") return false;
	if (input.currentStage !== "executing") return false;
	if (input.modeAtEntry !== input.currentMode) return false;
	if (input.remainingTaskCount <= 0) return false;
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
// ---------------------------------------------------------------------------

/**
 * Returns the markdown content for the plan-summary message that is
 * emitted into chat immediately before the plan-ready picker dialog
 * fires. Returns `null` when:
 *   - no plan exists, or
 *   - the picker resolved to `"bail"` (nothing actionable to pick).
 *
 * Exported for unit testing; `runPicker` is the only production caller.
 */
export function planSummaryContent(
	plan: Plan | null | undefined,
	viewAction: string,
): string | null {
	if (!plan || viewAction === "bail") return null;
	return renderPlanSection(plan);
}
