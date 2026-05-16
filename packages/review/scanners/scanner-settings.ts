/**
 * Per-scanner settings reader for `extensionConfig.review.scanners`.
 *
 * New schema (kebab-case ids matching `ScannerSpec.id`):
 *
 * ```jsonc
 * {
 *   "extensionConfig": {
 *     "review": {
 *       "scanners": {
 *         "default":     { "enable": true, "budgetMs": 30000 },
 *         "tsc":         { "enable": "auto" },
 *         "biome":       { "enable": true },
 *         "eslint":      { "enable": "auto" },
 *         "knip":        { "enable": "auto" },
 *         "semgrep":     { "enable": true, "args": { "rulesets": ["p/typescript", "p/owasp-top-ten"] } },
 *         "npm-audit":   { "enable": "auto" },
 *         "osv-scanner": { "enable": "auto" },
 *         "gitleaks":    { "enable": "auto" },
 *         "madge":       { "enable": false }
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Resolution rules:
 *   1. Per-id entry wins over `default` wins over `spec.defaultEnabled` /
 *      `spec.budgetMs`.
 *   2. `enable: "auto"` resolves via `spec.detectAuto?.(cwd)`; specs with
 *      no detector fall back to `spec.defaultEnabled`.
 *   3. Invalid entries / wrong types fall closed to the next layer
 *      (mirrors the rest of the settings readers in `_shared`).
 *
 * Legacy `extensionConfig.review.staticAnalysis` is read by the
 * existing `static-checker.ts` shim. When the new `scanners` key is
 * present, it takes precedence; otherwise the legacy path stays
 * untouched (back-compat with already-published settings).
 */

import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import type {
	ScannerArgsOptions,
	ScannerOverrides,
	ScannerSpec,
} from "./types.js";

const REVIEW_KEY = "review";
const SCANNERS_KEY = "scanners";
const DEFAULT_ENTRY_KEY = "default";

/** Raw shape of a per-scanner entry under `scanners.<id>`. */
export interface ScannerEntrySettings {
	enable?: boolean | "auto";
	budgetMs?: number;
	args?: ScannerArgsOptions;
}

/** Raw `default` block (no `args` — that's per-spec). */
export interface ScannerDefaultSettings {
	enable?: boolean | "auto";
	budgetMs?: number;
}

/** Parsed view of `extensionConfig.review.scanners`. */
export interface ScannerSettings {
	default?: ScannerDefaultSettings;
	entries: Record<string, ScannerEntrySettings>;
}

export const EMPTY_SCANNER_SETTINGS: Readonly<ScannerSettings> = Object.freeze({
	entries: {},
});

/**
 * Whether a `RelevantSettings` blob has any user-supplied
 * `extensionConfig.review.scanners` config. When `false`, callers
 * should fall back to the legacy `staticAnalysis` reader.
 */
export function hasScannerSettings(settings: RelevantSettings): boolean {
	const review = settings.extensionConfig?.[REVIEW_KEY];
	if (!review || typeof review !== "object" || Array.isArray(review)) {
		return false;
	}
	const raw = (review as Record<string, unknown>)[SCANNERS_KEY];
	return Boolean(raw && typeof raw === "object" && !Array.isArray(raw));
}

/**
 * Parse `extensionConfig.review.scanners` into a `ScannerSettings`
 * view. Unknown keys / wrong types are dropped silently (fail closed).
 */
export function readScannerSettings(
	settings: RelevantSettings,
): ScannerSettings {
	const review = settings.extensionConfig?.[REVIEW_KEY];
	if (!review || typeof review !== "object" || Array.isArray(review)) {
		return { entries: {} };
	}
	const raw = (review as Record<string, unknown>)[SCANNERS_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { entries: {} };
	}

	const result: ScannerSettings = { entries: {} };
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (k === DEFAULT_ENTRY_KEY) {
			const def = parseDefault(v);
			if (def) result.default = def;
			continue;
		}
		const entry = parseEntry(v);
		if (entry) result.entries[k] = entry;
	}
	return result;
}

/**
 * Resolve final per-spec overrides from a `ScannerSettings` view. The
 * resolver walks every spec so callers don't need to know which keys
 * the user supplied. `enable: "auto"` flips to a boolean here so the
 * registry stays oblivious to detection logic.
 */
export function resolveScannerOverrides(
	specs: readonly ScannerSpec[],
	settings: ScannerSettings,
	cwd: string,
): ScannerOverrides {
	const overrides: ScannerOverrides = {};
	const defaults = settings.default ?? {};

	for (const spec of specs) {
		const entry = settings.entries[spec.id];

		const enableRaw = pickFirst(entry?.enable, defaults.enable);
		const budgetMs = pickFirst(entry?.budgetMs, defaults.budgetMs);
		const args = entry?.args;

		const enabled =
			enableRaw === undefined ? undefined : resolveEnable(enableRaw, spec, cwd);

		const o: ScannerOverrides[string] = {};
		if (enabled !== undefined) o.enabled = enabled;
		if (budgetMs !== undefined) o.budgetMs = budgetMs;
		if (args !== undefined) o.args = args;
		if (Object.keys(o).length > 0) overrides[spec.id] = o;
	}

	return overrides;
}

function resolveEnable(
	raw: boolean | "auto",
	spec: ScannerSpec,
	cwd: string,
): boolean {
	if (typeof raw === "boolean") return raw;
	// "auto"
	if (spec.detectAuto) return Boolean(spec.detectAuto(cwd));
	return spec.defaultEnabled;
}

function pickFirst<T>(...values: (T | undefined)[]): T | undefined {
	for (const v of values) if (v !== undefined) return v;
	return undefined;
}

function parseDefault(raw: unknown): ScannerDefaultSettings | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	const out: ScannerDefaultSettings = {};
	const enable = parseEnable(obj.enable);
	if (enable !== undefined) out.enable = enable;
	const budgetMs = parseBudget(obj.budgetMs);
	if (budgetMs !== undefined) out.budgetMs = budgetMs;
	return out;
}

function parseEntry(raw: unknown): ScannerEntrySettings | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const obj = raw as Record<string, unknown>;
	const out: ScannerEntrySettings = {};
	const enable = parseEnable(obj.enable);
	if (enable !== undefined) out.enable = enable;
	const budgetMs = parseBudget(obj.budgetMs);
	if (budgetMs !== undefined) out.budgetMs = budgetMs;
	const args = parseArgs(obj.args);
	if (args !== undefined) out.args = args;
	return out;
}

function parseEnable(raw: unknown): boolean | "auto" | undefined {
	if (typeof raw === "boolean") return raw;
	if (raw === "auto") return "auto";
	return undefined;
}

function parseBudget(raw: unknown): number | undefined {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	return undefined;
}

function parseArgs(raw: unknown): ScannerArgsOptions | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const out: ScannerArgsOptions = {};
	if (Array.isArray(obj.rulesets)) {
		const rulesets = obj.rulesets.filter(
			(v): v is string => typeof v === "string",
		);
		if (rulesets.length === obj.rulesets.length) {
			out.rulesets = rulesets;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
