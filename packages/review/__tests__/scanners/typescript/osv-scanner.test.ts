import {
	osvScannerSpec,
	parseOsvScannerOutput,
} from "../../../scanners/typescript/osv-scanner.js";

describe("parseOsvScannerOutput", () => {
	it("returns no findings for empty results", () => {
		expect(parseOsvScannerOutput(JSON.stringify({ results: [] }))).toEqual([]);
	});

	it("returns no findings when root is not an object", () => {
		expect(parseOsvScannerOutput(JSON.stringify([]))).toEqual([]);
		expect(parseOsvScannerOutput("null")).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseOsvScannerOutput("not json")).toThrow(/not valid JSON/);
	});

	it("parses a single vuln, picks severity from groups[].max_severity", () => {
		const raw = JSON.stringify({
			results: [
				{
					source: { path: "package-lock.json", type: "lockfile" },
					packages: [
						{
							package: { name: "lodash", version: "4.17.10", ecosystem: "npm" },
							vulnerabilities: [
								{
									id: "GHSA-jf85-cpcp-j695",
									summary: "Prototype Pollution in lodash",
									severity: [
										{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/..." },
									],
									database_specific: { severity: "HIGH" },
								},
							],
							groups: [
								{
									ids: ["GHSA-jf85-cpcp-j695"],
									aliases: ["CVE-2019-10744", "GHSA-jf85-cpcp-j695"],
									max_severity: "9.1",
								},
							],
						},
					],
				},
			],
		});

		const findings = parseOsvScannerOutput(raw);
		expect(findings).toHaveLength(1);
		const f = findings[0]!;
		expect(f.severity).toBe("CRITICAL");
		expect(f.file).toBe("package-lock.json");
		expect(f.title).toBe("osv-scanner: GHSA-jf85-cpcp-j695 in lodash@4.17.10");
		expect(f.description).toContain("Prototype Pollution in lodash");
		expect(f.description).toContain("[npm]");
		expect(f.description).toContain("CVE-2019-10744");
	});

	it("falls back to database_specific.severity when max_severity absent", () => {
		const raw = JSON.stringify({
			results: [
				{
					source: { path: "go.sum" },
					packages: [
						{
							package: {
								name: "github.com/x/y",
								version: "1.0.0",
								ecosystem: "Go",
							},
							vulnerabilities: [
								{
									id: "PYSEC-1234",
									summary: "issue",
									database_specific: { severity: "MODERATE" },
								},
							],
							groups: [{ ids: ["PYSEC-1234"], aliases: [] }],
						},
					],
				},
			],
		});

		const findings = parseOsvScannerOutput(raw);
		expect(findings[0]!.severity).toBe("IMPORTANT");
	});

	it("defaults to IMPORTANT when no severity hint at all", () => {
		const raw = JSON.stringify({
			results: [
				{
					source: { path: "package-lock.json" },
					packages: [
						{
							package: { name: "x", version: "1", ecosystem: "npm" },
							vulnerabilities: [{ id: "X-1", summary: "" }],
							groups: [{ ids: ["X-1"], aliases: [] }],
						},
					],
				},
			],
		});
		expect(parseOsvScannerOutput(raw)[0]!.severity).toBe("IMPORTANT");
	});

	it("maps numeric max_severity bands correctly", () => {
		const make = (score: string) =>
			JSON.stringify({
				results: [
					{
						source: { path: "p.json" },
						packages: [
							{
								package: { name: "x", version: "1", ecosystem: "npm" },
								vulnerabilities: [{ id: "X", summary: "" }],
								groups: [{ ids: ["X"], aliases: [], max_severity: score }],
							},
						],
					},
				],
			});

		expect(parseOsvScannerOutput(make("3.9"))[0]!.severity).toBe("NOTE");
		expect(parseOsvScannerOutput(make("4.0"))[0]!.severity).toBe("IMPORTANT");
		expect(parseOsvScannerOutput(make("6.9"))[0]!.severity).toBe("IMPORTANT");
		expect(parseOsvScannerOutput(make("7.0"))[0]!.severity).toBe("CRITICAL");
		expect(parseOsvScannerOutput(make("9.5"))[0]!.severity).toBe("CRITICAL");
	});

	it("handles multiple packages within a single source", () => {
		const raw = JSON.stringify({
			results: [
				{
					source: { path: "package-lock.json" },
					packages: [
						{
							package: { name: "a", version: "1", ecosystem: "npm" },
							vulnerabilities: [{ id: "A-1", summary: "a issue" }],
							groups: [{ ids: ["A-1"], aliases: [] }],
						},
						{
							package: { name: "b", version: "2", ecosystem: "npm" },
							vulnerabilities: [{ id: "B-1", summary: "b issue" }],
							groups: [{ ids: ["B-1"], aliases: [] }],
						},
					],
				},
			],
		});

		const findings = parseOsvScannerOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings.map((f) => f.title)).toEqual([
			"osv-scanner: A-1 in a@1",
			"osv-scanner: B-1 in b@2",
		]);
	});

	it("handles multiple sources (monorepo)", () => {
		const raw = JSON.stringify({
			results: [
				{
					source: { path: "frontend/package-lock.json" },
					packages: [
						{
							package: { name: "fe", version: "1", ecosystem: "npm" },
							vulnerabilities: [{ id: "FE-1", summary: "" }],
							groups: [{ ids: ["FE-1"], aliases: [] }],
						},
					],
				},
				{
					source: { path: "backend/package-lock.json" },
					packages: [
						{
							package: { name: "be", version: "1", ecosystem: "npm" },
							vulnerabilities: [{ id: "BE-1", summary: "" }],
							groups: [{ ids: ["BE-1"], aliases: [] }],
						},
					],
				},
			],
		});

		const findings = parseOsvScannerOutput(raw);
		expect(findings).toHaveLength(2);
		expect(findings[0]!.file).toBe("frontend/package-lock.json");
		expect(findings[1]!.file).toBe("backend/package-lock.json");
	});

	it("falls back to package.json when source.path is missing", () => {
		const raw = JSON.stringify({
			results: [
				{
					packages: [
						{
							package: { name: "x", version: "1", ecosystem: "npm" },
							vulnerabilities: [{ id: "X", summary: "" }],
							groups: [{ ids: ["X"], aliases: [] }],
						},
					],
				},
			],
		});
		expect(parseOsvScannerOutput(raw)[0]!.file).toBe("package.json");
	});

	it("multiple vulns in one package produce multiple findings", () => {
		const raw = JSON.stringify({
			results: [
				{
					source: { path: "p.json" },
					packages: [
						{
							package: { name: "x", version: "1", ecosystem: "npm" },
							vulnerabilities: [
								{ id: "X-1", summary: "first" },
								{ id: "X-2", summary: "second" },
							],
							groups: [
								{ ids: ["X-1", "X-2"], aliases: [], max_severity: "5.0" },
							],
						},
					],
				},
			],
		});
		expect(parseOsvScannerOutput(raw)).toHaveLength(2);
	});
});

describe("osvScannerSpec", () => {
	it("is registered for the security-analyst lane", () => {
		expect(osvScannerSpec.lane).toBe("security-analyst");
	});

	it("default-disabled (opt-in until 166c wires enable: auto)", () => {
		expect(osvScannerSpec.defaultEnabled).toBe(false);
	});

	it("targets package-lock.json with json output", () => {
		const args = osvScannerSpec.buildArgs();
		expect(args).toContain("--format");
		expect(args).toContain("json");
		expect(args).toContain("--lockfile");
		expect(args).toContain("package-lock.json");
	});
});
