import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding } from "../../findings.js";
import type { ScannerSpec } from "../types.js";

/**
 * Map a severity hint from osv-scanner output to our finding severity.
 *
 * Two sources, in order:
 *   1. `groups[].max_severity` — numeric CVSS score serialised as a
 *      string (e.g. `"8.6"`). Added to osv-scanner JSON in 2025; older
 *      v1 builds omit it.
 *   2. `database_specific.severity` — qualitative string from the
 *      upstream database (GHSA: `"CRITICAL"|"HIGH"|"MODERATE"|"LOW"`).
 *
 * `severity[]` items are CVSS vector strings (e.g.
 * `"CVSS:3.1/AV:N/..."`) — parsing them is non-trivial and we don't
 * try; the numeric `groups[].max_severity` already carries the
 * computed score.
 */
function osvSeverityToFinding(
	maxSeverity: string | undefined,
	dbSpecific: string | undefined,
): RawFinding["severity"] {
	if (maxSeverity) {
		const n = Number(maxSeverity);
		if (Number.isFinite(n)) {
			if (n >= 7.0) return "CRITICAL";
			if (n >= 4.0) return "IMPORTANT";
			return "NOTE";
		}
	}
	switch ((dbSpecific ?? "").toUpperCase()) {
		case "CRITICAL":
		case "HIGH":
			return "CRITICAL";
		case "MODERATE":
		case "MEDIUM":
			return "IMPORTANT";
		case "LOW":
			return "NOTE";
		default:
			return "IMPORTANT";
	}
}

/** Parse `osv-scanner --format json` stdout. */
export function parseOsvScannerOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`osv-scanner output is not valid JSON: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const root = parsed as Record<string, unknown>;
	if (!Array.isArray(root.results)) return [];
	const findings: RawFinding[] = [];

	for (const result of root.results as unknown[]) {
		if (!result || typeof result !== "object") continue;
		const r = result as Record<string, unknown>;
		const source = r.source as Record<string, unknown> | undefined;
		const sourcePath =
			typeof source?.path === "string" ? source.path : "package.json";
		if (!Array.isArray(r.packages)) continue;

		for (const p of r.packages as unknown[]) {
			if (!p || typeof p !== "object") continue;
			const pkg = p as Record<string, unknown>;
			const pkgInfo = pkg.package as Record<string, unknown> | undefined;
			const name =
				typeof pkgInfo?.name === "string" ? pkgInfo.name : "(unknown)";
			const version =
				typeof pkgInfo?.version === "string" ? pkgInfo.version : "?";
			const ecosystem =
				typeof pkgInfo?.ecosystem === "string" ? pkgInfo.ecosystem : "";

			const rawGroups = Array.isArray(pkg.groups)
				? (pkg.groups as unknown[])
				: [];
			const groups: Record<string, unknown>[] = [];
			for (const g of rawGroups) {
				if (g && typeof g === "object") {
					groups.push(g as Record<string, unknown>);
				}
			}
			// Pick the *maximum* severity across all groups, not the first
			// non-empty one. With multiple groups present, picking the first
			// can understate the overall severity.
			let groupMaxSeverity: string | undefined;
			let groupMaxNumeric = -Infinity;
			for (const g of groups) {
				const raw =
					typeof g.max_severity === "string" ? g.max_severity : undefined;
				if (!raw) continue;
				const n = Number(raw);
				if (!Number.isFinite(n)) continue;
				if (n > groupMaxNumeric) {
					groupMaxNumeric = n;
					groupMaxSeverity = raw;
				}
			}
			const groupAliases: string[] = [];
			for (const g of groups) {
				if (Array.isArray(g.aliases)) {
					for (const a of g.aliases as unknown[]) {
						if (typeof a === "string") groupAliases.push(a);
					}
				}
			}

			if (!Array.isArray(pkg.vulnerabilities)) continue;
			for (const v of pkg.vulnerabilities as unknown[]) {
				if (!v || typeof v !== "object") continue;
				const vuln = v as Record<string, unknown>;
				const id = typeof vuln.id === "string" ? vuln.id : "(unknown)";
				const summary = typeof vuln.summary === "string" ? vuln.summary : "";
				const dbSpecific = vuln.database_specific as
					| Record<string, unknown>
					| undefined;
				const dbSeverity =
					typeof dbSpecific?.severity === "string"
						? dbSpecific.severity
						: undefined;
				const severity = osvSeverityToFinding(groupMaxSeverity, dbSeverity);

				const title = `osv-scanner: ${id} in ${name}@${version}`;
				const aliasNote =
					groupAliases.length > 0
						? ` (aliases: ${groupAliases.join(", ")})`
						: "";
				const ecoNote = ecosystem ? ` [${ecosystem}]` : "";
				const desc = summary
					? `${summary}${ecoNote}${aliasNote}`
					: `Known vulnerability in ${name}${ecoNote}${aliasNote}`;

				findings.push({
					severity,
					file: sourcePath,
					title,
					description: desc,
					suggestedAction: `Review ${name}@${version} for a fixed upgrade path.`,
				});
			}
		}
	}

	return findings;
}

/**
 * osv-scanner is the modern OSS replacement for `npm audit` — broader
 * ecosystem coverage (Go, Python, Rust, etc.) backed by osv.dev.
 *
 * Default-disabled: most projects don't have osv-scanner installed,
 * and 166c will introduce `enable: "auto"` so it picks up alongside
 * (or instead of) `npm-audit` based on lockfile presence + binary
 * availability.
 */
/**
 * Auto-detect: enable when ANY recognised lockfile / manifest is
 * present. osv-scanner covers the OSV ecosystem broadly (npm, Go,
 * Python, Rust, Maven, etc.) so we don't restrict to one ecosystem.
 */
function detectOsvScanner(cwd: string): boolean {
	const lockfiles = [
		"package-lock.json",
		"yarn.lock",
		"pnpm-lock.yaml",
		"go.mod",
		"go.sum",
		"Cargo.lock",
		"poetry.lock",
		"requirements.txt",
		"Pipfile.lock",
		"pom.xml",
	];
	return lockfiles.some((n) => existsSync(join(cwd, n)));
}

export const osvScannerSpec: ScannerSpec = {
	id: "osv-scanner",
	// Spec covers only the npm/yarn ecosystem until #166c teaches
	// `buildArgs()` to detect lockfiles per-language. Don't advertise
	// languages we don't actually scan — future language-based filtering
	// would otherwise enable osv-scanner for ecosystems it isn't reading.
	languages: ["typescript", "javascript"],
	lane: "security-analyst",
	defaultEnabled: false,
	budgetMs: 30_000,
	binary: "osv-scanner",
	buildArgs: () => ["--format", "json", "--lockfile", "package-lock.json"],
	detectAuto: detectOsvScanner,
	parse: parseOsvScannerOutput,
};
