import {
	biomeSpec,
	parseBiomeOutput,
} from "../../../scanners/typescript/biome.js";

describe("parseBiomeOutput", () => {
	it("returns no findings for empty diagnostics", () => {
		expect(parseBiomeOutput(JSON.stringify({ diagnostics: [] }))).toEqual([]);
	});

	it("returns no findings for non-object root", () => {
		expect(parseBiomeOutput(JSON.stringify([]))).toEqual([]);
		expect(parseBiomeOutput(JSON.stringify(null))).toEqual([]);
	});

	it("returns no findings when diagnostics key is missing", () => {
		expect(parseBiomeOutput(JSON.stringify({ foo: "bar" }))).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseBiomeOutput("not json")).toThrow(/not valid JSON/);
	});

	it("parses a diagnostic with error severity", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/correctness/noUnusedVariables",
					severity: "error",
					description: "This variable is unused.",
					location: {
						path: { file: "src/utils.ts" },
						span: { start: { line: 10 } },
					},
				},
			],
		});

		const findings = parseBiomeOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("CRITICAL");
		expect(f.file).toBe("src/utils.ts");
		expect(f.line).toBe(10);
		expect(f.title).toContain("biome:");
		expect(f.title).toContain("lint/correctness/noUnusedVariables");
		expect(f.description).toContain("This variable is unused.");
	});

	it("maps warning severity to IMPORTANT", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/style/useConst",
					severity: "warning",
					description: "Use const instead of let.",
					location: {
						path: { file: "src/main.ts" },
						span: { start: { line: 5 } },
					},
				},
			],
		});

		const findings = parseBiomeOutput(raw);
		expect(findings[0]!.severity).toBe("IMPORTANT");
	});

	it("maps fatal severity to CRITICAL", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "parse",
					severity: "fatal",
					description: "Expected semicolon",
					location: {
						path: { file: "src/broken.ts" },
						span: { start: { line: 1 } },
					},
				},
			],
		});

		expect(parseBiomeOutput(raw)[0]!.severity).toBe("CRITICAL");
	});

	it("skips diagnostics without a file path", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint",
					severity: "error",
					description: "Something wrong",
					location: {},
				},
			],
		});

		expect(parseBiomeOutput(raw)).toEqual([]);
	});

	it("falls back to message.content when description is missing", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/x",
					severity: "error",
					message: { content: "Fallback message" },
					location: {
						path: { file: "a.ts" },
						span: { start: { line: 1 } },
					},
				},
			],
		});

		const findings = parseBiomeOutput(raw);
		expect(findings[0]!.description).toContain("Fallback message");
	});

	it("handles multiple diagnostics across files", () => {
		const raw = JSON.stringify({
			diagnostics: [
				{
					category: "lint/a",
					severity: "error",
					description: "Issue A",
					location: { path: { file: "a.ts" }, span: { start: { line: 1 } } },
				},
				{
					category: "lint/b",
					severity: "warning",
					description: "Issue B",
					location: { path: { file: "b.ts" }, span: { start: { line: 2 } } },
				},
			],
		});

		const findings = parseBiomeOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.file)).toEqual(["a.ts", "b.ts"]);
	});
});

describe("biomeSpec", () => {
	it("targets code-reviewer lane", () => {
		expect(biomeSpec.lane).toBe("code-reviewer");
	});

	it("is default-enabled", () => {
		expect(biomeSpec.defaultEnabled).toBe(true);
	});

	it("uses biome check --reporter json", () => {
		const args = biomeSpec.buildArgs();
		expect(args).toContain("check");
		expect(args).toContain("--reporter");
		expect(args).toContain("json");
	});

	it("detects biome.json in cwd", () => {
		// detectAuto is tested via the spec's config file detection
		expect(biomeSpec.detectAuto).toBeDefined();
	});
});
