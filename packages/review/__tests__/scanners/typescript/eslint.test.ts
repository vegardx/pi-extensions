import {
	eslintSpec,
	parseEslintOutput,
} from "../../../scanners/typescript/eslint.js";

describe("parseEslintOutput", () => {
	it("returns no findings for empty array", () => {
		expect(parseEslintOutput("[]")).toEqual([]);
	});

	it("returns no findings for non-array root", () => {
		expect(parseEslintOutput("{}")).toEqual([]);
		expect(parseEslintOutput("null")).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseEslintOutput("not json")).toThrow(/not valid JSON/);
	});

	it("parses error-severity messages", () => {
		const raw = JSON.stringify([
			{
				filePath: "src/index.ts",
				messages: [
					{
						ruleId: "no-unused-vars",
						severity: 2,
						message: "Variable 'x' is declared but never used.",
						line: 10,
					},
				],
			},
		]);

		const findings = parseEslintOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("CRITICAL");
		expect(f.file).toBe("src/index.ts");
		expect(f.line).toBe(10);
		expect(f.title).toBe(
			"eslint(no-unused-vars): Variable 'x' is declared but never used.",
		);
		expect(f.description).toContain("no-unused-vars");
	});

	it("maps severity 1 (warning) to IMPORTANT", () => {
		const raw = JSON.stringify([
			{
				filePath: "src/a.ts",
				messages: [
					{
						ruleId: "prefer-const",
						severity: 1,
						message: "Use const.",
						line: 5,
					},
				],
			},
		]);

		expect(parseEslintOutput(raw)[0]!.severity).toBe("IMPORTANT");
	});

	it("handles multiple files with multiple messages", () => {
		const raw = JSON.stringify([
			{
				filePath: "a.ts",
				messages: [
					{ ruleId: "r1", severity: 2, message: "msg1", line: 1 },
					{ ruleId: "r2", severity: 1, message: "msg2", line: 2 },
				],
			},
			{
				filePath: "b.ts",
				messages: [{ ruleId: "r3", severity: 2, message: "msg3", line: 3 }],
			},
		]);

		const findings = parseEslintOutput(raw);
		expect(findings).toHaveLength(3);
		expect(findings.map((f) => f.file)).toEqual(["a.ts", "a.ts", "b.ts"]);
	});

	it("skips entries without filePath", () => {
		const raw = JSON.stringify([
			{ messages: [{ ruleId: "x", severity: 2, message: "m", line: 1 }] },
		]);
		expect(parseEslintOutput(raw)).toEqual([]);
	});

	it("skips messages without text", () => {
		const raw = JSON.stringify([
			{
				filePath: "a.ts",
				messages: [{ ruleId: "x", severity: 2, message: "", line: 1 }],
			},
		]);
		expect(parseEslintOutput(raw)).toEqual([]);
	});

	it("uses 'unknown' when ruleId is missing", () => {
		const raw = JSON.stringify([
			{
				filePath: "a.ts",
				messages: [{ severity: 2, message: "Something bad", line: 1 }],
			},
		]);
		const findings = parseEslintOutput(raw);
		expect(findings[0]!.title).toContain("eslint(unknown)");
	});
});

describe("eslintSpec", () => {
	it("targets code-reviewer lane", () => {
		expect(eslintSpec.lane).toBe("code-reviewer");
	});

	it("is default-disabled (opt-in)", () => {
		expect(eslintSpec.defaultEnabled).toBe(false);
	});

	it("uses --format json", () => {
		const args = eslintSpec.buildArgs();
		expect(args).toContain("--format");
		expect(args).toContain("json");
	});
});
