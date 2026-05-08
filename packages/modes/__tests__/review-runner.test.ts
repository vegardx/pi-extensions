import type { Finding } from "pi-ext-review/findings";
import {
	buildChallengeTask,
	buildFixPrompt,
	buildReviewTask,
	buildWarmUpTask,
	type ChallengeResult,
	classifyFindings,
	partitionChallengeResults,
} from "../review-runner.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		severity: "IMPORTANT",
		file: "src/handler.ts",
		line: 42,
		title: "Missing null check",
		description: "getUser() can return null but result is dereferenced.",
		flaggedBy: ["code-reviewer"],
		consensus: false,
		...overrides,
	};
}

describe("classifyFindings", () => {
	it("consensus findings (2+ agents) go to consensus", () => {
		const f = makeFinding({
			consensus: true,
			flaggedBy: ["code-reviewer", "security-analyst"],
		});
		const result = classifyFindings([f]);
		expect(result.consensus).toHaveLength(1);
		expect(result.needsChallenge).toHaveLength(0);
		expect(result.skip).toHaveLength(0);
	});

	it("cross-model consensus goes to consensus", () => {
		const f = makeFinding({
			consensus: false,
			crossModelConsensus: true,
			flaggedBy: ["code-reviewer"],
		});
		const result = classifyFindings([f]);
		expect(result.consensus).toHaveLength(1);
	});

	it("single-agent CRITICAL goes to needsChallenge", () => {
		const f = makeFinding({ severity: "CRITICAL", consensus: false });
		const result = classifyFindings([f]);
		expect(result.needsChallenge).toHaveLength(1);
		expect(result.consensus).toHaveLength(0);
	});

	it("single-agent IMPORTANT goes to needsChallenge", () => {
		const f = makeFinding({ severity: "IMPORTANT", consensus: false });
		const result = classifyFindings([f]);
		expect(result.needsChallenge).toHaveLength(1);
	});

	it("single-agent NOTE goes to skip", () => {
		const f = makeFinding({ severity: "NOTE", consensus: false });
		const result = classifyFindings([f]);
		expect(result.skip).toHaveLength(1);
		expect(result.needsChallenge).toHaveLength(0);
	});

	it("handles mixed findings correctly", () => {
		const findings: Finding[] = [
			makeFinding({
				title: "consensus",
				consensus: true,
				flaggedBy: ["code-reviewer", "code-simplifier"],
			}),
			makeFinding({
				title: "critical-solo",
				severity: "CRITICAL",
				consensus: false,
			}),
			makeFinding({ title: "note-solo", severity: "NOTE", consensus: false }),
		];
		const result = classifyFindings(findings);
		expect(result.consensus).toHaveLength(1);
		expect(result.needsChallenge).toHaveLength(1);
		expect(result.skip).toHaveLength(1);
	});
});

describe("partitionChallengeResults", () => {
	it("challenger agrees → confirmed", () => {
		const results: ChallengeResult[] = [
			{
				finding: makeFinding({ severity: "CRITICAL" }),
				agree: true,
				reason: "Valid issue",
				suggestedAction: "Add null check",
			},
		];
		const { confirmed, disputed } = partitionChallengeResults(results);
		expect(confirmed).toHaveLength(1);
		expect(confirmed[0].suggestedAction).toBe("Add null check");
		expect(disputed).toHaveLength(0);
	});

	it("challenger disagrees on CRITICAL → disputed (surfaced to user)", () => {
		const results: ChallengeResult[] = [
			{
				finding: makeFinding({ severity: "CRITICAL" }),
				agree: false,
				reason: "Not actually reachable",
			},
		];
		const { confirmed, disputed } = partitionChallengeResults(results);
		expect(confirmed).toHaveLength(0);
		expect(disputed).toHaveLength(1);
	});

	it("challenger disagrees on IMPORTANT → dropped (not surfaced)", () => {
		const results: ChallengeResult[] = [
			{
				finding: makeFinding({ severity: "IMPORTANT" }),
				agree: false,
				reason: "Not a real issue",
			},
		];
		const { confirmed, disputed } = partitionChallengeResults(results);
		expect(confirmed).toHaveLength(0);
		expect(disputed).toHaveLength(0);
	});

	it("populates suggestedAction from challenger when finding lacks one", () => {
		const finding = makeFinding({
			severity: "CRITICAL",
			suggestedAction: undefined,
		});
		const results: ChallengeResult[] = [
			{
				finding,
				agree: true,
				reason: "Valid",
				suggestedAction: "Use optional chaining",
			},
		];
		partitionChallengeResults(results);
		expect(finding.suggestedAction).toBe("Use optional chaining");
	});

	it("does not overwrite existing suggestedAction", () => {
		const finding = makeFinding({
			severity: "CRITICAL",
			suggestedAction: "Original fix",
		});
		const results: ChallengeResult[] = [
			{
				finding,
				agree: true,
				reason: "Valid",
				suggestedAction: "Different fix",
			},
		];
		partitionChallengeResults(results);
		expect(finding.suggestedAction).toBe("Original fix");
	});
});

describe("buildReviewTask", () => {
	it("includes diff and changed files", () => {
		const task = buildReviewTask({
			diff: "+const x = 1;",
			changedFiles: ["src/a.ts", "src/b.ts"],
			scopeLabel: "branch vs. main",
		});
		expect(task).toContain("+const x = 1;");
		expect(task).toContain("- src/a.ts");
		expect(task).toContain("branch vs. main");
	});
});

describe("buildWarmUpTask", () => {
	it("includes plan text and files", () => {
		const task = buildWarmUpTask({
			planText: "Add caching layer",
			changedFiles: ["src/cache.ts"],
		});
		expect(task).toContain("Add caching layer");
		expect(task).toContain("src/cache.ts");
		expect(task).toContain("Do NOT produce any output yet");
	});
});

describe("buildChallengeTask", () => {
	it("includes finding details and diff", () => {
		const task = buildChallengeTask({
			finding: makeFinding(),
			diff: "-old\n+new",
		});
		expect(task).toContain("Missing null check");
		expect(task).toContain("src/handler.ts:42");
		expect(task).toContain("code-reviewer");
		expect(task).toContain("-old\n+new");
	});
});

describe("buildFixPrompt", () => {
	it("formats findings as numbered list", () => {
		const prompt = buildFixPrompt([
			makeFinding({ title: "Issue A" }),
			makeFinding({ title: "Issue B", suggestedAction: "Do X" }),
		]);
		expect(prompt).toContain("1. **[IMPORTANT]** Issue A");
		expect(prompt).toContain("2. **[IMPORTANT]** Issue B");
		expect(prompt).toContain("Suggested fix: Do X");
	});
});
