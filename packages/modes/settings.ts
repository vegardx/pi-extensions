/**
 * Settings readers for the modes extension.
 *
 * Pure helpers that read `extensionConfig.modes.*` values from the
 * nearest settings file and validate/sanitise them. No side-effects
 * beyond warning via the caller-provided `notify` function.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import {
	DEFAULT_COMPACTION_TIMEOUT_MS,
	DEFAULT_PHASE_TOKENS,
	DEFAULT_SUMMARY_TOKENS,
	DEFAULT_WORKING_TOKENS,
} from "./plan/compaction.js";
import { DEFAULT_RESEARCH_TIMEOUT_MS } from "./plan/delegate-tools.js";
import {
	DEFAULT_PARALLELISM,
	DEFAULT_QUEUE_DEPTH_THRESHOLD,
	sanitiseParallelism,
	sanitiseQueueDepthThreshold,
} from "./plan/explore-mailbox.js";
import {
	type ImplementMode,
	type Mode,
	resolveDefaultMode,
	resolveImplementDefault,
} from "./types.js";

const EXT_ID = "modes";

/** Callback signature for user-visible warnings from settings readers. */
export type NotifyFn = (
	ctx: ExtensionContext,
	msg: string,
	level?: "info" | "warning" | "error",
) => void;

// ---- Internal config access helpers ---------------------------------------

function modesExtCfg(
	ctx: ExtensionContext,
): Record<string, unknown> | undefined {
	const settings = readRelevantSettings(ctx.cwd);
	return settings.extensionConfig?.[EXT_ID] as
		| Record<string, unknown>
		| undefined;
}

function compactionCfg(
	ctx: ExtensionContext,
): Record<string, unknown> | undefined {
	return modesExtCfg(ctx)?.compaction as Record<string, unknown> | undefined;
}

// ---- Readers --------------------------------------------------------------

export function readCompactionNumber(
	ctx: ExtensionContext,
	key: string,
	fallback: number,
): number {
	const raw = compactionCfg(ctx)?.[key];
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.floor(raw);
	}
	return fallback;
}

export function readPhaseTokensSetting(ctx: ExtensionContext): number {
	return readCompactionNumber(ctx, "phaseTokens", DEFAULT_PHASE_TOKENS);
}

export function readWorkingTokensSetting(ctx: ExtensionContext): number {
	return readCompactionNumber(ctx, "workingTokens", DEFAULT_WORKING_TOKENS);
}

export function readSummaryTokensSetting(ctx: ExtensionContext): number {
	return readCompactionNumber(ctx, "summaryTokens", DEFAULT_SUMMARY_TOKENS);
}

/**
 * Plan-mode footer cap. Returns null when the user hasn't set a
 * positive override — the footer then falls back to the model's
 * contextWindow. Pure display: nothing in the runtime enforces this.
 */
export function readPlanMaxContextTokensSetting(
	ctx: ExtensionContext,
): number | null {
	const raw = compactionCfg(ctx)?.planMaxContextTokens;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.floor(raw);
	}
	return null;
}

export function readCompactionTimeoutMs(ctx: ExtensionContext): number {
	return readCompactionNumber(ctx, "timeoutMs", DEFAULT_COMPACTION_TIMEOUT_MS);
}

export function readDefaultModeSetting(ctx: ExtensionContext): {
	mode: Mode;
	valid: boolean;
} {
	const modeCfg = modesExtCfg(ctx)?.mode as Record<string, unknown> | undefined;
	return resolveDefaultMode(modeCfg?.default);
}

export function readImplementDefaultSetting(ctx: ExtensionContext): {
	mode: ImplementMode;
	valid: boolean;
} {
	const implementCfg = modesExtCfg(ctx)?.implement as
		| Record<string, unknown>
		| undefined;
	return resolveImplementDefault(implementCfg?.default);
}

export function readResearchTimeoutMs(ctx: ExtensionContext): number {
	const researchCfg = modesExtCfg(ctx)?.research as
		| Record<string, unknown>
		| undefined;
	const raw = researchCfg?.timeoutMs;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.floor(raw);
	}
	return DEFAULT_RESEARCH_TIMEOUT_MS;
}

/**
 * Read `extensionConfig.modes.explore.{parallelism,queueDepthThreshold}`.
 *
 * Both values are sanitised the same way the mailbox itself does
 * (positive numbers floored to integer; everything else falls back
 * to the default). When the user supplied something that fell back
 * we emit a one-line warning so they know the setting was ignored.
 */
export function readExploreSettings(
	ctx: ExtensionContext,
	notify: NotifyFn,
): {
	parallelism: number;
	queueDepthThreshold: number;
} {
	const explore = modesExtCfg(ctx)?.explore as
		| Record<string, unknown>
		| undefined;
	const parallelism = readSanitisedNumber(
		ctx,
		notify,
		explore?.parallelism,
		"extensionConfig.modes.explore.parallelism",
		DEFAULT_PARALLELISM,
		sanitiseParallelism,
	);
	const queueDepthThreshold = readSanitisedNumber(
		ctx,
		notify,
		explore?.queueDepthThreshold,
		"extensionConfig.modes.explore.queueDepthThreshold",
		DEFAULT_QUEUE_DEPTH_THRESHOLD,
		sanitiseQueueDepthThreshold,
	);
	return { parallelism, queueDepthThreshold };
}

/**
 * Read a numeric setting via the same sanitiser the mailbox uses, and
 * warn only when the user supplied something that fell back to the
 * default. Keeps settings-path behaviour consistent with the
 * constructor-path behaviour for things like `2.7` (floored to 2,
 * not silently rejected).
 */
function readSanitisedNumber(
	ctx: ExtensionContext,
	notify: NotifyFn,
	raw: unknown,
	key: string,
	fallback: number,
	sanitise: (raw: unknown) => number,
): number {
	if (raw === undefined) return fallback;
	const sanitised = sanitise(raw);
	if (sanitised === fallback && raw !== fallback) {
		notify(
			ctx,
			`${key}: ${JSON.stringify(raw)} is not a valid positive number; using default ${fallback}`,
			"warning",
		);
	}
	return sanitised;
}
