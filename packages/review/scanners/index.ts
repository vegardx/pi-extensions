/**
 * Public registry surface. Adapters live under `<language>/<tool>.ts`
 * and are aggregated here. New language directories (python/, go/,
 * rust/, …) plug in by adding their specs to `BUILTIN_SCANNERS`.
 */

import type { ScannerSpec } from "./types.js";
import { biomeSpec } from "./typescript/biome.js";
import { eslintSpec } from "./typescript/eslint.js";
import { gitleaksSpec } from "./typescript/gitleaks.js";
import { knipSpec } from "./typescript/knip.js";
import { madgeSpec } from "./typescript/madge.js";
import { npmAuditSpec } from "./typescript/npm-audit.js";
import { osvScannerSpec } from "./typescript/osv-scanner.js";
import { semgrepSpec } from "./typescript/semgrep.js";
import { tscSpec } from "./typescript/tsc.js";

/**
 * Built-in scanner registry. Order is preserved by `runScanners`
 * (sequential), so it doubles as default presentation order.
 */
export const BUILTIN_SCANNERS: readonly ScannerSpec[] = [
	tscSpec,
	biomeSpec,
	eslintSpec,
	knipSpec,
	madgeSpec,
	npmAuditSpec,
	osvScannerSpec,
	gitleaksSpec,
	semgrepSpec,
];

export {
	defaultProbe,
	defaultScannerContext,
	defaultSpawn,
	runScanners,
} from "./registry.js";
export type {
	LanguageId,
	ScannerContext,
	ScannerLane,
	ScannerOutcome,
	ScannerOverrides,
	ScannerSpec,
	SpawnResult,
} from "./types.js";

export { biomeSpec, parseBiomeOutput } from "./typescript/biome.js";
export { eslintSpec, parseEslintOutput } from "./typescript/eslint.js";
export { gitleaksSpec, parseGitleaksOutput } from "./typescript/gitleaks.js";
export { knipSpec, parseKnipOutput } from "./typescript/knip.js";
export { madgeSpec, parseMadgeOutput } from "./typescript/madge.js";
export { npmAuditSpec, parseNpmAuditOutput } from "./typescript/npm-audit.js";
export {
	osvScannerSpec,
	parseOsvScannerOutput,
} from "./typescript/osv-scanner.js";
export { parseSemgrepOutput, semgrepSpec } from "./typescript/semgrep.js";
export { parseTscOutput, tscSpec } from "./typescript/tsc.js";
