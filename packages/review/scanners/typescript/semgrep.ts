import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/** Parse `semgrep scan --json` stdout. */
export function parseSemgrepOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`semgrep output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.results)) return [];
	const findings: RawFinding[] = [];
	for (const r of obj.results as unknown[]) {
		if (!r || typeof r !== "object") continue;
		const res = r as Record<string, unknown>;
		const checkId = typeof res.check_id === "string" ? res.check_id : "semgrep";
		const path = typeof res.path === "string" ? res.path : null;
		if (!path) continue;
		const start = res.start as Record<string, unknown> | undefined;
		const line = typeof start?.line === "number" ? start.line : undefined;
		const extra = res.extra as Record<string, unknown> | undefined;
		const msg = typeof extra?.message === "string" ? extra.message : "";
		const rawSev =
			typeof extra?.severity === "string" ? extra.severity : "WARNING";
		const severity =
			rawSev === "ERROR"
				? ("CRITICAL" as const)
				: rawSev === "INFO"
					? ("NOTE" as const)
					: ("IMPORTANT" as const);
		findings.push({
			severity,
			file: path,
			line,
			title: `semgrep: ${checkId.split(".").slice(-2).join(".")}`,
			description: msg || `Semgrep rule ${checkId} matched.`,
			suggestedAction: "",
		});
	}
	return findings;
}

/**
 * Auto-detect: enable when the repo has a semgrep config file. With
 * no config, semgrep needs `--config` rulesets which the user must
 * supply explicitly via `args.rulesets` — don't auto-enable in that
 * case (the default `p/javascript` ruleset is too noisy to opt into
 * silently).
 */
function detectSemgrep(cwd: string): boolean {
	const names = [
		".semgrep.yml",
		".semgrep.yaml",
		"semgrep.yml",
		"semgrep.yaml",
	];
	return names.some((n) => existsSync(join(cwd, n)));
}

/** Default ruleset when none configured — covers JS/TS by default. */
const DEFAULT_SEMGREP_RULESETS = ["p/javascript"] as const;

export const semgrepSpec: ScannerSpec = {
	id: "semgrep",
	// `buildArgs` pins `--config p/javascript` so we only produce useful
	// findings for TS/JS today. Listing python/go would mislead future
	// language-based filtering into running semgrep against ecosystems
	// it isn't configured for. Widen this when we wire per-language
	// rulesets (#166c+).
	languages: ["typescript", "javascript"],
	lane: "security-analyst",
	defaultEnabled: false,
	budgetMs: 120_000,
	binary: "semgrep",
	buildArgs: (opts) => {
		const rulesets =
			opts?.rulesets && opts.rulesets.length > 0
				? opts.rulesets
				: DEFAULT_SEMGREP_RULESETS;
		const args = ["scan"];
		for (const r of rulesets) {
			args.push("--config", r);
		}
		args.push("--json", ".");
		return args;
	},
	detectAuto: detectSemgrep,
	parse: parseSemgrepOutput,
};
