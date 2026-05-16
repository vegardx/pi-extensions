/**
 * Pure helpers for token-usage telemetry (#143).
 *
 * Used by:
 *   - `/ship` writePhaseSummary path → `phase.tokens.phase` (sum of
 *     all assistant messages in the phase's auto session)
 *   - mid-phase compaction → `phase.tokens.midPhase[]` (one entry per
 *     compaction)
 *   - end-of-phase summary → `phase.tokens.summary` (single LLM call)
 *   - footer cache-tokens segment (cumulative from current session)
 *   - PR body line at /ship time
 *
 * Pure: no I/O. Pi's pi-ai `Usage` type is flattened to the four
 * fields we surface plus optional cost.
 */

import type { Usage } from "@mariozechner/pi-ai";
import type { TokenUsage } from "./schema.js";

/**
 * Convert pi-ai's `Usage` to our flattened `TokenUsage`. Drops
 * provider-specific fields (`totalTokens`, per-bucket cost). Preserves
 * the aggregate cost as a single number when available.
 *
 * Returns `null` when the input is missing/incomplete — e.g. an
 * assistant message that the provider returned without usage data.
 * Callers fold the null contribution out via {@link addUsage}.
 */
export function fromAiUsage(
	usage: Usage | null | undefined,
): TokenUsage | null {
	if (!usage) return null;
	const result: TokenUsage = {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
	};
	if (typeof usage.cost?.total === "number") {
		result.cost = usage.cost.total;
	}
	return result;
}

/** A token usage where every numeric field is zero and cost is absent. */
export function zeroUsage(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Sum two token usages. `cost` is folded only when both inputs have it
 * — if either contributor is missing cost data, the result drops cost
 * to encode "unknown" rather than understating the total. `null`
 * contributions are treated as zero.
 */
export function addUsage(
	a: TokenUsage | null | undefined,
	b: TokenUsage | null | undefined,
): TokenUsage {
	const lhs = a ?? zeroUsage();
	const rhs = b ?? zeroUsage();
	const result: TokenUsage = {
		input: lhs.input + rhs.input,
		output: lhs.output + rhs.output,
		cacheRead: lhs.cacheRead + rhs.cacheRead,
		cacheWrite: lhs.cacheWrite + rhs.cacheWrite,
	};
	if (a && b && typeof a.cost === "number" && typeof b.cost === "number") {
		result.cost = a.cost + b.cost;
	} else if (!a && b && typeof b.cost === "number") {
		result.cost = b.cost;
	} else if (a && !b && typeof a.cost === "number") {
		result.cost = a.cost;
	}
	return result;
}

/**
 * Walk a list of session entries and sum every assistant message's
 * usage. Non-message / non-assistant entries are ignored. Useful both
 * for footer cache-tokens display (cumulative session usage) and for
 * computing `phase.tokens.phase` at /ship time.
 *
 * The structural type below avoids a hard dependency on
 * `@mariozechner/pi-coding-agent`'s `SessionEntry` union: callers pass
 * either `SessionEntry[]` (live from `sessionManager.getEntries()`)
 * or stripped fixtures.
 */
export interface AssistantishEntry {
	type: string;
	message?: {
		role?: string;
		usage?: Usage;
	};
}

export function aggregateAssistantUsage(
	entries: ReadonlyArray<AssistantishEntry>,
): TokenUsage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let costSum = 0;
	let contributors = 0;
	let costContributors = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const usage = fromAiUsage(entry.message.usage);
		if (!usage) continue;
		contributors++;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		if (typeof usage.cost === "number") {
			costSum += usage.cost;
			costContributors++;
		}
	}
	if (contributors === 0) return zeroUsage();
	const result: TokenUsage = { input, output, cacheRead, cacheWrite };
	// Surface cost only when every contributor reported it — a partial
	// sum would understate the total, so encode "unknown" by omission.
	if (costContributors === contributors) result.cost = costSum;
	return result;
}

/**
 * Format a token count for the footer / PR body. Compact: 12345 →
 * `12.3k`, 1234567 → `1.23M`. Below 1000 the raw number wins.
 */
export function formatTokenCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = Math.round(n / 100) / 10;
		if (k >= 100) return `${Math.round(k)}k`;
		return `${k.toFixed(1)}k`;
	}
	const m = Math.round(n / 10_000) / 100;
	if (m >= 100) return `${Math.round(m)}M`;
	return `${m.toFixed(2)}M`;
}

/**
 * Format a USD cost. Sub-cent values render as `$0.00`; otherwise two
 * decimals. Used in both the footer (compact) and the PR body
 * (human-readable).
 */
export function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	if (usd < 100) return `$${usd.toFixed(2)}`;
	return `$${Math.round(usd)}`;
}

/**
 * Format a `cache <r> r / <w> w` segment for the footer, given a
 * cumulative {@link TokenUsage}. Returns null when both buckets are
 * zero — callers drop the segment entirely so the footer doesn't
 * show `cache 0 r / 0 w` on every fresh session.
 */
export function formatCacheSegment(usage: TokenUsage): string | null {
	if (usage.cacheRead === 0 && usage.cacheWrite === 0) return null;
	return `cache ${formatTokenCount(usage.cacheRead)} r / ${formatTokenCount(usage.cacheWrite)} w`;
}
