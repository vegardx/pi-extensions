import {
	parseSemgrepOutput,
	semgrepSpec,
} from "../../../scanners/typescript/semgrep.js";

describe("parseSemgrepOutput", () => {
	it("returns no findings for empty results array", () => {
		expect(parseSemgrepOutput(JSON.stringify({ results: [] }))).toEqual([]);
	});

	it("returns no findings for non-object root", () => {
		expect(parseSemgrepOutput(JSON.stringify([]))).toEqual([]);
		expect(parseSemgrepOutput(JSON.stringify(null))).toEqual([]);
	});

	it("returns no findings when results key is missing", () => {
		expect(parseSemgrepOutput(JSON.stringify({ foo: "bar" }))).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseSemgrepOutput("not json")).toThrow(/not valid JSON/);
	});

	it("parses a finding with ERROR severity", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "javascript.lang.security.detect-eval.detect-eval",
					path: "src/dangerous.ts",
					start: { line: 15, col: 1 },
					extra: {
						severity: "ERROR",
						message: "Detected the use of eval().",
					},
				},
			],
		});

		const findings = parseSemgrepOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("CRITICAL");
		expect(f.file).toBe("src/dangerous.ts");
		expect(f.line).toBe(15);
		expect(f.title).toContain("detect-eval");
		expect(f.description).toContain("eval()");
	});

	it("maps WARNING to IMPORTANT", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "js.best-practice.no-var",
					path: "a.ts",
					start: { line: 1 },
					extra: { severity: "WARNING", message: "Avoid var" },
				},
			],
		});

		expect(parseSemgrepOutput(raw)[0]!.severity).toBe("IMPORTANT");
	});

	it("maps INFO to NOTE", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "js.info.debug-log",
					path: "a.ts",
					start: { line: 1 },
					extra: { severity: "INFO", message: "Debug log" },
				},
			],
		});

		expect(parseSemgrepOutput(raw)[0]!.severity).toBe("NOTE");
	});

	it("skips findings without a path", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "x",
					start: { line: 1 },
					extra: { severity: "ERROR", message: "msg" },
				},
			],
		});

		expect(parseSemgrepOutput(raw)).toEqual([]);
	});

	it("shortens title from check_id (last 2 segments)", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "a.b.c.specific-rule",
					path: "f.ts",
					start: { line: 1 },
					extra: { severity: "WARNING", message: "msg" },
				},
			],
		});

		const f = parseSemgrepOutput(raw)[0]!;
		expect(f.title).toBe("semgrep: c.specific-rule");
	});

	it("falls back description when message is empty", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "r.rule",
					path: "f.ts",
					start: { line: 1 },
					extra: { severity: "WARNING" },
				},
			],
		});

		const f = parseSemgrepOutput(raw)[0]!;
		expect(f.description).toContain("r.rule");
	});

	it("handles multiple results", () => {
		const raw = JSON.stringify({
			results: [
				{
					check_id: "r1",
					path: "a.ts",
					start: { line: 1 },
					extra: { severity: "ERROR", message: "m1" },
				},
				{
					check_id: "r2",
					path: "b.ts",
					start: { line: 5 },
					extra: { severity: "WARNING", message: "m2" },
				},
			],
		});

		const findings = parseSemgrepOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.file)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("semgrepSpec", () => {
	it("targets security-analyst lane", () => {
		expect(semgrepSpec.lane).toBe("security-analyst");
	});

	it("is default-disabled (opt-in)", () => {
		expect(semgrepSpec.defaultEnabled).toBe(false);
	});

	it("builds args with default rulesets when no config file exists", () => {
		const args = semgrepSpec.buildArgs();
		expect(args[0]).toBe("scan");
		expect(args).toContain("--config");
		expect(args).toContain("p/javascript");
		expect(args).toContain("--json");
	});

	it("builds args with explicit rulesets when provided", () => {
		const args = semgrepSpec.buildArgs({
			rulesets: ["p/typescript", "p/owasp-top-ten"],
		});
		expect(args).toContain("p/typescript");
		expect(args).toContain("p/owasp-top-ten");
	});

	it("has a 120s budget", () => {
		expect(semgrepSpec.budgetMs).toBe(120_000);
	});
});
