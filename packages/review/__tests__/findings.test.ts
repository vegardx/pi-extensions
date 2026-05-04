import {
	countBySeverity,
	dedupeFindings,
	parseReviewerOutput,
	recommendationFor,
} from "../findings.js";

describe("parseReviewerOutput", () => {
	it("parses a bare JSON array", () => {
		const json = JSON.stringify([
			{
				severity: "IMPORTANT",
				file: "src/a.ts",
				line: 4,
				title: "leaky",
				description: "it leaks",
			},
		]);
		const out = parseReviewerOutput(json);
		expect(out).toHaveLength(1);
		expect(out?.[0]?.title).toBe("leaky");
	});

	it("accepts a ```json fenced block", () => {
		const json = `\`\`\`json\n[{"severity":"NOTE","file":"x","title":"t","description":"d"}]\n\`\`\``;
		const out = parseReviewerOutput(json);
		expect(out).toHaveLength(1);
	});

	it("accepts a {findings: [...]} wrapper", () => {
		const json = JSON.stringify({
			findings: [
				{
					severity: "CRITICAL",
					file: "x",
					title: "t",
					description: "d",
				},
			],
		});
		expect(parseReviewerOutput(json)).toHaveLength(1);
	});

	it("normalises lenient severity synonyms", () => {
		const json = JSON.stringify([
			{ severity: "high", file: "x", title: "t", description: "d" },
			{ severity: "warn", file: "y", title: "t", description: "d" },
			{ severity: "info", file: "z", title: "t", description: "d" },
		]);
		const out = parseReviewerOutput(json);
		expect(out?.map((f) => f.severity)).toEqual([
			"CRITICAL",
			"IMPORTANT",
			"NOTE",
		]);
	});

	it("drops rows missing required fields", () => {
		const json = JSON.stringify([
			{ file: "x", title: "t", description: "d" }, // no severity
			{ severity: "NOTE", title: "t", description: "d" }, // no file
			{ severity: "NOTE", file: "x", description: "d" }, // no title
			{ severity: "NOTE", file: "x", title: "t" }, // missing description is OK (default "")
		]);
		const out = parseReviewerOutput(json);
		expect(out).toHaveLength(1);
		expect(out?.[0]?.description).toBe("");
	});

	it("returns null on unrecoverable output", () => {
		expect(parseReviewerOutput("not json at all")).toBeNull();
		expect(parseReviewerOutput("{")).toBeNull();
	});

	it("returns [] for empty input", () => {
		expect(parseReviewerOutput("")).toEqual([]);
		expect(parseReviewerOutput("   \n")).toEqual([]);
		expect(parseReviewerOutput("[]")).toEqual([]);
	});
});

describe("dedupeFindings", () => {
	it("merges identical findings from multiple reviewers", () => {
		const findings = dedupeFindings([
			{
				role: "code-reviewer",
				findings: [
					{
						severity: "IMPORTANT",
						file: "a.ts",
						line: 4,
						title: "null deref",
						description: "short",
					},
				],
			},
			{
				role: "architect",
				findings: [
					{
						severity: "IMPORTANT",
						file: "a.ts",
						line: 4,
						title: "null deref",
						description: "longer and more specific explanation",
					},
				],
			},
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.flaggedBy).toEqual(["code-reviewer", "architect"]);
		expect(findings[0]?.consensus).toBe(true);
		// Longer description wins.
		expect(findings[0]?.description).toBe(
			"longer and more specific explanation",
		);
	});

	it("treats title case-insensitively when deduping", () => {
		const findings = dedupeFindings([
			{
				role: "code-reviewer",
				findings: [
					{
						severity: "NOTE",
						file: "a.ts",
						line: 1,
						title: "Null Deref",
						description: "",
					},
				],
			},
			{
				role: "architect",
				findings: [
					{
						severity: "NOTE",
						file: "a.ts",
						line: 1,
						title: "null deref",
						description: "",
					},
				],
			},
		]);
		expect(findings).toHaveLength(1);
	});

	it("does not merge across different line numbers", () => {
		const findings = dedupeFindings([
			{
				role: "code-reviewer",
				findings: [
					{
						severity: "NOTE",
						file: "a.ts",
						line: 1,
						title: "t",
						description: "",
					},
					{
						severity: "NOTE",
						file: "a.ts",
						line: 2,
						title: "t",
						description: "",
					},
				],
			},
		]);
		expect(findings).toHaveLength(2);
	});

	it("promotes severity to the highest seen", () => {
		const findings = dedupeFindings([
			{
				role: "code-reviewer",
				findings: [
					{
						severity: "NOTE",
						file: "a.ts",
						line: 1,
						title: "t",
						description: "",
					},
				],
			},
			{
				role: "security-analyst",
				findings: [
					{
						severity: "CRITICAL",
						file: "a.ts",
						line: 1,
						title: "t",
						description: "",
					},
				],
			},
		]);
		expect(findings[0]?.severity).toBe("CRITICAL");
	});

	it("sorts CRITICAL → IMPORTANT → NOTE, consensus first within a tier", () => {
		const findings = dedupeFindings([
			{
				role: "code-reviewer",
				findings: [
					{
						severity: "NOTE",
						file: "a.ts",
						line: 1,
						title: "note alone",
						description: "",
					},
					{
						severity: "CRITICAL",
						file: "a.ts",
						line: 2,
						title: "crit consensus",
						description: "",
					},
					{
						severity: "CRITICAL",
						file: "a.ts",
						line: 3,
						title: "crit alone",
						description: "",
					},
				],
			},
			{
				role: "security-analyst",
				findings: [
					{
						severity: "CRITICAL",
						file: "a.ts",
						line: 2,
						title: "crit consensus",
						description: "",
					},
				],
			},
		]);
		expect(findings.map((f) => f.title)).toEqual([
			"crit consensus",
			"crit alone",
			"note alone",
		]);
	});
});

describe("countBySeverity", () => {
	it("counts across all three buckets", () => {
		const counts = countBySeverity([
			{
				severity: "CRITICAL",
				file: "a",
				title: "t",
				description: "",
				flaggedBy: ["code-reviewer"],
				consensus: false,
			},
			{
				severity: "NOTE",
				file: "b",
				title: "t",
				description: "",
				flaggedBy: ["code-reviewer"],
				consensus: false,
			},
			{
				severity: "NOTE",
				file: "c",
				title: "t",
				description: "",
				flaggedBy: ["code-reviewer"],
				consensus: false,
			},
		]);
		expect(counts).toEqual({ CRITICAL: 1, IMPORTANT: 0, NOTE: 2 });
	});
});

describe("recommendationFor", () => {
	function finding(
		overrides: Partial<Parameters<typeof recommendationFor>[0]> = {},
	) {
		return {
			severity: "IMPORTANT" as const,
			file: "src/foo.ts",
			line: 42,
			title: "t",
			description: "d",
			flaggedBy: ["code-reviewer" as const],
			consensus: false,
			...overrides,
		};
	}

	it("recommends Accept on a CRITICAL finding with a concrete fix", () => {
		const rec = recommendationFor(
			finding({
				severity: "CRITICAL",
				suggestedAction: "parameterize the query",
			}),
		);
		expect(rec?.action).toBe("accept");
		expect(rec?.reasons).toContain("CRITICAL severity");
		expect(rec?.reasons).toContain("concrete fix available");
	});

	it("recommends Accept on a consensus finding with a concrete fix", () => {
		const rec = recommendationFor(
			finding({
				flaggedBy: ["code-reviewer", "security-analyst"],
				consensus: true,
				suggestedAction: "add a null check",
			}),
		);
		expect(rec?.action).toBe("accept");
		expect(rec?.reasons).toContain("2 reviewers agree");
	});

	it("recommends Accept when both signals fire", () => {
		const rec = recommendationFor(
			finding({
				severity: "CRITICAL",
				flaggedBy: ["code-reviewer", "security-analyst", "architect"],
				consensus: true,
				suggestedAction: "parameterize the query",
			}),
		);
		expect(rec?.action).toBe("accept");
		expect(rec?.reasons).toEqual([
			"CRITICAL severity",
			"3 reviewers agree",
			"concrete fix available",
		]);
	});

	it("recommends Explain when high-confidence but no concrete fix", () => {
		const rec = recommendationFor(
			finding({ severity: "CRITICAL" /* no suggestedAction */ }),
		);
		expect(rec?.action).toBe("explain");
		expect(rec?.reasons).toContain("CRITICAL severity");
		expect(rec?.reasons).toContain("no concrete fix yet");
	});

	it("treats empty / whitespace suggestedAction as no fix", () => {
		expect(
			recommendationFor(finding({ severity: "CRITICAL", suggestedAction: "" }))
				?.action,
		).toBe("explain");
		expect(
			recommendationFor(
				finding({ severity: "CRITICAL", suggestedAction: "   " }),
			)?.action,
		).toBe("explain");
	});

	it("returns null on single-reviewer IMPORTANT with a fix", () => {
		// Important but only one reviewer, no consensus — leave the user alone.
		expect(
			recommendationFor(
				finding({ severity: "IMPORTANT", suggestedAction: "do the thing" }),
			),
		).toBeNull();
	});

	it("returns null on single-reviewer NOTE", () => {
		expect(
			recommendationFor(
				finding({ severity: "NOTE", suggestedAction: "rename the var" }),
			),
		).toBeNull();
	});

	it("recommends Accept on consensus NOTE with a fix", () => {
		// NOTE + consensus + fix: two reviewers independently agreed on a
		// concrete minor improvement. Safe to recommend accepting.
		const rec = recommendationFor(
			finding({
				severity: "NOTE",
				flaggedBy: ["code-reviewer", "code-simplifier"],
				consensus: true,
				suggestedAction: "inline the single-use helper",
			}),
		);
		expect(rec?.action).toBe("accept");
	});

	it("never recommends Skip", () => {
		// Pure observational NOTE with no fix: we could imagine skipping, but
		// recommending a skip silences real issues, so we stay neutral.
		expect(
			recommendationFor(
				finding({ severity: "NOTE" /* no fix, no consensus */ }),
			),
		).toBeNull();
	});
});
