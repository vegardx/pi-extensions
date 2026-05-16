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

export const semgrepSpec: ScannerSpec = {
	id: "semgrep",
	languages: ["typescript", "javascript", "python", "go"],
	lane: "security-analyst",
	defaultEnabled: false,
	budgetMs: 120_000,
	binary: "semgrep",
	buildArgs: () => ["scan", "--config", "p/javascript", "--json", "."],
	parse: parseSemgrepOutput,
};
