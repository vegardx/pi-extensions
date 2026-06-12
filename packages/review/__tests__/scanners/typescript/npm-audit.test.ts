import {
	npmAuditSpec,
	parseNpmAuditOutput,
} from "../../../scanners/typescript/npm-audit.js";

describe("parseNpmAuditOutput", () => {
	it("returns no findings for empty object", () => {
		expect(parseNpmAuditOutput(JSON.stringify({}))).toEqual([]);
	});

	it("returns no findings for non-object root", () => {
		expect(parseNpmAuditOutput(JSON.stringify([]))).toEqual([]);
		expect(parseNpmAuditOutput(JSON.stringify(null))).toEqual([]);
	});

	it("throws on malformed JSON", () => {
		expect(() => parseNpmAuditOutput("not json")).toThrow(/not valid JSON/);
	});

	describe("npm v7+ schema (auditReportVersion 2)", () => {
		it("parses critical vulnerability", () => {
			const raw = JSON.stringify({
				auditReportVersion: 2,
				vulnerabilities: {
					lodash: {
						severity: "critical",
						range: "<4.17.21",
						via: [{ title: "Prototype Pollution" }],
						fixAvailable: true,
					},
				},
			});

			const findings = parseNpmAuditOutput(raw);
			expect(findings).toHaveLength(1);
			const f = findings[0]!;
			expect(f.severity).toBe("CRITICAL");
			expect(f.file).toBe("package.json");
			expect(f.title).toContain("Prototype Pollution");
			expect(f.title).toContain("lodash");
			expect(f.description).toContain("critical");
			expect(f.description).toContain("<4.17.21");
			expect(f.suggestedAction).toContain("npm audit fix");
		});

		it("maps high to CRITICAL, moderate to IMPORTANT, low to NOTE", () => {
			const makeVuln = (sev: string) =>
				JSON.stringify({
					auditReportVersion: 2,
					vulnerabilities: {
						pkg: {
							severity: sev,
							via: [{ title: "Bug" }],
							fixAvailable: false,
						},
					},
				});

			expect(parseNpmAuditOutput(makeVuln("high"))[0]!.severity).toBe(
				"CRITICAL",
			);
			expect(parseNpmAuditOutput(makeVuln("moderate"))[0]!.severity).toBe(
				"IMPORTANT",
			);
			expect(parseNpmAuditOutput(makeVuln("low"))[0]!.severity).toBe("NOTE");
		});

		it("skips info-level vulnerabilities", () => {
			const raw = JSON.stringify({
				auditReportVersion: 2,
				vulnerabilities: {
					pkg: { severity: "info", via: ["dep"], fixAvailable: false },
				},
			});
			expect(parseNpmAuditOutput(raw)).toEqual([]);
		});

		it("handles string via entries", () => {
			const raw = JSON.stringify({
				auditReportVersion: 2,
				vulnerabilities: {
					"sub-dep": {
						severity: "high",
						via: ["parent-dep"],
						fixAvailable: true,
					},
				},
			});

			const findings = parseNpmAuditOutput(raw);
			expect(findings[0]!.title).toContain("parent-dep");
		});

		it("suggests review when no fix available", () => {
			const raw = JSON.stringify({
				auditReportVersion: 2,
				vulnerabilities: {
					pkg: {
						severity: "moderate",
						via: [{ title: "Issue" }],
						fixAvailable: false,
					},
				},
			});

			expect(parseNpmAuditOutput(raw)[0]!.suggestedAction).toContain("Review");
		});
	});

	describe("npm v6 schema (advisories)", () => {
		it("parses advisory entries", () => {
			const raw = JSON.stringify({
				advisories: {
					"1234": {
						module_name: "qs",
						severity: "high",
						title: "Prototype Pollution in qs",
						url: "https://npmjs.com/advisories/1234",
					},
				},
			});

			const findings = parseNpmAuditOutput(raw);
			expect(findings).toHaveLength(1);
			const f = findings[0]!;
			expect(f.severity).toBe("CRITICAL");
			expect(f.title).toContain("qs");
			expect(f.description).toContain("https://npmjs.com/advisories/1234");
		});

		it("skips info severity in v6 schema", () => {
			const raw = JSON.stringify({
				advisories: {
					"1": { module_name: "x", severity: "info", title: "t" },
				},
			});
			expect(parseNpmAuditOutput(raw)).toEqual([]);
		});
	});
});

describe("npmAuditSpec", () => {
	it("targets security-analyst lane", () => {
		expect(npmAuditSpec.lane).toBe("security-analyst");
	});

	it("is default-enabled", () => {
		expect(npmAuditSpec.defaultEnabled).toBe(true);
	});

	it("uses npm audit --json", () => {
		const args = npmAuditSpec.buildArgs();
		expect(args).toEqual(["audit", "--json"]);
	});

	it("has a 20s budget", () => {
		expect(npmAuditSpec.budgetMs).toBe(20_000);
	});
});
