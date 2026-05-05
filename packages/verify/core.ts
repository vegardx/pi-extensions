/**
 * Pure verify run — used by both `/verify`'s command handler and
 * `/develop`'s auto-verify loop. The loop bypasses the slash-command
 * dispatch entirely (`pi.sendUserMessage("/cmd")` is hard-coded to
 * skip slash expansion in pi-coding-agent ≤ 0.73.0; see
 * badlogic/pi-mono#2549/#2994/#3673) and calls `runVerify(...)`
 * directly with a pre-resolved plan.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";

export const EXT_ID = "verify";

const PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"verify.md",
);

/** /develop's session-state entry type — read to find the most recent plan. */
const DEVELOP_STATE_ENTRY = "develop-state";

/** Audit-log entries for the develop ↔ verify coordination, kept for
 *  diagnostic / session-resume purposes. They are no longer used as a
 *  transport — `/develop` calls `runVerify(...)` directly. */
export const VERIFY_REQUEST_ENTRY = "develop-verify-request";
export const VERIFY_RESULT_ENTRY = "develop-verify-result";

interface DevelopStateLike {
	planText?: string;
	branch?: string;
	phase?: string;
	todos?: { step: number; text: string }[];
}

export interface PlanStep {
	step: number;
	text: string;
}

export interface VerifierVerdict {
	step: number;
	status: "done" | "partial" | "missing" | "unverifiable";
	reason: string;
	suggestion?: string;
}

// ---- Plan parsing -------------------------------------------------------
//
// Duplicated from packages/develop/plan-utils.ts so /verify can stand on
// its own without cross-package imports. If both packages stabilize on
// this, fold into packages/_shared/plan.ts and have both consume it.

function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 200) cleaned = `${cleaned.slice(0, 197)}...`;
	return cleaned;
}

export function extractPlanSteps(message: string): PlanStep[] {
	const items: PlanStep[] = [];
	const headerMatch = message.match(/(^|\n)#{0,6}\s*\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(
		message.indexOf(headerMatch[0]) + headerMatch[0].length,
	);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^\n]+)/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const raw = (match[2] ?? "")
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (
			raw.length > 5 &&
			!raw.startsWith("`") &&
			!raw.startsWith("/") &&
			!raw.startsWith("-")
		) {
			const cleaned = cleanStepText(raw);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned });
			}
		}
	}
	return items;
}

// ---- Plan source resolution ---------------------------------------------

/**
 * Find the most-recent plan from `/develop`'s session state. Returns
 * `null` if no `develop-state` entry exists or it has no plan text.
 */
function planFromDevelopState(ctx: ExtensionContext): string | null {
	let latest: DevelopStateLike | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === DEVELOP_STATE_ENTRY) {
			latest = entry.data as DevelopStateLike;
		}
	}
	if (!latest?.planText) return null;
	return latest.planText;
}

/**
 * Resolve the plan text /verify should operate on. Resolution order:
 *
 *   1. `arg` is provided and points at an existing readable file → file content.
 *   2. `arg` is provided otherwise → arg as inline plan text.
 *   3. /develop session state has a plan → use it.
 *   4. Show a picker offering /develop's plan (if any) plus a
 *      "paste plan inline" option.
 *
 * Returns `null` if the user cancels or nothing usable resolves.
 */
async function resolvePlan(
	ctx: ExtensionCommandContext,
	arg: string,
): Promise<string | null> {
	const trimmed = arg.trim();

	if (trimmed) {
		const asPath = resolve(ctx.cwd, trimmed);
		if (existsSync(asPath)) {
			try {
				if (statSync(asPath).isFile()) {
					return readFileSync(asPath, "utf8");
				}
				if (ctx.hasUI) {
					ctx.ui.notify(
						`verify: "${trimmed}" exists but isn't a regular file; provide a file path or inline plan text`,
						"warning",
					);
				}
				return null;
			} catch {
				// stat or read failed — fall through to inline interpretation.
			}
		}
		return trimmed;
	}

	const fromDevelop = planFromDevelopState(ctx);

	if (!ctx.hasUI) {
		return fromDevelop;
	}

	const PASTE_OPTION = "Paste / type a plan inline";
	const CANCEL_OPTION = "Cancel";
	const options: string[] = [];
	if (fromDevelop) options.push("Use the plan from /develop's last session");
	options.push(PASTE_OPTION);
	options.push(CANCEL_OPTION);

	const choice = await ctx.ui.select(
		"What plan should /verify check?",
		options,
	);
	if (!choice || choice === CANCEL_OPTION) return null;
	if (choice === PASTE_OPTION) {
		const text = await ctx.ui.editor("Paste the plan:");
		return text?.trim() ? text : null;
	}
	return fromDevelop;
}

// ---- Verifier output parsing --------------------------------------------

/**
 * Validate one verdict-shaped object and coerce it into a
 * `VerifierVerdict`. Returns `null` if the shape is wrong; callers
 * decide how to surface the failure.
 */
function coerceVerdict(parsed: unknown): VerifierVerdict | null {
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		typeof (parsed as Record<string, unknown>).step === "number" &&
		((parsed as Record<string, unknown>).status === "done" ||
			(parsed as Record<string, unknown>).status === "partial" ||
			(parsed as Record<string, unknown>).status === "missing" ||
			(parsed as Record<string, unknown>).status === "unverifiable") &&
		typeof (parsed as Record<string, unknown>).reason === "string"
	) {
		const rec = parsed as Record<string, unknown>;
		return {
			step: rec.step as number,
			status: rec.status as VerifierVerdict["status"],
			reason: rec.reason as string,
			suggestion:
				typeof rec.suggestion === "string" && rec.suggestion
					? (rec.suggestion as string)
					: undefined,
		};
	}
	return null;
}

export function parseVerdict(rawText: string): VerifierVerdict | null {
	const trimmed = rawText.trim();
	if (!trimmed) return null;

	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
	const payload = fence ? (fence[1] ?? "").trim() : trimmed;

	try {
		const parsed = JSON.parse(payload);
		return coerceVerdict(parsed);
	} catch {
		return null;
	}
}

/**
 * Parse the single-subagent batch output: a JSON array of verdict
 * objects, one per plan step. Tolerates code-fence wrapping (the
 * system prompt forbids it, but models occasionally still wrap).
 *
 * Invalid elements are dropped silently — callers cross-check the
 * returned `step` numbers against the expected plan and surface
 * any missing steps as verifier errors.
 *
 * Returns `null` when the response can't be parsed as a JSON array
 * at all (the host treats this as a hard failure that errors every
 * step). Returns an empty array `[]` when the model legitimately
 * had no input to verify.
 */
export function parseVerdictArray(
	rawText: string,
): readonly VerifierVerdict[] | null {
	const trimmed = rawText.trim();
	if (!trimmed) return null;

	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
	const payload = fence ? (fence[1] ?? "").trim() : trimmed;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;

	const out: VerifierVerdict[] = [];
	for (const entry of parsed) {
		const v = coerceVerdict(entry);
		if (v) out.push(v);
	}
	return out;
}

// ---- Report rendering ---------------------------------------------------

const STATUS_GLYPHS: Record<VerifierVerdict["status"], string> = {
	done: "✓",
	partial: "⚠",
	missing: "✗",
	unverifiable: "?",
};

function renderReport(
	steps: PlanStep[],
	verdicts: Map<number, VerifierVerdict>,
	errors: Map<number, string>,
	resolvedModel: string,
): string {
	const lines: string[] = [];
	lines.push(`/verify — model ${resolvedModel}, ${steps.length} step(s)`);
	lines.push("");

	for (const s of steps) {
		const v = verdicts.get(s.step);
		const err = errors.get(s.step);
		if (v) {
			lines.push(`  ${STATUS_GLYPHS[v.status]} ${s.step}. ${s.text}`);
			lines.push(`        ${v.reason}`);
			if (v.suggestion) lines.push(`        → ${v.suggestion}`);
		} else if (err) {
			lines.push(`  ! ${s.step}. ${s.text}`);
			lines.push(`        verifier failed: ${err}`);
		} else {
			lines.push(`  ? ${s.step}. ${s.text}`);
			lines.push(`        no result`);
		}
	}

	const counts = { done: 0, partial: 0, missing: 0, unverifiable: 0 };
	for (const v of verdicts.values()) counts[v.status]++;
	const errCount = errors.size;
	lines.push("");
	lines.push(
		`${counts.done} done · ${counts.partial} partial · ${counts.missing} missing · ${counts.unverifiable} unverifiable${
			errCount ? ` · ${errCount} errored` : ""
		}`,
	);
	return lines.join("\n");
}

// ---- Live progress widget ---------------------------------------------
//
// `/verify` runs a single subagent that returns all verdicts at once,
// so we can't show genuine per-step progress while it runs. The widget
// instead renders the plan-step *scope* (so the user sees what's
// being checked) and flips each line's glyph from `⏳` to the
// verdict status as soon as the batch returns. It's brief by design —
// the report message that follows carries the same data in a richer
// form, and the widget clears once the report is sent.

const VERIFY_PROGRESS_WIDGET = "verify-progress";
const PROGRESS_TEXT_MAX = 60;

function truncateForWidget(text: string): string {
	if (text.length <= PROGRESS_TEXT_MAX) return text;
	return `${text.slice(0, PROGRESS_TEXT_MAX - 1).trimEnd()}…`;
}

function renderProgressWidget(
	steps: readonly PlanStep[],
	verdicts: ReadonlyMap<number, VerifierVerdict> | undefined,
	errors: ReadonlyMap<number, string> | undefined,
	resolvedModel: string,
): string[] {
	const lines: string[] = [];
	const total = steps.length;
	let done = 0;
	if (verdicts) done = verdicts.size + (errors?.size ?? 0);
	const header = verdicts
		? `🔍 verify (${done}/${total} done, model ${resolvedModel})`
		: `🔍 verify (${total} step(s), model ${resolvedModel})`;
	lines.push(header);
	for (const s of steps) {
		const v = verdicts?.get(s.step);
		const err = errors?.get(s.step);
		let glyph: string;
		if (v) glyph = STATUS_GLYPHS[v.status];
		else if (err) glyph = "!";
		else if (verdicts)
			glyph = "?"; // post-fan-out, no result
		else glyph = "⏳"; // running
		lines.push(`  ${glyph} ${s.step}. ${truncateForWidget(s.text)}`);
	}
	return lines;
}

// ---- Settings ----------------------------------------------------------
//
// `/verify` no longer fans out per-step subagents (it runs a single
// subagent that returns an array of verdicts), so the legacy
// `extensionConfig.verify.maxParallel` knob is no longer consulted.
// We keep no settings reader here — the per-extension `model`
// override is handled by `resolveModel` directly.

// ---- Auto-mode detection (audit-log helper) -----------------------------
//
// Historically `/verify` consulted these entries to decide whether
// `/develop` was driving (auto mode) or the user was running it
// standalone. With the in-process refactor `/develop` calls
// `runVerify({ autoMode: true })` directly, so this helper is no
// longer on the hot path. We keep it exported because:
//   - the existing unit tests cover it,
//   - it's still useful for diagnostics ("did /develop ask for a verify
//     run that hasn't been answered yet?").

interface DevelopVerifyRequest {
	iteration?: number;
	planText?: string;
	branch?: string;
}

interface DevelopVerifyResultPrior {
	iteration?: number;
}

/**
 * Pure helper: given an ordered list of session entries, decide
 * whether there is an unanswered develop-verify-request. Returns the
 * request iteration when one exists (latest request iteration > latest
 * result iteration), else `null`.
 */
export function findAutoModeIteration(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): number | null {
	let latestRequest: DevelopVerifyRequest | undefined;
	let latestResult: DevelopVerifyResultPrior | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === VERIFY_REQUEST_ENTRY) {
			latestRequest = entry.data as DevelopVerifyRequest;
		} else if (entry.customType === VERIFY_RESULT_ENTRY) {
			latestResult = entry.data as DevelopVerifyResultPrior;
		}
	}
	const reqIter = latestRequest?.iteration;
	if (typeof reqIter !== "number") return null;
	const resIter = latestResult?.iteration ?? 0;
	if (reqIter > resIter) return reqIter;
	return null;
}

// ---- Public entry point -------------------------------------------------

export interface RunVerifyOptions {
	/** Required for sessionManager / cwd / signal / ui. */
	ctx: ExtensionCommandContext;
	/** Required for sendMessage / appendEntry. */
	pi: ExtensionAPI;
	/** Pre-resolved plan text. When provided, `arg` is ignored. */
	planText?: string;
	/** Raw command argument (file path / inline / empty). Used when planText is absent. */
	arg?: string;
	/**
	 * When true, suppress the post-result findings picker and write a
	 * `develop-verify-result` entry. Set by `/develop` when it drives
	 * the auto-loop directly.
	 */
	autoMode?: boolean;
	/** Iteration to record on the develop-verify-result entry. Required when autoMode. */
	iteration?: number;
}

export interface RunVerifyResult {
	/** True iff a verify run actually completed (vs. aborted before fan-out). */
	ran: boolean;
	/** When !ran, the reason. */
	abortReason?: "no-plan" | "no-steps" | "no-model";
	planText?: string;
	steps?: PlanStep[];
	verdicts?: VerifierVerdict[];
	errors?: { step: number; error: string }[];
	model?: string;
}

export async function runVerify(
	opts: RunVerifyOptions,
): Promise<RunVerifyResult> {
	const { ctx, pi, autoMode = false, iteration } = opts;

	const planText =
		opts.planText !== undefined
			? opts.planText
			: await resolvePlan(ctx, opts.arg ?? "");
	if (!planText) {
		if (ctx.hasUI) ctx.ui.notify("verify: no plan to verify", "info");
		return { ran: false, abortReason: "no-plan" };
	}

	const steps = extractPlanSteps(planText);
	if (steps.length === 0) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				"verify: couldn't find numbered steps under a `Plan:` header",
				"warning",
			);
		}
		return { ran: false, abortReason: "no-steps", planText };
	}

	const resolved = await resolveModel(ctx, {
		name: EXT_ID,
		tier: "fast",
		set: "primary",
	});
	if (!resolved) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				"verify: no usable model (set backgroundModels.primary.fast or extensionConfig.verify.model in settings.json)",
				"warning",
			);
		}
		return { ran: false, abortReason: "no-model", planText, steps };
	}
	const resolvedModelSpec = `${resolved.model.provider}/${resolved.model.id}`;

	if (ctx.hasUI) {
		ctx.ui.notify(
			`verify: running ${steps.length}-step batch (model ${resolvedModelSpec}${
				autoMode ? `, auto-mode iter ${iteration ?? "?"}` : ""
			})`,
			"info",
		);
		ctx.ui.setStatus(EXT_ID, `verify: ${steps.length} steps`);
		ctx.ui.setWidget(
			VERIFY_PROGRESS_WIDGET,
			renderProgressWidget(steps, undefined, undefined, resolvedModelSpec),
		);
	}

	const clearProgress = () => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(EXT_ID, undefined);
		ctx.ui.setWidget(VERIFY_PROGRESS_WIDGET, undefined);
	};

	// Single-subagent fan-in: one read-only subagent walks the whole
	// plan and returns a JSON array of verdicts. Trades the previous
	// per-step parallelism (and its error-isolation) for ~10× cheaper
	// runs and a simpler control flow. Reliability is recovered by
	// cross-checking each returned `step` field against the expected
	// step set: missing steps surface as verifier errors per-step,
	// extras are ignored. The host pi process stays out of the verify
	// model context (the subagent runs against its own RpcClient with
	// `--no-session`), so verify never pollutes the active session.
	const outcome = await runSubagent({
		tag: 0,
		task: buildPlanTask(steps),
		systemPromptPath: PROMPT_PATH,
		provider: resolved.model.provider,
		model: resolved.model.id,
		cwd: ctx.cwd,
		signal: ctx.signal,
	});

	const verdictsMap = new Map<number, VerifierVerdict>();
	const errorsMap = new Map<number, string>();

	if (outcome.error) {
		// Subagent failed to start, crashed, or aborted. Every step
		// becomes a verifier error so the report still aligns with the
		// plan.
		for (const s of steps) errorsMap.set(s.step, outcome.error);
	} else {
		const parsed = parseVerdictArray(outcome.rawText);
		if (parsed === null) {
			const snippet = outcome.rawText.slice(0, 200);
			for (const s of steps) {
				errorsMap.set(
					s.step,
					`subagent output was not a JSON array: ${snippet}`,
				);
			}
		} else {
			const expectedSteps = new Set(steps.map((s) => s.step));
			for (const v of parsed) {
				if (!expectedSteps.has(v.step)) {
					// Extra/fabricated step — ignore.
					continue;
				}
				verdictsMap.set(v.step, v);
			}
			for (const s of steps) {
				if (!verdictsMap.has(s.step)) {
					errorsMap.set(
						s.step,
						"subagent did not return a verdict for this step",
					);
				}
			}
		}
	}

	if (ctx.hasUI) {
		// Show the final state in the widget for one render before
		// clearing it on return. The visible report has the same data
		// in a richer form, so a brief flash is enough.
		ctx.ui.setWidget(
			VERIFY_PROGRESS_WIDGET,
			renderProgressWidget(steps, verdictsMap, errorsMap, resolvedModelSpec),
		);
	}

	const verdicts = Array.from(verdictsMap.values());
	const errors = Array.from(errorsMap.entries()).map(([step, error]) => ({
		step,
		error,
	}));

	const report = renderReport(steps, verdictsMap, errorsMap, resolvedModelSpec);
	pi.sendMessage(
		{
			customType: "verify-report",
			content: report,
			display: true,
			details: {
				steps: steps.length,
				verdicts,
				errors,
				model: resolvedModelSpec,
			},
		},
		{ triggerTurn: false },
	);

	// The report message has the same data as the widget but in
	// richer form; clear the widget once it's been sent.
	clearProgress();

	const concerns = verdicts.filter(
		(v) => v.status === "partial" || v.status === "missing",
	);

	// Auto mode: write the audit-log result entry and return — the
	// caller (e.g. /develop's loop driver) will react to the result.
	if (autoMode) {
		pi.appendEntry(VERIFY_RESULT_ENTRY, {
			iteration: iteration ?? 0,
			verdicts,
			errorCount: errors.length,
			model: resolvedModelSpec,
			completedAt: Date.now(),
		});
		return {
			ran: true,
			planText,
			steps,
			verdicts,
			errors,
			model: resolvedModelSpec,
		};
	}

	// Standalone: post-result picker.
	if (!ctx.hasUI) {
		return {
			ran: true,
			planText,
			steps,
			verdicts,
			errors,
			model: resolvedModelSpec,
		};
	}
	const totalConcerns = concerns.length + errors.length;
	if (totalConcerns === 0) {
		ctx.ui.notify("verify: all steps look done", "info");
		return {
			ran: true,
			planText,
			steps,
			verdicts,
			errors,
			model: resolvedModelSpec,
		};
	}

	const SEND_OPTION = "Send findings to the agent (it'll address them)";
	const SAVE_OPTION = "Save findings, I'll handle them";
	const DISMISS_OPTION = "Dismiss — verifier was wrong / not actionable";
	const choice = await ctx.ui.select(
		`verify: ${concerns.length} concern(s)${errors.length > 0 ? `, ${errors.length} error(s)` : ""}. Now what?`,
		[SEND_OPTION, SAVE_OPTION, DISMISS_OPTION],
	);
	if (!choice || choice === DISMISS_OPTION) {
		return {
			ran: true,
			planText,
			steps,
			verdicts,
			errors,
			model: resolvedModelSpec,
		};
	}
	if (choice === SAVE_OPTION) {
		ctx.ui.notify("verify: findings saved in session entry", "info");
		return {
			ran: true,
			planText,
			steps,
			verdicts,
			errors,
			model: resolvedModelSpec,
		};
	}
	// SEND_OPTION
	const errorsForFollowUp = new Map(errors.map((e) => [e.step, e.error]));
	const msg = buildAgentFollowUp(steps, concerns, errorsForFollowUp);
	pi.sendMessage(
		{
			customType: "verify-followup",
			content: msg,
			display: false,
			details: {
				concernCount: concerns.length,
				errorCount: errors.length,
			},
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
	return {
		ran: true,
		planText,
		steps,
		verdicts,
		errors,
		model: resolvedModelSpec,
	};
}

// ---- Task / follow-up payload assembly ---------------------------------

/**
 * Build the single-subagent task payload: the full plan plus an
 * instruction to return one verdict per step in a JSON array.
 */
function buildPlanTask(steps: readonly PlanStep[]): string {
	const planList = steps.map((s) => `${s.step}. ${s.text}`).join("\n");
	return [
		"You are verifying a development plan against the working tree.",
		"Walk every numbered step below and return a JSON array with",
		"one verdict object per step, in plan order. The schema is in",
		"your system prompt; emit the array and nothing else.",
		"",
		"## Plan",
		"",
		planList,
		"",
		`Emit exactly ${steps.length} verdict object(s), one per step.`,
	].join("\n");
}

function buildAgentFollowUp(
	steps: readonly PlanStep[],
	concerns: readonly VerifierVerdict[],
	errors: ReadonlyMap<number, string>,
): string {
	const lines: string[] = [];
	lines.push(
		"The /verify subagent walked the plan and flagged the following",
		"concerns. Address each one directly:",
		"",
		"- For `partial`: complete the step. Use the suggestion if helpful.",
		"- For `missing`: do the step. Use the suggestion if helpful.",
		"- For verifier errors: investigate why the verifier failed; if",
		"  the step is actually done, say so and skip.",
		"",
		"For each concern, report briefly which you addressed and which",
		"you skipped (with one-line reasons).",
		"",
	);

	for (const c of concerns) {
		const stepText = steps.find((s) => s.step === c.step)?.text ?? "(unknown)";
		lines.push(`### Step ${c.step} — ${c.status.toUpperCase()}`);
		lines.push(`Plan: ${stepText}`);
		lines.push(`Verifier: ${c.reason}`);
		if (c.suggestion) lines.push(`Suggestion: ${c.suggestion}`);
		lines.push("");
	}

	if (errors.size > 0) {
		lines.push("### Verifier errors");
		for (const [step, error] of errors) {
			const stepText = steps.find((s) => s.step === step)?.text ?? "(unknown)";
			lines.push(`- Step ${step} (${stepText}): ${error}`);
		}
	}

	return lines.join("\n");
}
