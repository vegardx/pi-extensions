import { parseTscOutput, tscSpec } from "../../../scanners/typescript/tsc.js";

describe("parseTscOutput", () => {
	it("returns no findings for empty string", () => {
		expect(parseTscOutput("")).toEqual([]);
	});

	it("parses a single error", () => {
		const raw =
			"src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";

		const findings = parseTscOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("CRITICAL");
		expect(f.file).toBe("src/index.ts");
		expect(f.line).toBe(10);
		expect(f.title).toBe(
			"TS2322: Type 'string' is not assignable to type 'number'.",
		);
		expect(f.description).toContain("TypeScript compiler");
	});

	it("maps warning to IMPORTANT", () => {
		const raw = "src/a.ts(5,1): warning TS6133: 'x' is declared but unused.";
		expect(parseTscOutput(raw)[0]!.severity).toBe("IMPORTANT");
	});

	it("handles multiple errors across files", () => {
		const raw = [
			"src/a.ts(1,1): error TS1005: ';' expected.",
			"src/b.ts(20,10): error TS2304: Cannot find name 'foo'.",
			"src/a.ts(3,1): error TS1005: '}' expected.",
		].join("\n");

		const findings = parseTscOutput(raw);
		expect(findings).toHaveLength(3);
		expect(findings.map((f) => f.file)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/a.ts",
		]);
	});

	it("deduplicates by file:line:code", () => {
		const raw = [
			"src/a.ts(5,1): error TS2322: First occurrence.",
			"src/a.ts(5,3): error TS2322: Duplicate same line and code.",
		].join("\n");

		const findings = parseTscOutput(raw);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.title).toContain("First occurrence");
	});

	it("ignores non-matching lines", () => {
		const raw = [
			"Found 2 errors in 1 file.",
			"",
			"src/a.ts(1,1): error TS1005: ';' expected.",
			"  1 | const x = ",
			"    |           ^",
		].join("\n");

		const findings = parseTscOutput(raw);
		expect(findings).toHaveLength(1);
	});

	it("truncates long messages in title to 80 chars", () => {
		const longMsg = "A".repeat(200);
		const raw = `src/a.ts(1,1): error TS9999: ${longMsg}`;

		const findings = parseTscOutput(raw);
		expect(findings[0]!.title.length).toBeLessThanOrEqual(
			"TS9999: ".length + 80,
		);
	});
});

describe("tscSpec", () => {
	it("targets code-reviewer lane", () => {
		expect(tscSpec.lane).toBe("code-reviewer");
	});

	it("is default-enabled", () => {
		expect(tscSpec.defaultEnabled).toBe(true);
	});

	it("uses --noEmit --pretty false", () => {
		const args = tscSpec.buildArgs();
		expect(args).toContain("--noEmit");
		expect(args).toContain("--pretty");
		expect(args).toContain("false");
	});

	it("has a 30s budget", () => {
		expect(tscSpec.budgetMs).toBe(30_000);
	});
});
