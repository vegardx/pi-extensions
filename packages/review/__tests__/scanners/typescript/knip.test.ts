import {
	knipSpec,
	parseKnipOutput,
} from "../../../scanners/typescript/knip.js";

describe("parseKnipOutput", () => {
	it("returns no findings for empty object", () => {
		expect(parseKnipOutput(JSON.stringify({}))).toEqual([]);
	});

	it("returns no findings for non-object root", () => {
		expect(parseKnipOutput(JSON.stringify([]))).toEqual([]);
		expect(parseKnipOutput(JSON.stringify(null))).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseKnipOutput("not json")).toThrow(/not valid JSON/);
	});

	it("parses unused files", () => {
		const raw = JSON.stringify({
			files: ["src/dead.ts", "src/orphan.ts"],
		});

		const findings = parseKnipOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings[0]!.severity).toBe("NOTE");
		expect(findings[0]!.file).toBe("src/dead.ts");
		expect(findings[0]!.title).toBe("unused file");
		expect(findings[0]!.description).toContain("src/dead.ts");
	});

	it("parses nested issues per file", () => {
		const raw = JSON.stringify({
			issues: [
				{
					file: "src/utils.ts",
					issues: [
						{ type: "export", name: "helperFn", line: 42 },
						{ type: "type", name: "OldType", line: 10 },
					],
				},
			],
		});

		const findings = parseKnipOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings[0]!.file).toBe("src/utils.ts");
		expect(findings[0]!.line).toBe(42);
		expect(findings[0]!.title).toBe("unused export: helperFn");
		expect(findings[0]!.suggestedAction).toContain("helperFn");
		expect(findings[1]!.title).toBe("unused type: OldType");
	});

	it("skips issues without a file field", () => {
		const raw = JSON.stringify({
			issues: [
				{
					issues: [{ type: "export", name: "x", line: 1 }],
				},
			],
		});
		expect(parseKnipOutput(raw)).toEqual([]);
	});

	it("handles both files and issues together", () => {
		const raw = JSON.stringify({
			files: ["dead.ts"],
			issues: [
				{
					file: "utils.ts",
					issues: [{ type: "export", name: "fn", line: 5 }],
				},
			],
		});

		const findings = parseKnipOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings[0]!.file).toBe("dead.ts");
		expect(findings[1]!.file).toBe("utils.ts");
	});

	it("uses (unnamed) when name is missing", () => {
		const raw = JSON.stringify({
			issues: [
				{
					file: "a.ts",
					issues: [{ type: "export" }],
				},
			],
		});

		const findings = parseKnipOutput(raw);
		expect(findings[0]!.title).toContain("(unnamed)");
	});
});

describe("knipSpec", () => {
	it("targets code-simplifier lane", () => {
		expect(knipSpec.lane).toBe("code-simplifier");
	});

	it("is default-disabled (opt-in)", () => {
		expect(knipSpec.defaultEnabled).toBe(false);
	});

	it("uses --reporter json", () => {
		const args = knipSpec.buildArgs();
		expect(args).toContain("--reporter");
		expect(args).toContain("json");
	});

	it("has a 60s budget", () => {
		expect(knipSpec.budgetMs).toBe(60_000);
	});
});
