import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import {
	runSubagentsParallel,
	type SubagentOutcome,
	type SubagentTask,
} from "@vegardx/pi-extensions-shared/parallel-subagent.js";

const EXT_ID = "verify";
const PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"verify.md",
);

// Default cap on parallel subagents. Each verifier subagent is one full
// (subagent) turn against the configured background model — heavy plans
// can rack up real cost. Users can override via
// `extensionConfig.verify.maxParallel` in settings.json.
const DEFAULT_MAX_PARALLEL = 15;

/**
 * `/develop`'s session-state entry type. We read these to find the most
 * recent plan when `/verify` is invoked with no arguments.
 *
 * Kept intentionally loose — we only care about `planText`. If
 * `/develop`'s state shape evolves we'd prefer this to silently miss
 * the plan (and fall through to the picker) rather than crash.
 */
const DEVELOP_STATE_ENTRY = "develop-state";

interface DevelopStateLike {
	planText?: string;
	branch?: string;
	phase?: string;
	todos?: { step: number; text: string }[];
}

interface PlanStep {
	step: number;
	text: string;
}

interface VerifierVerdict {
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
				// Path exists but isn't a regular file (e.g. directory).
				// Don't silently fall through and treat the path string as
				// inline plan text — that produces nonsense. Stop and tell
				// the user.
				if (ctx.hasUI) {
					ctx.ui.notify(
						`verify: "${trimmed}" exists but isn't a regular file; provide a file path or inline plan text`,
						"warning",
					);
				}
				return null;
			} catch {
				// stat or read failed (permission etc.) — fall through to
				// inline interpretation as a last resort.
			}
		}
		return trimmed;
	}

	// No arg — look at /develop's state, then fall back to the picker.
	const fromDevelop = planFromDevelopState(ctx);

	if (!ctx.hasUI) {
		// Non-interactive (RPC mode etc.) — best we can do is whatever
		// /develop persisted. If nothing there, give up.
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

export function parseVerdict(rawText: string): VerifierVerdict | null {
	const trimmed = rawText.trim();
	if (!trimmed) return null;

	// Tolerate models that wrap the JSON in a code fence even though
	// the system prompt says not to.
	const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
	const payload = fence ? fence[1]!.trim() : trimmed;

	try {
		const parsed = JSON.parse(payload);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof parsed.step === "number" &&
			(parsed.status === "done" ||
				parsed.status === "partial" ||
				parsed.status === "missing" ||
				parsed.status === "unverifiable") &&
			typeof parsed.reason === "string"
		) {
			return {
				step: parsed.step,
				status: parsed.status,
				reason: parsed.reason,
				suggestion:
					typeof parsed.suggestion === "string" && parsed.suggestion
						? parsed.suggestion
						: undefined,
			};
		}
	} catch {
		// fallthrough
	}
	return null;
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

// ---- Settings ----------------------------------------------------------

interface VerifySettings {
	maxParallel?: number;
}

function readVerifySettings(ctx: ExtensionContext): VerifySettings {
	// `extensionConfig.verify` may include knobs beyond `model`. The
	// shared resolver consumes `model` directly via `extensionConfig`;
	// here we read the same key for verify-specific extras.
	try {
		const settings = readRelevantSettings(ctx.cwd);
		const ec = settings.extensionConfig?.[EXT_ID] as
			| (VerifySettings & { model?: string })
			| undefined;
		if (ec && typeof ec.maxParallel === "number" && ec.maxParallel > 0) {
			return { maxParallel: ec.maxParallel };
		}
	} catch {
		// settings unreadable — caller falls back to defaults.
	}
	return {};
}

// ---- /develop coordination ---------------------------------------------
//
// /develop drives an auto-verify loop by writing a `develop-verify-request`
// entry before dispatching `/verify`, and reading our `develop-verify-result`
// entry afterwards. When we detect a request entry whose iteration we
// haven't yet answered, we run in "auto mode":
//
//   - skip the post-result findings picker (the user shouldn't be asked
//     anything; /develop is driving)
//   - write a structured result entry with `{ iteration, verdicts,
//     errorCount, model }` so /develop's loop driver can decide retry
//     vs. bail vs. clean-exit
//   - dispatch `/develop-verify-resume` so /develop's command handler
//     consumes the result and continues the loop
//
// Standalone /verify (no request entry, or last-answered iteration matches)
// keeps its current UX: report + send/save/dismiss picker.

const VERIFY_REQUEST_ENTRY = "develop-verify-request";
const VERIFY_RESULT_ENTRY = "develop-verify-result";

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
 * whether /verify should run in auto mode and at what iteration.
 *
 * Returns the request iteration when there's an unanswered
 * `develop-verify-request` (latest request iteration > latest result
 * iteration), else `null`. Exported so tests don't have to mock the
 * full ExtensionContext.
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

/**
 * Returns the request iteration number when /verify should run in
 * auto mode (i.e. there's an unanswered develop-verify-request), else
 * `null`. Thin wrapper around `findAutoModeIteration` that pulls
 * entries from `ExtensionContext`.
 */
function autoModeIteration(ctx: ExtensionContext): number | null {
	return findAutoModeIteration(
		ctx.sessionManager.getEntries() as readonly {
			type: string;
			customType?: string;
			data?: unknown;
		}[],
	);
}

// ---- Extension factory --------------------------------------------------

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Verify each step of a plan against the working tree using parallel read-only subagents.",
		configSchema: [
			{
				key: "model",
				type: "string",
				fallbackChain:
					"extensionConfig.verify.model → backgroundModels.primary.fast → ctx.model",
				doc: "provider/id override for the verifier model.",
			},
			{
				key: "maxParallel",
				type: "number",
				default: DEFAULT_MAX_PARALLEL,
				doc: "Max concurrent verifier subagents per /verify run.",
			},
		],
		backgroundModelUse: {
			tier: "fast",
			set: "primary",
			explanation:
				"Each plan step spawns one read-only subagent against this model. Bounded structured-output task; fast tier is plenty.",
		},
	});

	pi.registerCommand(EXT_ID, {
		description:
			"Verify each step of a plan against the working tree using parallel read-only subagents.",
		handler: async (args, ctx) => {
			// Detect /develop's auto-verify mode. When set, we suppress the
			// findings picker and dispatch /develop-verify-resume so /develop's
			// loop driver picks up where we left off.
			const autoIteration = autoModeIteration(ctx);
			const inAutoMode = autoIteration !== null;

			const planText = await resolvePlan(ctx, args ?? "");
			if (!planText) {
				ctx.ui.notify("verify: no plan to verify", "info");
				return;
			}

			const steps = extractPlanSteps(planText);
			if (steps.length === 0) {
				ctx.ui.notify(
					"verify: couldn't find numbered steps under a `Plan:` header",
					"warning",
				);
				return;
			}

			// Resolve the verifier model. `primary` set, `fast` tier —
			// bounded structured-output task; the auto-loop runs verify
			// many times so cost matters. No apiKey requirement (the
			// subagent does its own auth via the spawned RPC pi instance).
			const resolved = await resolveModel(ctx, {
				name: EXT_ID,
				tier: "fast",
				set: "primary",
			});
			if (!resolved) {
				ctx.ui.notify(
					"verify: no usable model (set backgroundModels.primary.fast or extensionConfig.verify.model in settings.json)",
					"warning",
				);
				return;
			}
			const resolvedModelSpec = `${resolved.model.provider}/${resolved.model.id}`;

			const settings = readVerifySettings(ctx);
			const maxParallel = settings.maxParallel ?? DEFAULT_MAX_PARALLEL;

			ctx.ui.notify(
				`verify: dispatching ${steps.length} subagent(s) (model ${resolvedModelSpec}, max ${maxParallel} parallel${inAutoMode ? `, auto-mode iter ${autoIteration}` : ""})`,
				"info",
			);

			const tasks: SubagentTask<number>[] = steps.map((s) => ({
				tag: s.step,
				task: buildStepTask(steps, s.step),
				systemPromptPath: PROMPT_PATH,
				provider: resolved.model.provider,
				model: resolved.model.id,
				cwd: ctx.cwd,
				signal: ctx.signal,
			}));

			const outcomes = await runSubagentsParallel(tasks, { maxParallel });
			const verdicts = new Map<number, VerifierVerdict>();
			const errors = new Map<number, string>();
			for (const o of outcomes as SubagentOutcome<number>[]) {
				if (o.error) {
					errors.set(o.tag, o.error);
					continue;
				}
				const parsed = parseVerdict(o.rawText);
				if (!parsed) {
					errors.set(
						o.tag,
						`output was not valid JSON: ${o.rawText.slice(0, 200)}`,
					);
					continue;
				}
				// Cross-check the verdict's `step` against the task tag we
				// sent in. If they disagree the subagent verified the wrong
				// step; trust our tag and surface the mismatch as an error
				// so the misattribution doesn't silently corrupt the report.
				if (parsed.step !== o.tag) {
					errors.set(
						o.tag,
						`subagent returned step=${parsed.step} but was asked about step=${o.tag}; verdict ignored`,
					);
					continue;
				}
				verdicts.set(o.tag, parsed);
			}

			const report = renderReport(steps, verdicts, errors, resolvedModelSpec);
			pi.sendMessage(
				{
					customType: "verify-report",
					content: report,
					display: true,
					details: {
						steps: steps.length,
						verdicts: Array.from(verdicts.values()),
						errors: Array.from(errors.entries()).map(([step, error]) => ({
							step,
							error,
						})),
						model: resolvedModelSpec,
					},
				},
				{ triggerTurn: false },
			);

			const concerns = Array.from(verdicts.values()).filter(
				(v) => v.status === "partial" || v.status === "missing",
			);

			// Auto mode: write a structured result entry for /develop's loop
			// driver and dispatch the resume command. We do NOT run the
			// findings picker — /develop owns the conversation now.
			if (inAutoMode && autoIteration !== null) {
				pi.appendEntry(VERIFY_RESULT_ENTRY, {
					iteration: autoIteration,
					verdicts: Array.from(verdicts.values()),
					errorCount: errors.size,
					model: resolvedModelSpec,
					completedAt: Date.now(),
				});
				const hasResume = pi
					.getCommands()
					.some((c) => c.name === "develop-verify-resume");
				if (hasResume) {
					// Plain dispatch — the /verify command handler is now
					// finishing, so by the time pi processes the queued user
					// message we'll be idle and the slash command will expand
					// into /develop's registered handler.
					pi.sendUserMessage("/develop-verify-resume");
				} else {
					ctx.ui.notify(
						"verify: auto-mode result written but /develop-verify-resume not registered — loop won't continue",
						"warning",
					);
				}
				return;
			}

			// Standalone mode: post-result picker.
			if (!ctx.hasUI) return;
			const totalConcerns = concerns.length + errors.size;
			if (totalConcerns === 0) {
				ctx.ui.notify("verify: all steps look done", "info");
				return;
			}

			const SEND_OPTION = "Send findings to the agent (it'll address them)";
			const SAVE_OPTION = "Save findings, I'll handle them";
			const DISMISS_OPTION = "Dismiss — verifier was wrong / not actionable";
			const choice = await ctx.ui.select(
				`verify: ${concerns.length} concern(s)${errors.size > 0 ? `, ${errors.size} error(s)` : ""}. Now what?`,
				[SEND_OPTION, SAVE_OPTION, DISMISS_OPTION],
			);
			if (!choice || choice === DISMISS_OPTION) return;
			if (choice === SAVE_OPTION) {
				ctx.ui.notify("verify: findings saved in session entry", "info");
				return;
			}
			// SEND_OPTION: inject as a follow-up the agent can act on.
			const msg = buildAgentFollowUp(steps, concerns, errors);
			pi.sendMessage(
				{
					customType: "verify-followup",
					content: msg,
					display: false,
					details: {
						concernCount: concerns.length,
						errorCount: errors.size,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
	});
}

// ---- Task / follow-up payload assembly ---------------------------------

function buildStepTask(steps: readonly PlanStep[], step: number): string {
	const target = steps.find((s) => s.step === step);
	if (!target) return "";
	const planList = steps.map((s) => `${s.step}. ${s.text}`).join("\n");
	return [
		"You are verifying ONE step of a development plan against the",
		"working tree. The full plan is included for context, but only",
		"return a verdict for the step indicated below.",
		"",
		"## Plan",
		"",
		planList,
		"",
		`## Your step: ${target.step}. ${target.text}`,
		"",
		"Return JSON only, matching the schema in your system prompt.",
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
