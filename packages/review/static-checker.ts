/**
 * Phase 0 static analysis — back-compat shim over the new scanner
 * registry (`packages/review/scanners/`). All adapter logic now lives
 * per-tool under `scanners/typescript/`; this file maps the legacy
 * `StaticAnalysisConfig` / `StaticAnalysisResult` surface that
 * `auto-review.ts` consumes onto the registry.
 *
 * Do not add new scanners here — register them under
 * `packages/review/scanners/<language>/` and add the spec to
 * `BUILTIN_SCANNERS` in `scanners/index.js`.
 */

import type { RawFinding, ReviewerRole } from "./findings.js";
import {
	BUILTIN_SCANNERS,
	defaultProbe,
	defaultScannerContext,
	runScanners,
} from "./scanners/index.js";
import type { ScannerOverrides, ScannerSpec } from "./scanners/types.js";

// ---- Back-compat re-exports (parsers + probe) ---------------------------

export { parseBiomeOutput } from "./scanners/typescript/biome.js";
export { parseEslintOutput } from "./scanners/typescript/eslint.js";
export { parseKnipOutput } from "./scanners/typescript/knip.js";
export { parseNpmAuditOutput } from "./scanners/typescript/npm-audit.js";
export { parseSemgrepOutput } from "./scanners/typescript/semgrep.js";
export { parseTscOutput } from "./scanners/typescript/tsc.js";

/**
 * Resolve the executable path for a tool. Prefers the local
 * `node_modules/.bin/<name>`, falls back to PATH via `which`.
 *
 * Back-compat shim — new code should use the `probe` callback on
 * `ScannerContext`.
 */
export function probeTool(name: string, cwd: string): string | null {
	return defaultProbe(name, cwd);
}

// ---- Legacy types (preserved for auto-review.ts + tests) ----------------

/**
 * Legacy tool-name enum. The kebab-case `npm-audit` from
 * `ScannerSpec.id` is still spelled `npmAudit` here for back-compat.
 */
export type StaticToolName =
	| "tsc"
	| "biome"
	| "eslint"
	| "knip"
	| "npmAudit"
	| "semgrep";

export type StaticToolLane = Extract<
	ReviewerRole,
	"code-reviewer" | "security-analyst" | "code-simplifier"
>;

export interface StaticToolConfig {
	enabled: boolean;
	timeout: number;
}

export interface StaticAnalysisConfig {
	tsc?: Partial<StaticToolConfig>;
	biome?: Partial<StaticToolConfig>;
	eslint?: Partial<StaticToolConfig>;
	knip?: Partial<StaticToolConfig>;
	npmAudit?: Partial<StaticToolConfig>;
	semgrep?: Partial<StaticToolConfig>;
}

export interface StaticToolResult {
	tool: StaticToolName;
	lane: StaticToolLane;
	findings: RawFinding[];
	available: boolean;
	enabled: boolean;
	error?: string;
}

export interface StaticAnalysisResult {
	byLane: ReadonlyMap<StaticToolLane, RawFinding[]>;
	toolResults: StaticToolResult[];
}

// ---- Spec → legacy name mapping ----------------------------------------

/**
 * Map `ScannerSpec.id` (kebab-case, public) ↔ legacy
 * `StaticToolName` (camelCase) used by `StaticAnalysisConfig`. Only
 * the npm-audit case actually differs.
 */
const SPEC_ID_TO_LEGACY: Record<string, StaticToolName> = {
	tsc: "tsc",
	biome: "biome",
	eslint: "eslint",
	knip: "knip",
	"npm-audit": "npmAudit",
	semgrep: "semgrep",
};

function legacyNameFor(spec: ScannerSpec): StaticToolName | null {
	return SPEC_ID_TO_LEGACY[spec.id] ?? null;
}

/** Build registry overrides from a legacy `StaticAnalysisConfig`. */
function overridesFromLegacyConfig(
	specs: readonly ScannerSpec[],
	cfg: StaticAnalysisConfig,
): ScannerOverrides {
	const out: ScannerOverrides = {};
	for (const spec of specs) {
		const legacy = legacyNameFor(spec);
		if (!legacy) continue;
		const partial = cfg[legacy];
		if (!partial) continue;
		out[spec.id] = {};
		if (typeof partial.enabled === "boolean") {
			out[spec.id].enabled = partial.enabled;
		}
		if (typeof partial.timeout === "number") {
			out[spec.id].budgetMs = partial.timeout;
		}
	}
	return out;
}

// ---- Public API --------------------------------------------------------

/**
 * Run all enabled static analysis tools and return findings organised
 * by reviewer lane. Unavailable or disabled tools are recorded but
 * silently skipped — the caller can surface the `toolResults` in the
 * report if desired.
 *
 * Implementation calls into `runScanners` over `BUILTIN_SCANNERS`;
 * the legacy result shape is reconstructed from the outcomes.
 */
export async function runStaticAnalysis(
	cwd: string,
	config: StaticAnalysisConfig = {},
): Promise<StaticAnalysisResult> {
	const ctx = defaultScannerContext(cwd);
	const overrides = overridesFromLegacyConfig(BUILTIN_SCANNERS, config);
	const outcomes = runScanners(BUILTIN_SCANNERS, ctx, overrides);

	const toolResults: StaticToolResult[] = [];
	const laneMap = new Map<StaticToolLane, RawFinding[]>();

	for (const o of outcomes) {
		const legacy = legacyNameFor(o.spec);
		if (!legacy) continue;
		toolResults.push({
			tool: legacy,
			lane: o.spec.lane,
			findings: o.findings,
			available: o.available,
			enabled: o.enabled,
			error: o.error,
		});
		if (o.findings.length > 0) {
			const existing = laneMap.get(o.spec.lane) ?? [];
			laneMap.set(o.spec.lane, [...existing, ...o.findings]);
		}
	}

	return { byLane: laneMap, toolResults };
}
