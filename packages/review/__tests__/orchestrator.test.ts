/**
 * Tests for orchestrator output parsing and the auto-review report
 * / fix-prompt builders that changed from Finding[] → OrchestratedFinding[].
 */

import {
	buildAutoReviewDiscussionPrompt,
	buildAutoReviewFixPrompt,
	buildAutoReviewReport,
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

	it("shows orchestrator-not-run warning when orchestratorRan=false", () => {
		const report = buildAutoReviewReport({
			...BASE_REPORT_OPTS,
			orchestratorRan: false,
		});
		expect(report).toContain("did not run");
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
