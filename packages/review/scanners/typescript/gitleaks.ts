import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/**
 * Parse `gitleaks dir|git --report-format json` stdout.
 *
 * Output is a JSON array of findings. We deliberately do NOT include
 * the `Secret` or `Match` fields in the rendered description / title:
 * the whole point of gitleaks is to flag a secret, and pi review
 * findings are surfaced in chat / written to GitHub PR bodies — leaking
 * a real secret into either of those would defeat the scanner.
 *
 * The redactor catalogue at `_shared/redact.ts` overlaps with
 * gitleaks's regex set; the two serve different scopes (runtime
 * scrubbing vs static scan), but they should not silently drift —
 * cross-reference noted in `packages/review/README.md` (166d).
 */
export function parseGitleaksOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`gitleaks output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!Array.isArray(parsed)) return [];
	const findings: RawFinding[] = [];

	for (const item of parsed as unknown[]) {
		if (!item || typeof item !== "object") continue;
		const f = item as Record<string, unknown>;
		const ruleId = typeof f.RuleID === "string" ? f.RuleID : "(unknown rule)";
		const description =
			typeof f.Description === "string" ? f.Description : ruleId;
		const file = typeof f.File === "string" ? f.File : null;
		if (!file) continue;
		const startLine = typeof f.StartLine === "number" ? f.StartLine : undefined;
		const tags = Array.isArray(f.Tags)
			? (f.Tags as unknown[]).filter((t): t is string => typeof t === "string")
			: [];

		const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
		const lineNote = typeof startLine === "number" ? `:${startLine}` : "";
		findings.push({
			severity: "CRITICAL",
			file,
			line: startLine,
			title: `gitleaks: ${ruleId} at ${file}${lineNote}`,
			description: `${description}${tagSuffix}`,
			suggestedAction: "Rotate the secret and remove it from git history.",
		});
	}

	return findings;
}

/**
 * `gitleaks dir` works whether or not the cwd is a git repo. Prefer
 * it over the deprecated `gitleaks detect`.
 *
 * `--exit-code 0` makes gitleaks exit 0 even when leaks are found —
 * the registry treats non-zero-no-output as an error, which would mis-
 * report a successful scan with findings. We extract findings from
 * the JSON report, not the exit code.
 */
export const gitleaksSpec: ScannerSpec = {
	id: "gitleaks",
	languages: ["any"],
	lane: "security-analyst",
	defaultEnabled: false,
	budgetMs: 60_000,
	binary: "gitleaks",
	buildArgs: () => [
		"dir",
		"--report-format",
		"json",
		"--report-path",
		"/dev/stdout",
		"--no-banner",
		"--exit-code",
		"0",
		".",
	],
	/**
	 * Auto-detect: gitleaks is **always relevant** in any git repo — secret
	 * scanning needs no per-repo config. We treat `enable: "auto"` as "on
	 * if the binary exists" by always returning `true`; the registry's
	 * binary probe gates actual execution.
	 */
	detectAuto: () => true,
	parse: parseGitleaksOutput,
};
