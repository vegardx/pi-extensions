/**
 * Tests for orchestrator output parsing and the auto-review report
 * / fix-prompt builders that changed from Finding[] → OrchestratedFinding[].
 */

import {
	buildAutoReviewDiscussionPrompt,
	buildAutoReviewFixPrompt,
	buildAutoReviewReport,
	formatTierAttribution,
	shouldSkipOrchestrator,
} from "../auto-review.js";
import {
	type OrchestratedFinding,
	parseOrchestratorOutput,
} from "../findings.js";

// ---- parseOrchestratorOutput -------------------------------------------

function makeOF(
	overrides: Partial<OrchestratedFinding> = {},
): OrchestratedFinding {
	return {
		severity: "IMPORTANT",
		file: "src/foo.ts",
		title: "some issue",
		description: "it is bad",
		suggestedAction: "fix it",
		confidence: "high",
		confirmedByTiers: ["primary"],
		confirmedByRoles: ["code-reviewer"],
		staticToolSource: null,
		...overrides,
	};
}

describe("parseOrchestratorOutput", () => {
	it("parses a bare JSON array", () => {
		const raw = JSON.stringify([makeOF()]);
		const out = parseOrchestratorOutput(raw);
		expect(out).toHaveLength(1);
		expect(out?.[0]?.confidence).toBe("high");
	});

	it("parses a ```json fenced block", () => {
		const raw = `\`\`\`json\n${JSON.stringify([makeOF({ confidence: "medium" })])}\n\`\`\``;
		const out = parseOrchestratorOutput(raw);
		expect(out?.[0]?.confidence).toBe("medium");
	});

	it("defaults unknown confidence to 'medium'", () => {
		const raw = JSON.stringify([{ ...makeOF(), confidence: "banana" }]);
		const out = parseOrchestratorOutput(raw);
		expect(out?.[0]?.confidence).toBe("medium");
	});

	it("filters out entries missing required fields", () => {
		const raw = JSON.stringify([
			{ severity: "CRITICAL", title: "no file" }, // missing file
			makeOF(),
		]);
		const out = parseOrchestratorOutput(raw);
		expect(out).toHaveLength(1);
	});

	it("extracts orchestratorNote when present", () => {
		const raw = JSON.stringify([
			makeOF({
				confidence: "low",
				orchestratorNote: "only one model flagged this",
			}),
		]);
		const out = parseOrchestratorOutput(raw);
		expect(out?.[0]?.orchestratorNote).toBe("only one model flagged this");
	});

	it("sets staticToolSource when present", () => {
		const raw = JSON.stringify([makeOF({ staticToolSource: "tsc" })]);
		const out = parseOrchestratorOutput(raw);
		expect(out?.[0]?.staticToolSource).toBe("tsc");
	});

	it("returns null on unparseable input", () => {
		expect(parseOrchestratorOutput("not json at all {{{{")).toBeNull();
	});

	it("returns [] on empty input", () => {
		expect(parseOrchestratorOutput("")).toEqual([]);
	});

	it("returns [] on empty JSON array", () => {
		expect(parseOrchestratorOutput("[]")).toEqual([]);
	});
});

// ---- buildAutoReviewReport ---------------------------------------------

const BASE_REPORT_OPTS = {
	scopeLabel: "current branch vs. main",
	roles: ["code-reviewer", "security-analyst"],
	multiModel: true,
	primaryModel: "anthropic/claude-opus-4-5",
	secondaryModel: "openai/gpt-5",
	findings: [] as OrchestratedFinding[],
	autoApplied: [] as OrchestratedFinding[],
	surfaced: [] as OrchestratedFinding[],
	orchestratorRan: true,
	staticToolsRan: 2,
	totalInvocations: 4,
	diffSize: 30,
	errors: [] as Array<{ role: never; tier: never; error: string }>,
};

describe("buildAutoReviewReport", () => {
	it("includes scope and models in multi-model mode", () => {
		const report = buildAutoReviewReport(BASE_REPORT_OPTS);
		expect(report).toContain("current branch vs. main");
		expect(report).toContain("anthropic/claude-opus-4-5");
		expect(report).toContain("openai/gpt-5");
		expect(report).toContain("multi-model");
	});

	it("shows static tools ran count", () => {
		const report = buildAutoReviewReport(BASE_REPORT_OPTS);
		expect(report).toContain("2 tool(s) ran");
	});

	it("shows auto-apply and surfaced sections when findings present", () => {
		const autoFinding = makeOF({
			confidence: "high",
			suggestedAction: "do this",
			confirmedByRoles: ["code-reviewer"],
		});
		const surfacedFinding = makeOF({
			confidence: "medium",
			suggestedAction: "",
			confirmedByRoles: ["security-analyst"],
		});
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [autoFinding, surfacedFinding],
			autoApplied: [autoFinding],
			surfaced: [surfacedFinding],
		});
		expect(report).toContain("Auto-applying:");
		expect(report).toContain("Needs discussion:");
		expect(report).toContain("2 total");
	});

	it("shows orchestrator-skipped message when orchestratorRan=false and no error", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			orchestratorRan: false,
		});
		expect(report).toContain("skipped");
		expect(report).toContain("no input findings");
	});

	it("emits no-findings message when both lists are empty", () => {
		const report = buildAutoReviewReport(BASE_REPORT_OPTS);
		expect(report).toContain("Nothing to");
	});

	it("shows low-confidence tag on surfaced CRITICALs", () => {
		const lowCritical = makeOF({
			severity: "CRITICAL",
			confidence: "low",
			suggestedAction: "",
			orchestratorNote: "secondary model disagreed",
		});
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [lowCritical],
			surfaced: [lowCritical],
		});
		expect(report).toContain("low confidence");
		expect(report).toContain("secondary model disagreed");
	});
});

// ---- buildAutoReviewFixPrompt ------------------------------------------

describe("buildAutoReviewFixPrompt", () => {
	it("includes confidence and roles in the prompt", () => {
		const finding = makeOF({
			confidence: "high",
			confirmedByRoles: ["code-reviewer", "security-analyst"],
			suggestedAction: "change line 42",
		});
		const prompt = buildAutoReviewFixPrompt([finding], "model-a", "model-b");
		expect(prompt).toContain("high");
		expect(prompt).toContain("code-reviewer");
		expect(prompt).toContain("change line 42");
		expect(prompt).toContain("[auto-review]");
	});

	it("includes orchestratorNote when present", () => {
		const finding = makeOF({ orchestratorNote: "verified via grep" });
		const prompt = buildAutoReviewFixPrompt([finding], "model-a");
		expect(prompt).toContain("verified via grep");
	});
});

// ---- buildAutoReviewDiscussionPrompt -----------------------------------

describe("buildAutoReviewDiscussionPrompt", () => {
	it("labels low-confidence findings", () => {
		const finding = makeOF({
			severity: "CRITICAL",
			confidence: "low",
			suggestedAction: "",
			orchestratorNote: "unverified",
		});
		const prompt = buildAutoReviewDiscussionPrompt(
			[finding],
			"primary-model",
			"secondary-model",
		);
		expect(prompt).toContain("low confidence");
		expect(prompt).toContain("[auto-review");
	});

	it("includes fix options (a/b/c)", () => {
		const prompt = buildAutoReviewDiscussionPrompt(
			[makeOF({ suggestedAction: "" })],
			"m",
			undefined,
		);
		expect(prompt).toMatch(/a\) Fix/i);
		expect(prompt).toMatch(/b\) Investigate/i);
		expect(prompt).toMatch(/c\) Accept/i);
	});
});

// ---- Error rendering in report -----------------------------------------

describe("buildAutoReviewReport — error rendering", () => {
	it("renders per-error detail lines with role/tier and message", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			errors: [
				{
					role: "code-reviewer" as never,
					tier: "secondary" as never,
					error: "Timeout waiting for agent to become idle. Stderr: rate limit",
				},
			],
		});
		expect(report).toContain("Reviewer errors");
		expect(report).toContain("code-reviewer/secondary");
		expect(report).toContain("Timeout waiting for agent");
	});

	it("truncates long error messages to 120 chars", () => {
		const longError = "x".repeat(200);
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			errors: [
				{
					role: "security-analyst" as never,
					tier: "primary" as never,
					error: longError,
				},
			],
		});
		// Should not contain the full 200-char string
		expect(report).not.toContain(longError);
		// Should contain the truncated 120-char prefix
		expect(report).toContain("x".repeat(120));
	});

	it("shows orchestrator error message when orchestratorRan=false with error", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			orchestratorRan: false,
			orchestratorError: "orchestrator timeout",
		});
		expect(report).toContain("failed");
		expect(report).toContain("orchestrator timeout");
		expect(report).not.toContain("skipped");
	});

	it("emits suspicious-silence warning on large diff with all-empty lanes", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [],
			autoApplied: [],
			surfaced: [],
			orchestratorRan: false,
			totalInvocations: 6,
			diffSize: 200,
		});
		expect(report).toContain("⚠️");
		expect(report).toContain("non-trivial diff");
	});

	it("does NOT emit suspicious-silence warning on small diff", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [],
			autoApplied: [],
			surfaced: [],
			orchestratorRan: false,
			totalInvocations: 6,
			diffSize: 10,
		});
		expect(report).not.toContain("⚠️");
	});

	it("does NOT emit suspicious-silence warning when orchestratorError is present", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [],
			autoApplied: [],
			surfaced: [],
			orchestratorRan: false,
			orchestratorError: "orchestrator timeout",
			totalInvocations: 6,
			diffSize: 200,
		});
		expect(report).not.toContain("⚠️");
		expect(report).toContain("failed");
	});
});

// ---- shouldSkipOrchestrator threshold ----------------------------------

describe("shouldSkipOrchestrator", () => {
	it("skips when 0 findings and error rate below 1/3", () => {
		expect(shouldSkipOrchestrator(0, 0)).toBe(true);
		expect(shouldSkipOrchestrator(0, 0.2)).toBe(true);
		expect(shouldSkipOrchestrator(0, 1 / 6)).toBe(true);
	});

	it("does NOT skip when 0 findings and error rate >= 1/3", () => {
		expect(shouldSkipOrchestrator(0, 1 / 3)).toBe(false);
		expect(shouldSkipOrchestrator(0, 0.5)).toBe(false);
		expect(shouldSkipOrchestrator(0, 1.0)).toBe(false);
	});

	it("never skips when there are input findings", () => {
		expect(shouldSkipOrchestrator(5, 0)).toBe(false);
		expect(shouldSkipOrchestrator(1, 0.9)).toBe(false);
	});
});

// ---- formatTierAttribution ---------------------------------------------

describe("formatTierAttribution", () => {
	it("maps tier labels to model specs", () => {
		const result = formatTierAttribution(
			["primary", "secondary"],
			"anthropic/claude-sonnet-4-20250514",
			"openai/gpt-4o",
		);
		expect(result).toBe("anthropic/claude-sonnet-4-20250514 + openai/gpt-4o");
	});

	it("falls back to raw tier when model spec is missing", () => {
		const result = formatTierAttribution(["primary", "secondary"], "model-a");
		expect(result).toBe("model-a + secondary");
	});

	it("returns empty string for empty tiers array", () => {
		expect(formatTierAttribution([])).toBe("");
	});

	it("handles single tier", () => {
		const result = formatTierAttribution(
			["primary"],
			"anthropic/claude-sonnet-4-20250514",
			"openai/gpt-4o",
		);
		expect(result).toBe("anthropic/claude-sonnet-4-20250514");
	});

	it("dedupes repeated tier entries", () => {
		const result = formatTierAttribution(
			["primary", "primary"],
			"anthropic/claude-sonnet-4-20250514",
			"openai/gpt-4o",
		);
		expect(result).toBe("anthropic/claude-sonnet-4-20250514");
	});
});

// ---- Model attribution in outputs --------------------------------------

describe("model attribution in rendered outputs", () => {
	it("buildAutoReviewReport includes model names in auto-apply listing", () => {
		const finding = makeOF({
			confidence: "high",
			suggestedAction: "fix it",
			confirmedByTiers: ["primary", "secondary"],
			confirmedByRoles: ["code-reviewer"],
		});
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [finding],
			autoApplied: [finding],
			surfaced: [],
		});
		const findingLine = report
			.split("\n")
			.find((l) => l.includes("some issue"));
		expect(findingLine).toContain("{anthropic/claude-opus-4-5 + openai/gpt-5}");
	});

	it("buildAutoReviewReport includes model names in surfaced listing", () => {
		const finding = makeOF({
			confidence: "medium",
			suggestedAction: "",
			confirmedByTiers: ["secondary"],
			confirmedByRoles: ["security-analyst"],
		});
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [finding],
			autoApplied: [],
			surfaced: [finding],
		});
		expect(report).toContain("{openai/gpt-5}");
	});

	it("buildAutoReviewReport omits model tag when confirmedByTiers is empty", () => {
		const finding = makeOF({
			confidence: "high",
			suggestedAction: "fix",
			confirmedByTiers: [],
			confirmedByRoles: ["code-reviewer"],
		});
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			findings: [finding],
			autoApplied: [finding],
			surfaced: [],
		});
		// No curly-brace model tag on the finding line
		const lines = report.split("\n");
		const findingLine = lines.find((l) => l.includes("some issue"));
		expect(findingLine).not.toContain("{");
	});

	it("buildAutoReviewFixPrompt includes Models field", () => {
		const finding = makeOF({
			confidence: "high",
			confirmedByTiers: ["primary", "secondary"],
			confirmedByRoles: ["code-reviewer"],
			suggestedAction: "do it",
		});
		const prompt = buildAutoReviewFixPrompt(
			[finding],
			"anthropic/claude-sonnet-4-20250514",
			"openai/gpt-4o",
		);
		expect(prompt).toContain(
			"Models: anthropic/claude-sonnet-4-20250514 + openai/gpt-4o",
		);
	});

	it("buildAutoReviewFixPrompt omits Models field when tiers empty", () => {
		const finding = makeOF({
			confidence: "high",
			confirmedByTiers: [],
			confirmedByRoles: ["code-reviewer"],
			suggestedAction: "do it",
		});
		const prompt = buildAutoReviewFixPrompt([finding], "model-a", "model-b");
		expect(prompt).not.toContain("Models:");
	});

	it("buildAutoReviewDiscussionPrompt includes Models field", () => {
		const finding = makeOF({
			confidence: "medium",
			suggestedAction: "",
			confirmedByTiers: ["primary"],
			confirmedByRoles: ["security-analyst"],
		});
		const prompt = buildAutoReviewDiscussionPrompt(
			[finding],
			"anthropic/claude-sonnet-4-20250514",
			"openai/gpt-4o",
		);
		expect(prompt).toContain("Models: anthropic/claude-sonnet-4-20250514");
		// The per-finding line should NOT include gpt-4o since only primary tier confirmed it
		const findingLine = prompt.split("\n").find((l) => l.includes("Roles:"));
		expect(findingLine).toContain("Models: anthropic/claude-sonnet-4-20250514");
		expect(findingLine).not.toContain("openai/gpt-4o");
	});
});
