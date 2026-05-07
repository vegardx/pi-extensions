/**
 * Phase 0 static analysis — run deterministic CLI tools before the
 * AI fan-out so their structured output can be embedded in each
 * reviewer agent's task payload as pre-computed evidence.
 *
 * Tool selection rationale (researched 2025-05-07):
 *
 * TypeScript / code lane:
 *   tsc --noEmit    Zero-install in any TS project; catches type errors
 *                   the AI may miss. Output is text stderr; parsed via
 *                   regex. Probed via local node_modules/.bin/tsc.
 *   biome check     Standard in this monorepo; --reporter json is stable.
 *                   Probed via local node_modules/.bin/biome.
 *   eslint          Broader ecosystem rules; --format json. Off by
 *                   default — project may not have ESLint configured.
 *
 * Dead-code lane (code-simplifier):
 *   knip            Finds unused deps/exports/files (6.9M dl/week).
 *                   Off by default; too noisy on first run.
 *
 * Security lane:
 *   npm audit       Zero-install, built-in; CVE scan against advisory
 *                   DB. Supports both v6 (advisories) and v7+
 *                   (vulnerabilities) JSON schemas.
 *   semgrep         SAST via CE community rules (p/javascript). No
 *                   login required for CE. Off by default — requires
 *                   `pip install semgrep`.
 *
 * All tools are run with a per-tool timeout and their exit code is
 * ignored (they exit non-zero on findings — that's expected). Parse
 * failures are captured as `error` and surfaced in the auto-review
 * report without blocking the rest of the pipeline.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding, ReviewerRole } from "./findings.js";

// ---- Types --------------------------------------------------------------

export type StaticToolName =
	| "tsc"
	| "biome"
	| "eslint"
	| "knip"
	| "npmAudit"
	| "semgrep";

/** Reviewer lane that benefits from a given tool's output. */
export type StaticToolLane = Extract<
	ReviewerRole,
	"code-reviewer" | "security-analyst" | "code-simplifier"
>;

export interface StaticToolConfig {
	enabled: boolean;
	/** Hard timeout in milliseconds. */
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
	/** Was the tool executable on this system? */
	available: boolean;
	/** Was the tool enabled in config? */
	enabled: boolean;
	/** Populated when the tool ran but its output could not be parsed. */
	error?: string;
}

export interface StaticAnalysisResult {
	/** All findings organised by reviewer lane. */
	byLane: ReadonlyMap<StaticToolLane, RawFinding[]>;
	/** Per-tool diagnostic results for the report. */
	toolResults: StaticToolResult[];
}

// ---- Defaults -----------------------------------------------------------

const DEFAULTS: Record<StaticToolName, StaticToolConfig> = {
	tsc: { enabled: true, timeout: 30_000 },
	biome: { enabled: true, timeout: 15_000 },
	eslint: { enabled: false, timeout: 30_000 },
	knip: { enabled: false, timeout: 60_000 },
	npmAudit: { enabled: true, timeout: 20_000 },
	semgrep: { enabled: false, timeout: 120_000 },
};

const TOOL_LANE: Record<StaticToolName, StaticToolLane> = {
	tsc: "code-reviewer",
	biome: "code-reviewer",
	eslint: "code-reviewer",
	knip: "code-simplifier",
	npmAudit: "security-analyst",
	semgrep: "security-analyst",
};

function resolveConfig(
	tool: StaticToolName,
	override?: Partial<StaticToolConfig>,
): StaticToolConfig {
	return { ...DEFAULTS[tool], ...override };
}

// ---- Tool probing -------------------------------------------------------

/**
 * Resolve the executable path for a tool. Prefers the local
 * `node_modules/.bin/<name>` so projects using local installs work
 * without the tool being globally available. Falls back to PATH via
 * `which`. Returns `null` when the tool is not found.
 */
export function probeTool(name: string, cwd: string): string | null {
	const local = join(cwd, "node_modules", ".bin", name);
	if (existsSync(local)) return local;
	// For npm-prefixed tool names that live under a different binary
	// (e.g. "npmAudit" → "npm"), the caller passes the real binary name.
	const r = spawnSync("which", [name], {
		encoding: "utf8",
		timeout: 3_000,
		stdio: "pipe",
	});
	if (r.status === 0 && r.stdout.trim()) return name;
	return null;
}

// ---- Output parsers -----------------------------------------------------

/** Parse `tsc --noEmit --pretty false` stderr/stdout text output. */
export function parseTscOutput(raw: string): RawFinding[] {
	// Format: path/to/file.ts(line,col): error|warning TSxxxx: message
	const findings: RawFinding[] = [];
	const seen = new Set<string>();
	for (const m of raw.matchAll(
		/^(.+?)\((\d+),\d+\): (error|warning) (TS\d+): (.+)$/gm,
	)) {
		const [, file, lineStr, kind, code, msg] = m;
		if (!file || !lineStr || !kind || !code || !msg) continue;
		const line = Number(lineStr);
		const severity =
			kind === "error" ? ("CRITICAL" as const) : ("IMPORTANT" as const);
		const key = `${file}:${line}:${code}`;
		if (seen.has(key)) continue;
		seen.add(key);
		findings.push({
			severity,
			file: file.trim(),
			line,
			title: `${code}: ${msg.trim().slice(0, 80)}`,
			description: `TypeScript compiler: ${msg.trim()}`,
			suggestedAction: "",
		});
	}
	return findings;
}

/** Parse `biome check --reporter json` stdout. */
export function parseBiomeOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`biome output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.diagnostics)) return [];
	const findings: RawFinding[] = [];
	for (const d of obj.diagnostics as unknown[]) {
		if (!d || typeof d !== "object") continue;
		const diag = d as Record<string, unknown>;
		const category = typeof diag.category === "string" ? diag.category : "lint";
		const msgObj = diag.message as Record<string, unknown> | undefined;
		const msg =
			typeof diag.description === "string"
				? diag.description
				: typeof msgObj?.content === "string"
					? msgObj.content
					: "";
		if (!msg) continue;
		const sev = typeof diag.severity === "string" ? diag.severity : "";
		const severity =
			sev === "error" || sev === "fatal"
				? ("CRITICAL" as const)
				: ("IMPORTANT" as const);
		const loc = diag.location as Record<string, unknown> | undefined;
		const pathObj = loc?.path as Record<string, unknown> | undefined;
		const file = typeof pathObj?.file === "string" ? pathObj.file : null;
		if (!file) continue;
		const span = loc?.span as Record<string, unknown> | undefined;
		const startObj = span?.start as Record<string, unknown> | undefined;
		const line = typeof startObj?.line === "number" ? startObj.line : undefined;
		findings.push({
			severity,
			file,
			line,
			title: `biome: ${category} — ${msg.slice(0, 80)}`,
			description: `Biome lint (${category}): ${msg}`,
			suggestedAction: "",
		});
	}
	return findings;
}

/** Parse `eslint --format json` stdout. */
export function parseEslintOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`eslint output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!Array.isArray(parsed)) return [];
	const findings: RawFinding[] = [];
	for (const fileResult of parsed) {
		if (!fileResult || typeof fileResult !== "object") continue;
		const fr = fileResult as Record<string, unknown>;
		const file = typeof fr.filePath === "string" ? fr.filePath : null;
		if (!file || !Array.isArray(fr.messages)) continue;
		for (const msg of fr.messages as unknown[]) {
			if (!msg || typeof msg !== "object") continue;
			const m = msg as Record<string, unknown>;
			const text = typeof m.message === "string" ? m.message : "";
			if (!text) continue;
			const rule = typeof m.ruleId === "string" ? m.ruleId : "unknown";
			const severity =
				m.severity === 2 ? ("CRITICAL" as const) : ("IMPORTANT" as const);
			const line = typeof m.line === "number" ? m.line : undefined;
			findings.push({
				severity,
				file,
				line,
				title: `eslint(${rule}): ${text.slice(0, 80)}`,
				description: `ESLint rule ${rule}: ${text}`,
				suggestedAction: "",
			});
		}
	}
	return findings;
}

/** Parse `knip --reporter json` stdout. */
export function parseKnipOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`knip output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	const findings: RawFinding[] = [];

	// Unused files
	if (Array.isArray(obj.files)) {
		for (const f of obj.files as unknown[]) {
			if (typeof f !== "string") continue;
			findings.push({
				severity: "NOTE",
				file: f,
				title: "unused file",
				description: `knip: ${f} has no imports and is not an entry point.`,
				suggestedAction: "Remove or add as an entry point.",
			});
		}
	}

	// Issues per file
	if (Array.isArray(obj.issues)) {
		for (const item of obj.issues as unknown[]) {
			if (!item || typeof item !== "object") continue;
			const it = item as Record<string, unknown>;
			const file = typeof it.file === "string" ? it.file : null;
			if (!file || !Array.isArray(it.issues)) continue;
			for (const issue of it.issues as unknown[]) {
				if (!issue || typeof issue !== "object") continue;
				const iss = issue as Record<string, unknown>;
				const type = typeof iss.type === "string" ? iss.type : "unknown";
				const name = typeof iss.name === "string" ? iss.name : "(unnamed)";
				const line = typeof iss.line === "number" ? iss.line : undefined;
				findings.push({
					severity: "NOTE",
					file,
					line,
					title: `unused ${type}: ${name}`,
					description: `knip: ${type} "${name}" in ${file} is unused.`,
					suggestedAction: `Remove or re-export "${name}".`,
				});
			}
		}
	}
	return findings;
}

/** Parse `npm audit --json` stdout. Handles both v6 and v7+ schemas. */
export function parseNpmAuditOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`npm audit output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
	const obj = parsed as Record<string, unknown>;
	const findings: RawFinding[] = [];

	// npm v7+ schema: { vulnerabilities: { <pkg>: { severity, via, ... } } }
	if (obj.auditReportVersion === 2 && obj.vulnerabilities) {
		const vulns = obj.vulnerabilities as Record<string, unknown>;
		for (const [pkg, raw] of Object.entries(vulns)) {
			if (!raw || typeof raw !== "object") continue;
			const v = raw as Record<string, unknown>;
			const sev = typeof v.severity === "string" ? v.severity : "info";
			const severity = npmSeverityToFinding(sev);
			if (!severity) continue;
			// Collect advisory titles from `via`
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

	// npm v6 schema: { advisories: { <id>: { module_name, severity, title, ... } } }
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
			return null; // "info" and unknown → skip
	}
}

/** Parse `semgrep scan --json` stdout. */
export function parseSemgrepOutput(raw: string): RawFinding[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(
			`semgrep output is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
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

// ---- Tool runners -------------------------------------------------------

interface ToolRunSpec {
	name: StaticToolName;
	bin: string;
	args: string[];
	cwd: string;
	timeout: number;
	parse: (out: string) => RawFinding[];
}

function runTool(spec: ToolRunSpec): {
	findings: RawFinding[];
	error?: string;
} {
	const result = spawnSync(spec.bin, spec.args, {
		cwd: spec.cwd,
		encoding: "utf8",
		timeout: spec.timeout,
		stdio: "pipe",
		// Don't throw on non-zero exit — tools exit 1 when they find issues.
	});

	if (result.error) {
		const msg = result.error.message;
		// Timeout is signalled via ETIMEDOUT / signal
		return { findings: [], error: `spawn error: ${msg}` };
	}

	// Combine stdout + stderr — tsc writes to stderr, most others stdout.
	const output = [result.stdout ?? "", result.stderr ?? ""].join("\n").trim();

	if (!output) {
		// No output and non-zero exit with no spawn error = tool not usable
		if (result.status !== 0 && result.status !== null) {
			return {
				findings: [],
				error: `exited ${result.status} with no output`,
			};
		}
		return { findings: [] };
	}

	try {
		return { findings: spec.parse(output) };
	} catch (err) {
		return {
			findings: [],
			error: `parse error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---- Public API ---------------------------------------------------------

/**
 * Run all enabled static analysis tools and return findings organised
 * by reviewer lane. Unavailable or disabled tools are recorded but
 * silently skipped — the caller can surface the `toolResults` in the
 * report if desired.
 *
 * @param cwd    Working directory (repo root).
 * @param config Per-tool overrides from `extensionConfig.review.staticAnalysis`.
 */
export async function runStaticAnalysis(
	cwd: string,
	config: StaticAnalysisConfig = {},
): Promise<StaticAnalysisResult> {
	const toolResults: StaticToolResult[] = [];

	const specs: Array<{
		name: StaticToolName;
		probeName: string;
		args: (bin: string) => string[];
		parse: (out: string) => RawFinding[];
	}> = [
		{
			name: "tsc",
			probeName: "tsc",
			args: () => ["--noEmit", "--pretty", "false"],
			parse: parseTscOutput,
		},
		{
			name: "biome",
			probeName: "biome",
			args: () => ["check", "--reporter", "json", "."],
			parse: parseBiomeOutput,
		},
		{
			name: "eslint",
			probeName: "eslint",
			args: () => ["--format", "json", "."],
			parse: parseEslintOutput,
		},
		{
			name: "knip",
			probeName: "knip",
			args: () => ["--reporter", "json"],
			parse: parseKnipOutput,
		},
		{
			name: "npmAudit",
			probeName: "npm",
			args: () => ["audit", "--json"],
			parse: parseNpmAuditOutput,
		},
		{
			name: "semgrep",
			probeName: "semgrep",
			args: () => ["scan", "--config", "p/javascript", "--json", "."],
			parse: parseSemgrepOutput,
		},
	];

	for (const spec of specs) {
		const cfg = resolveConfig(
			spec.name,
			config[spec.name] as Partial<StaticToolConfig> | undefined,
		);
		const lane = TOOL_LANE[spec.name];

		if (!cfg.enabled) {
			toolResults.push({
				tool: spec.name,
				lane,
				findings: [],
				available: false, // unknown — not probed
				enabled: false,
			});
			continue;
		}

		const bin = probeTool(spec.probeName, cwd);
		if (!bin) {
			toolResults.push({
				tool: spec.name,
				lane,
				findings: [],
				available: false,
				enabled: true,
				error: `${spec.probeName} not found in node_modules/.bin or PATH`,
			});
			continue;
		}

		const { findings, error } = runTool({
			name: spec.name,
			bin,
			args: spec.args(bin),
			cwd,
			timeout: cfg.timeout,
			parse: spec.parse,
		});

		toolResults.push({
			tool: spec.name,
			lane,
			findings,
			available: true,
			enabled: true,
			error,
		});
	}

	// Aggregate into per-lane maps
	const laneMap = new Map<StaticToolLane, RawFinding[]>();
	for (const r of toolResults) {
		if (r.findings.length === 0) continue;
		const existing = laneMap.get(r.lane) ?? [];
		laneMap.set(r.lane, [...existing, ...r.findings]);
	}

	return { byLane: laneMap, toolResults };
}
