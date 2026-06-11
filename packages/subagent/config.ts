/**
 * Config readers for the subagent extension, ported from modes'
 * delegate helpers when the tool moved here.
 */

import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";

export const EXT_ID = "subagent";

/**
 * Hard cap (characters) on a delegated answer before it crosses back
 * into the caller's context. Keeps delegation context-slimming honest.
 */
export const DEFAULT_DELEGATE_MAX_CHARS = 6000;

/**
 * Cap on concurrent delegate executions — backpressure for a burst of
 * parallel `delegate` calls (pi runs a turn's tool calls via
 * Promise.all with no cap of its own).
 */
export const DEFAULT_DELEGATE_MAX_CONCURRENT = 10;

function readDelegateCfg(cwd: string): Record<string, unknown> | undefined {
	const settings = readRelevantSettings(cwd);
	const extCfg = settings.extensionConfig?.[EXT_ID] as
		| Record<string, unknown>
		| undefined;
	return extCfg?.delegate as Record<string, unknown> | undefined;
}

/**
 * Read `extensionConfig.subagent.delegate.maxAnswerChars` — the hard
 * cap on a delegated answer's size before it crosses back into the
 * caller's context.
 */
export function readDelegateMaxChars(cwd: string): number {
	const raw = readDelegateCfg(cwd)?.maxAnswerChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return Math.floor(raw);
	}
	return DEFAULT_DELEGATE_MAX_CHARS;
}

/**
 * Read `extensionConfig.subagent.delegate.maxConcurrent` — the cap on
 * concurrent delegate executions. Require >= 1: a fractional value
 * like 0.5 would floor to 0, which the semaphore treats as uncapped —
 * the opposite of intent.
 */
export function readDelegateMaxConcurrent(cwd: string): number {
	const raw = readDelegateCfg(cwd)?.maxConcurrent;
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
		return Math.floor(raw);
	}
	return DEFAULT_DELEGATE_MAX_CONCURRENT;
}

/** Hard-cap a delegated answer; append a marker when truncated. */
export function capDelegatedAnswer(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const marker = `\n\n[…delegated answer truncated at ${cap} chars]`;
	// Reserve room for the marker so the FINAL string stays within `cap`
	// (a tiny cap below the marker length degrades to marker-only).
	const room = Math.max(0, cap - marker.length);
	return text.slice(0, room) + marker;
}
