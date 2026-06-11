/**
 * Pure tests for commit's confidence-driven review walk.
 */

import type { OrchestratedFinding } from "pi-ext-review/findings";
import {
	buildReviewFixPrompt,
	formatFinding,
	pickerOptions,
	recommendationFor,
} from "../review-walk.js";

function finding(over?: Partial<OrchestratedFinding>): OrchestratedFinding {
	return {
		severity: "IMPORTANT",
		file: "src/a.ts",
		line: 12,
		title: "possible null deref",
		description: "x may be undefined here",
		confidence: "high",
		confirmedByTiers: [],
		confirmedByRoles: ["code-review"],
		staticToolSource: null,
		...over,
	};
}

describe("recommendationFor (confidence-driven)", () => {
	it("high confidence + fix → Accept", () => {
		const rec = recommendationFor(finding({ suggestedAction: "add a guard" }));
		expect(rec?.action).toBe("accept");
		expect(rec?.reasons).toContain("high curator confidence");
	});

	it("high confidence without fix → Explain", () => {
		const rec = recommendationFor(finding());
		expect(rec?.action).toBe("explain");
	});

	it("CRITICAL without fix at lower confidence → Explain", () => {
		const rec = recommendationFor(
			finding({ severity: "CRITICAL", confidence: "low" }),
		);
		expect(rec?.action).toBe("explain");
		expect(rec?.reasons).toContain("CRITICAL severity");
	});

	it("medium-confidence IMPORTANT → no nudge", () => {
		expect(
			recommendationFor(
				finding({ confidence: "medium", suggestedAction: "do x" }),
			),
		).toBeNull();
	});
});

describe("pickerOptions", () => {
	it("marks the recommended option", () => {
		const acceptRec = pickerOptions({ action: "accept", reasons: [] });
		expect(acceptRec[0]).toContain("(Recommended)");
		const explainRec = pickerOptions({ action: "explain", reasons: [] });
		expect(explainRec[2]).toContain("(Recommended)");
		const neutral = pickerOptions(null);
		expect(neutral.join(" ")).not.toContain("(Recommended)");
	});
});

describe("formatFinding", () => {
	it("renders location, confidence, lenses, fix and curator note", () => {
		const text = formatFinding(
			1,
			3,
			finding({
				suggestedAction: "add a guard",
				orchestratorNote: "verified via grep",
				staticToolSource: "tsc",
			}),
		);
		expect(text).toContain("[1/3] IMPORTANT — possible null deref");
		expect(text).toContain("`src/a.ts:12`");
		expect(text).toContain("**Confidence**: high");
		expect(text).toContain("code-review (via tsc)");
		expect(text).toContain("**Suggested action**: add a guard");
		expect(text).toContain("**Curator note**: verified via grep");
		expect(text).toContain("Recommending **Accept**");
	});
});

describe("buildReviewFixPrompt", () => {
	it("lists accepted fixes and explain requests in separate sections", () => {
		const prompt = buildReviewFixPrompt(
			[finding({ suggestedAction: "add a guard" })],
			[finding({ title: "unclear contract" })],
		);
		expect(prompt).toContain("## Accepted — apply these fixes");
		expect(prompt).toContain("Fix: add a guard");
		expect(prompt).toContain("## Explain — user requested more detail");
		expect(prompt).toContain("unclear contract");
	});

	it("omits empty sections", () => {
		const prompt = buildReviewFixPrompt(
			[finding({ suggestedAction: "fix" })],
			[],
		);
		expect(prompt).not.toContain("## Explain");
	});
});
