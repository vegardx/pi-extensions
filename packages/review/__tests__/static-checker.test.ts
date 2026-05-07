/**
 * Unit tests for the static-checker output parsers. All parsers are
 * pure functions so no subprocesses are needed here.
 */
import {
	parseBiomeOutput,
	parseEslintOutput,
	parseKnipOutput,
	parseNpmAuditOutput,
	parseSemgrepOutput,
	parseTscOutput,
	probeTool,
} from "../static-checker.js";

// ---- tsc ----------------------------------------------------------------

describe("parseTscOutput", () => {
	it("parses a single error line", () => {
		const raw =
			"src/foo.ts(42,5): error TS2339: Property 'x' does not exist on type 'Bar'.";
		const findings = parseTscOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "CRITICAL",
			file: "src/foo.ts",
			line: 42,
		});
		expect(findings[0]?.title).toContain("TS2339");
	});

	it("maps warning to IMPORTANT", () => {
		const raw =
			"src/foo.ts(1,1): warning TS6133: 'x' is declared but never read.";
		const findings = parseTscOutput(raw);
		expect(findings[0]?.severity).toBe("IMPORTANT");
	});

	it("dedupes identical file:line:code entries", () => {
		const line =
			"src/a.ts(10,3): error TS2322: Type 'string' is not assignable to 'number'.";
		const raw = [line, line].join("\n");
		const findings = parseTscOutput(raw);
		expect(findings).toHaveLength(1);
	});

	it("returns [] for empty input", () => {
		expect(parseTscOutput("")).toEqual([]);
	});

	it("ignores lines that don't match the tsc format", () => {
		const raw = "error TS0000: no such file\nnot a tsc line at all\n";
		expect(parseTscOutput(raw)).toHaveLength(0);
	});
});

// ---- biome --------------------------------------------------------------

describe("parseBiomeOutput", () => {
	it("parses a diagnostic with file + line", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/correctness/noUnusedVariables",
					severity: "warning",
					description: "This variable is unused.",
					location: {
						path: { file: "src/bar.ts" },
						span: { start: { line: 7 } },
					},
				},
			],
		});
		const findings = parseBiomeOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			file: "src/bar.ts",
			line: 7,
			severity: "IMPORTANT",
		});
	});

	it("maps error/fatal to CRITICAL", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/correctness/noDuplicateCase",
					severity: "error",
					description: "Duplicate case label.",
					location: {
						path: { file: "src/baz.ts" },
						span: { start: { line: 1 } },
					},
				},
			],
		});
		expect(parseBiomeOutput(raw)[0]?.severity).toBe("CRITICAL");
	});

	it("skips diagnostics with no file", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/foo",
					severity: "warning",
					description: "No location.",
					location: {},
				},
			],
		});
		expect(parseBiomeOutput(raw)).toHaveLength(0);
	});

	it("returns [] on invalid JSON", () => {
		expect(parseBiomeOutput("not json")).toEqual([]);
	});
});

// ---- eslint -------------------------------------------------------------

describe("parseEslintOutput", () => {
	it("parses a message from a file result", () => {
		const raw = JSON.stringify([
			{
				filePath: "/repo/src/a.ts",
				messages: [
					{
						ruleId: "no-unused-vars",
						severity: 2,
						message: "x is defined but never used.",
						line: 3,
					},
				],
			},
		]);
		const findings = parseEslintOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "CRITICAL",
			file: "/repo/src/a.ts",
			line: 3,
		});
	});

	it("maps severity 1 to IMPORTANT", () => {
		const raw = JSON.stringify([
			{
				filePath: "src/x.ts",
				messages: [
					{ ruleId: "no-console", severity: 1, message: "no console", line: 1 },
				],
			},
		]);
		expect(parseEslintOutput(raw)[0]?.severity).toBe("IMPORTANT");
	});

	it("returns [] on non-array JSON", () => {
		expect(parseEslintOutput(JSON.stringify({ foo: 1 }))).toEqual([]);
	});
});

// ---- knip ---------------------------------------------------------------

describe("parseKnipOutput", () => {
	it("creates NOTE findings for unused files", () => {
		const raw = JSON.stringify({ files: ["src/orphan.ts"], issues: [] });
		const findings = parseKnipOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "NOTE",
			file: "src/orphan.ts",
		});
	});

	it("creates NOTE findings for unused exports", () => {
		const raw = JSON.stringify({
			files: [],
			issues: [
				{
					file: "src/lib.ts",
					issues: [{ type: "exports", name: "MyHelper", line: 12 }],
				},
			],
		});
		const findings = parseKnipOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			file: "src/lib.ts",
			line: 12,
			title: "unused exports: MyHelper",
		});
	});

	it("returns [] on invalid JSON", () => {
		expect(parseKnipOutput("garbage")).toEqual([]);
	});
});

// ---- npm audit ----------------------------------------------------------

describe("parseNpmAuditOutput", () => {
	it("parses v7 schema (auditReportVersion: 2)", () => {
		const raw = JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {
				lodash: {
					name: "lodash",
					severity: "high",
					via: [{ title: "Prototype Pollution", url: "https://example.com" }],
					range: "<4.17.21",
					fixAvailable: true,
				},
			},
		});
		const findings = parseNpmAuditOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "CRITICAL",
			file: "package.json",
		});
		expect(findings[0]?.title).toContain("lodash");
		expect(findings[0]?.suggestedAction).toContain("npm audit fix");
	});

	it("maps npm severity moderate → IMPORTANT", () => {
		const raw = JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {
				axios: {
					name: "axios",
					severity: "moderate",
					via: [{ title: "SSRF" }],
					range: "<1.0.0",
					fixAvailable: false,
				},
			},
		});
		const findings = parseNpmAuditOutput(raw);
		expect(findings[0]?.severity).toBe("IMPORTANT");
	});

	it("skips info severity", () => {
		const raw = JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {
				pkg: { severity: "info", via: [], range: "*", fixAvailable: false },
			},
		});
		expect(parseNpmAuditOutput(raw)).toHaveLength(0);
	});

	it("parses v6 schema (advisories map)", () => {
		const raw = JSON.stringify({
			advisories: {
				"1234": {
					module_name: "express",
					severity: "moderate",
					title: "Open Redirect",
					url: "https://npmjs.com/advisories/1234",
				},
			},
		});
		const findings = parseNpmAuditOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("IMPORTANT");
		expect(findings[0]?.title).toContain("express");
	});

	it("returns [] on invalid JSON", () => {
		expect(parseNpmAuditOutput("{not json")).toEqual([]);
	});
});

// ---- semgrep ------------------------------------------------------------

describe("parseSemgrepOutput", () => {
	it("parses a semgrep result", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "javascript.lang.security.audit.eval-detected",
					path: "src/eval.ts",
					start: { line: 99 },
					extra: {
						message: "Detected eval() usage.",
						severity: "ERROR",
					},
				},
			],
			errors: [],
		});
		const findings = parseSemgrepOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "CRITICAL",
			file: "src/eval.ts",
			line: 99,
		});
	});

	it("maps WARNING → IMPORTANT, INFO → NOTE", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "a.b",
					path: "x.ts",
					start: { line: 1 },
					extra: { message: "warn", severity: "WARNING" },
				},
				{
					check_id: "c.d",
					path: "y.ts",
					start: { line: 2 },
					extra: { message: "info", severity: "INFO" },
				},
			],
		});
		const findings = parseSemgrepOutput(raw);
		expect(findings[0]?.severity).toBe("IMPORTANT");
		expect(findings[1]?.severity).toBe("NOTE");
	});

	it("skips results with no path", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "x",
					start: { line: 1 },
					extra: { message: "m", severity: "ERROR" },
				},
			],
		});
		expect(parseSemgrepOutput(raw)).toHaveLength(0);
	});

	it("returns [] on invalid JSON", () => {
		expect(parseSemgrepOutput("")).toEqual([]);
	});
});

// ---- probeTool ----------------------------------------------------------

describe("probeTool", () => {
	it("returns null for a name that does not exist", () => {
		expect(
			probeTool("this-tool-definitely-does-not-exist-xyzzy", process.cwd()),
		).toBeNull();
	});

	it("finds node in PATH", () => {
		// node is always in PATH in a test environment
		const result = probeTool("node", process.cwd());
		expect(result).not.toBeNull();
	});
});
