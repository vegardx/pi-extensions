/**
 * Append-only JSONL telemetry for the #146 A/B comparison between
 * the inline sentinel-protocol path and the cheap-model predictor.
 *
 * One record per agent_end where prompt-suggestion fired. Records
 * are ndjson lines suitable for `jq` slicing during analysis.
 *
 * Disabled by default. Enabled by `extensionConfig.promptSuggestion.abLog`
 * (boolean) — when true, lines are appended to `~/.pi/agent/prompt-suggestion-ab.log`
 * (path overridable for tests).
 *
 * Pure module: takes a path + record and writes synchronously via
 * `appendFileSync`. Best-effort: failures are swallowed (telemetry must
 * never break the suggestion path).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_AB_LOG_PATH = join(
	homedir(),
	".pi",
	"agent",
	"prompt-suggestion-ab.log",
);

/**
 * Single A/B sample. `source` distinguishes the two paths; null
 * `suggestion` records the negative case (no actionable suggestion
 * found — e.g. inline sentinel absent, or predictor returned NONE).
 */
export interface AbSample {
	at: number;
	source: "inline" | "predictor" | "inline-fallback-predictor";
	suggestion: string | null;
	latencyMs: number;
	model?: string;
	stopReason?: string;
	tokens?: { input?: number; output?: number; cacheRead?: number };
	cost?: number;
	notes?: string;
}

/**
 * Append a sample to the JSONL log. Returns `true` on success,
 * `false` if the write failed (telemetry is best-effort; callers
 * should ignore the return value in production code).
 */
export function appendAbSample(path: string, sample: AbSample): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(sample)}\n`);
		return true;
	} catch {
		return false;
	}
}
