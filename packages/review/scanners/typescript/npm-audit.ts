import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

function npmSeverityToFinding(sev: string): RawFinding["severity"] | null {
	switch (sev) {
		case "critical":
		case "high":
			return "CRITICAL";
		case "moderate":
			return "IMPORTANT";
		case "low":
			return "NOTE";
		default:
			return null;
	}
}

/** Parse `npm audit --json` stdout. Handles both v6 and v7+ schemas. */
export function parseNpmAuditOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`npm audit output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	const findings: RawFinding[] = [];

	// npm v7+ schema
	if (obj.auditReportVersion === 2 && obj.vulnerabilities) {
		const vulns = obj.vulnerabilities as Record<string, unknown>;
		for (const [pkg, raw] of Object.entries(vulns)) {
			if (!raw || typeof raw !== "object") continue;
			const v = raw as Record<string, unknown>;
			const sev = typeof v.severity === "string" ? v.severity : "info";
			const severity = npmSeverityToFinding(sev);
			if (!severity) continue;
			const via = Array.isArray(v.via) ? v.via : [];
			const titles = via
				.map((entry) =>
					typeof entry === "string"
						? entry
						: typeof (entry as Record<string, unknown>).title === "string"
							? (entry as Record<string, unknown>).title
							: null,
				)
				.filter(Boolean) as string[];
			const range = typeof v.range === "string" ? ` (${v.range})` : "";
			const title = titles[0] ?? `Vulnerable dependency: ${pkg}`;
			const desc =
				titles.length > 0
					? `npm audit [${sev}]: ${pkg}${range} — ${titles.join("; ")}`
					: `npm audit [${sev}]: ${pkg}${range} has a known vulnerability.`;
			const fixAvail = v.fixAvailable === true;
			findings.push({
				severity,
				file: "package.json",
				title: `${title} (${pkg})`,
				description: desc,
				suggestedAction: fixAvail
					? `Run \`npm audit fix\` or update ${pkg}.`
					: `Review ${pkg} for a safe upgrade path.`,
			});
		}
		return findings;
	}

	// npm v6 schema
	if (obj.advisories) {
		const advisories = obj.advisories as Record<string, unknown>;
		for (const raw of Object.values(advisories)) {
			if (!raw || typeof raw !== "object") continue;
			const a = raw as Record<string, unknown>;
			const sev = typeof a.severity === "string" ? a.severity : "info";
			const severity = npmSeverityToFinding(sev);
			if (!severity) continue;
			const pkg = typeof a.module_name === "string" ? a.module_name : "unknown";
			const title =
				typeof a.title === "string" ? a.title : `Vulnerability in ${pkg}`;
			const url = typeof a.url === "string" ? ` ${a.url}` : "";
			findings.push({
				severity,
				file: "package.json",
				title: `${title} (${pkg})`,
				description: `npm audit [${sev}]: ${title} in ${pkg}.${url}`,
				suggestedAction: `Run \`npm audit fix\` or upgrade ${pkg}.`,
			});
		}
	}

	return findings;
}

/**
 * Spec id: `npm-audit` (kebab-case, matches the planned config key
 * `extensionConfig.review.scanners["npm-audit"]`). Note the legacy
 * shim in `static-checker.ts` exposes this as `npmAudit` (camelCase)
 * for back-compat with the existing `StaticAnalysisConfig`.
 */
export const npmAuditSpec: ScannerSpec = {
	id: "npm-audit",
	languages: ["typescript", "javascript"],
	lane: "security-analyst",
	defaultEnabled: true,
	budgetMs: 20_000,
	binary: "npm",
	buildArgs: () => ["audit", "--json"],
	parse: parseNpmAuditOutput,
};
