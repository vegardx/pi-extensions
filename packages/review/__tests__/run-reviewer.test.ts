/**
 * Pipeline tests for runReviewer with stubbed stage runners — no
 * subprocesses, no models. Uses a throwaway git repo with a dirty
 * working tree so scope resolution exercises the real git helpers.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OrchestratedFinding, RawFinding } from "../findings.js";
import {
	deriveStageBudgets,
	partitionCuratedFindings,
	type RunReviewerDeps,
	runReviewer,
	shouldSkipCurator,
} from "../run-reviewer.js";
import type { StaticAnalysisResult } from "../static-checker.js";

let repo: string;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "pi-review-test-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "x.ts"), "export const a = 1;\n");
	git("add", ".");
	git("commit", "-qm", "init");
	// Dirty the working tree so scope "auto" resolves to working diff.
	writeFileSync(join(repo, "x.ts"), "export const a = 2;\n");
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

function makeCtx(): ExtensionContext {
	return { cwd: repo, hasUI: false } as ExtensionContext;
}

const NO_STATIC: StaticAnalysisResult = { byLane: new Map(), toolResults: [] };

function rawFinding(over?: Partial<RawFinding>): RawFinding {
	return {
		severity: "IMPORTANT",
		file: "x.ts",
		line: 1,
		title: "something",
		description: "desc",
		...over,
	};
}

function curated(over?: Partial<OrchestratedFinding>): OrchestratedFinding {
	return {
		severity: "IMPORTANT",
		file: "x.ts",
		line: 1,
		title: "something",
		description: "desc",
		confidence: "high",
		confirmedByTiers: [],
		// Still `ReviewerRole`-typed until the lens rename lands in the
		// next commit; the runtime accepts any string.
		confirmedByRoles: ["code-reviewer"],
		staticToolSource: null,
		...over,
	};
}

function makeDeps(over?: Partial<RunReviewerDeps>): {
	deps: Partial<RunReviewerDeps>;
	lensCalls: Array<{ lens: string; task: string; timeoutMs?: number }>;
	curatorCalls: Array<{
		inputs: Array<{ source: string; findings: RawFinding[] }>;
	}>;
} {
	const lensCalls: Array<{ lens: string; task: string; timeoutMs?: number }> =
		[];
	const curatorCalls: Array<{
		inputs: Array<{ source: string; findings: RawFinding[] }>;
	}> = [];
	const deps: Partial<RunReviewerDeps> = {
		runScanners: async () => NO_STATIC,
		runIndexer: async () => ({ tag: "indexer", sketch: null }),
		runLens: async (input) => {
			lensCalls.push({
				lens: input.lens,
				task: input.task,
				timeoutMs: input.timeoutMs,
			});
			return { lens: input.lens, findings: [rawFinding()] };
		},
		runCurator: async (opts) => {
			curatorCalls.push({ inputs: opts.inputs });
			return { findings: [curated({ suggestedAction: "fix it" })], ran: true };
		},
		resolveModel: (async (_ctx: unknown, req: { tier: string }) => ({
			model: { provider: "test", id: `model-${req.tier}` },
		})) as unknown as RunReviewerDeps["resolveModel"],
		...over,
	};
	return { deps, lensCalls, curatorCalls };
}

describe("runReviewer pipeline (stubbed stages)", () => {
	it("fans out all four lenses by default and feeds the curator", async () => {
		const { deps, lensCalls, curatorCalls } = makeDeps();
		const result = await runReviewer({ deps }, makeCtx());
		expect(result.ran).toBe(true);
		expect(lensCalls.map((c) => c.lens).sort()).toEqual([
			"code-review",
			"generic",
			"security",
			"simplification",
		]);
		for (const call of lensCalls) {
			expect(call.task).toContain("```diff");
			expect(call.task).toContain(`Lens: ${call.lens}`);
		}
		expect(curatorCalls).toHaveLength(1);
		expect(curatorCalls[0]?.inputs.map((i) => i.source).sort()).toEqual([
			"code-review",
			"generic",
			"security",
			"simplification",
		]);
		expect(result.findings).toHaveLength(1);
		expect(result.autoApplied).toHaveLength(1);
		expect(result.text).toContain("Review summary");
		expect(result.agentModels.curator).toBe("test/model-heavy");
		expect(result.agentModels.security).toBe("test/model-heavy");
		expect(result.agentModels.generic).toBe("test/model-normal");
	});

	it("honours an explicit lens subset and drops unknown ids", async () => {
		const { deps, lensCalls } = makeDeps();
		const result = await runReviewer(
			{ deps, lenses: ["security", "architect"] },
			makeCtx(),
		);
		expect(result.ran).toBe(true);
		expect(lensCalls.map((c) => c.lens)).toEqual(["security"]);
	});

	it("aborts with no-valid-lenses when every id is unknown", async () => {
		const { deps } = makeDeps();
		const result = await runReviewer(
			{ deps, lenses: ["architect", "doc-reviewer"] },
			makeCtx(),
		);
		expect(result.ran).toBe(false);
		expect(result.abortReason).toBe("no-valid-lenses");
	});

	it("maps static scanner lanes onto lens payloads and the curator input", async () => {
		const staticResult: StaticAnalysisResult = {
			byLane: new Map([
				["security-analyst", [rawFinding({ title: "leaked secret" })]],
			]),
			toolResults: [
				{
					tool: "gitleaks",
					lane: "security-analyst",
					findings: [rawFinding({ title: "leaked secret" })],
					available: true,
					enabled: true,
				},
			],
		};
		const { deps, lensCalls, curatorCalls } = makeDeps({
			runScanners: async () => staticResult,
		});
		const result = await runReviewer({ deps }, makeCtx());
		expect(result.staticToolsRan).toBe(1);
		const securityTask = lensCalls.find((c) => c.lens === "security")?.task;
		expect(securityTask).toContain("Static analysis pre-scan");
		expect(securityTask).toContain("leaked secret");
		const genericTask = lensCalls.find((c) => c.lens === "generic")?.task;
		expect(genericTask).not.toContain("Static analysis pre-scan");
		const staticBundle = curatorCalls[0]?.inputs.find(
			(i) => i.source === "scanners",
		);
		expect(staticBundle?.findings[0]?.title).toBe("leaked secret");
	});

	it("skips the curator when no lens found anything and errors are low", async () => {
		const { deps, curatorCalls } = makeDeps({
			runLens: async (input) => ({ lens: input.lens, findings: [] }),
		});
		const result = await runReviewer({ deps }, makeCtx());
		expect(result.ran).toBe(true);
		expect(curatorCalls).toHaveLength(0);
		expect(result.curatorRan).toBe(false);
		expect(result.findings).toEqual([]);
		expect(result.text).toContain("Curator**: skipped");
	});

	it("collects lens errors and still curates the rest", async () => {
		const { deps, curatorCalls } = makeDeps({
			runLens: async (input) =>
				input.lens === "security"
					? { lens: input.lens, findings: [], error: "boom" }
					: { lens: input.lens, findings: [rawFinding()] },
		});
		const result = await runReviewer({ deps }, makeCtx());
		expect(result.errors).toEqual([{ lens: "security", error: "boom" }]);
		expect(curatorCalls).toHaveLength(1);
		expect(result.text).toContain("Lens errors**: 1");
	});

	it("writes the full report artifact into artifactDir", async () => {
		const { deps } = makeDeps();
		const artifactDir = join(repo, "artifacts");
		const result = await runReviewer({ deps, artifactDir }, makeCtx());
		expect(result.artifactPath).toBeDefined();
		expect(result.artifactPath).toContain(artifactDir);
		const { readFileSync } = await import("node:fs");
		const report = readFileSync(result.artifactPath as string, "utf8");
		expect(report).toContain("## All findings");
		expect(report).toContain("## Agent models");
	});

	it("derives lens budgets from the overall timeout", async () => {
		const { deps, lensCalls } = makeDeps();
		await runReviewer({ deps, timeoutMs: 100_000 }, makeCtx());
		expect(lensCalls[0]?.timeoutMs).toBe(45_000);
	});

	it("aborts when the curator model cannot resolve", async () => {
		const { deps } = makeDeps({
			resolveModel: (async () =>
				null) as unknown as RunReviewerDeps["resolveModel"],
		});
		const result = await runReviewer({ deps }, makeCtx());
		expect(result.ran).toBe(false);
		expect(result.abortReason).toBe("no-curator-model");
	});
});

describe("pure helpers", () => {
	it("shouldSkipCurator: skip only on zero findings with low error rate", () => {
		expect(shouldSkipCurator(0, 0)).toBe(true);
		expect(shouldSkipCurator(0, 0.5)).toBe(false);
		expect(shouldSkipCurator(3, 0)).toBe(false);
	});

	it("partitionCuratedFindings splits by confidence and fix presence", () => {
		const auto = curated({ suggestedAction: "fix" });
		const discussNoFix = curated({ suggestedAction: undefined });
		const discussMediumFix = curated({
			confidence: "medium",
			suggestedAction: "fix",
		});
		const lowCritical = curated({
			confidence: "low",
			severity: "CRITICAL",
		});
		const dropped = curated({ confidence: "low" });
		const { autoApplied, surfaced } = partitionCuratedFindings([
			auto,
			discussNoFix,
			discussMediumFix,
			lowCritical,
			dropped,
		]);
		expect(autoApplied).toEqual([auto]);
		expect(surfaced).toEqual([discussNoFix, discussMediumFix, lowCritical]);
	});

	it("deriveStageBudgets clamps to the diff heuristic without an overall cap", () => {
		const b = deriveStageBudgets(1000);
		expect(b.lensMs).toBe(120_000);
		expect(b.curatorMs).toBe(240_000);
		const capped = deriveStageBudgets(1000, 100_000);
		expect(capped.indexerMs).toBe(10_000);
		expect(capped.lensMs).toBe(45_000);
		expect(capped.curatorMs).toBe(40_000);
	});
});
