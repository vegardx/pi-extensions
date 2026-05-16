import {
	gitleaksSpec,
	parseGitleaksOutput,
} from "../../../scanners/typescript/gitleaks.js";

describe("parseGitleaksOutput", () => {
	it("returns no findings for empty array", () => {
		expect(parseGitleaksOutput("[]")).toEqual([]);
	});

	it("returns no findings when root is not an array", () => {
		expect(parseGitleaksOutput("{}")).toEqual([]);
		expect(parseGitleaksOutput("null")).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseGitleaksOutput("not json")).toThrow(/not valid JSON/);
	});

	it("parses a single secret finding", () => {
		const raw = JSON.stringify([
			{
				RuleID: "aws-access-token",
				Description: "AWS Access Token",
				StartLine: 12,
				EndLine: 12,
				File: "config/secrets.yml",
				Match: "AKIAIOSFODNN7EXAMPLE",
				Secret: "AKIAIOSFODNN7EXAMPLE",
				Tags: ["key", "AWS"],
				Entropy: 3.65,
			},
		]);

		const findings = parseGitleaksOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("CRITICAL");
		expect(f.file).toBe("config/secrets.yml");
		expect(f.line).toBe(12);
		expect(f.title).toBe("gitleaks: aws-access-token at config/secrets.yml:12");
		expect(f.description).toBe("AWS Access Token [key, AWS]");
		expect(f.suggestedAction).toMatch(/rotate/i);
	});

	it("never leaks Secret or Match into rendered fields", () => {
		// The whole point of the scanner is to flag a secret without
		// re-leaking it in the report. Pi review findings get embedded
		// in chat output and PR bodies, where echoing the value back
		// would defeat the scanner.
		const fakeSecret = "ghp_FAKEFAKEFAKE1234567890ABCDEFGHIJKL";
		const raw = JSON.stringify([
			{
				RuleID: "github-pat",
				Description: "GitHub Personal Access Token",
				StartLine: 7,
				File: "src/leaked.ts",
				Match: fakeSecret,
				Secret: fakeSecret,
				Tags: [],
			},
		]);

		const findings = parseGitleaksOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.title).not.toContain(fakeSecret);
		expect(f.description).not.toContain(fakeSecret);
		expect(f.suggestedAction ?? "").not.toContain(fakeSecret);
	});

	it("handles multiple findings across multiple files", () => {
		const raw = JSON.stringify([
			{
				RuleID: "aws-access-token",
				Description: "AWS",
				StartLine: 1,
				File: "a.yml",
				Tags: [],
			},
			{
				RuleID: "github-pat",
				Description: "GitHub PAT",
				StartLine: 99,
				File: "b.ts",
				Tags: [],
			},
		]);

		const findings = parseGitleaksOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.file)).toEqual(["a.yml", "b.ts"]);
		expect(findings.map((f) => f.line)).toEqual([1, 99]);
	});

	it("skips findings without a File field", () => {
		const raw = JSON.stringify([
			{ RuleID: "x", Description: "no file", Tags: [] },
		]);
		expect(parseGitleaksOutput(raw)).toEqual([]);
	});

	it("renders no tag suffix when Tags is empty or missing", () => {
		const raw = JSON.stringify([
			{ RuleID: "x", Description: "d", File: "f.ts", Tags: [] },
			{ RuleID: "y", Description: "e", File: "g.ts" },
		]);
		const findings = parseGitleaksOutput(raw);
		expect(findings[0]!.description).toBe("d");
		expect(findings[1]!.description).toBe("e");
	});

	it("falls back to RuleID when Description is missing", () => {
		const raw = JSON.stringify([
			{ RuleID: "aws-access-token", File: "f.ts", Tags: [] },
		]);
		const f = parseGitleaksOutput(raw)[0]!;
		expect(f.description).toBe("aws-access-token");
	});

	it("title omits line suffix when StartLine is missing", () => {
		const raw = JSON.stringify([
			{ RuleID: "x", Description: "d", File: "f.ts", Tags: [] },
		]);
		expect(parseGitleaksOutput(raw)[0]!.title).toBe("gitleaks: x at f.ts");
	});
});

describe("gitleaksSpec", () => {
	it("is registered for the security-analyst lane", () => {
		expect(gitleaksSpec.lane).toBe("security-analyst");
	});

	it("default-disabled (opt-in)", () => {
		expect(gitleaksSpec.defaultEnabled).toBe(false);
	});

	it("uses gitleaks dir (modern subcommand) with exit-code 0", () => {
		const args = gitleaksSpec.buildArgs();
		// `dir` is the modern non-deprecated subcommand; `detect` is
		// deprecated in v8.
		expect(args[0]).toBe("dir");
		// Exit-code override: gitleaks defaults to exit 1 on findings,
		// which the registry would mis-report as an error (no output
		// detection). We read findings from the JSON.
		const idx = args.indexOf("--exit-code");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("0");
	});

	it("writes JSON report to stdout", () => {
		const args = gitleaksSpec.buildArgs();
		const idx = args.indexOf("--report-path");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(args[idx + 1]).toBe("/dev/stdout");
	});
});
