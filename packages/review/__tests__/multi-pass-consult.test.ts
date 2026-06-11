/**
 * Multi-model / multi-pass lens fan-out and the consult stage:
 * config normalisation, pass-2 digest delivery, fingerprint dedupe,
 * and confidence adjustment.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import {
	consultCandidates,
	parseConsultVerdict,
	runConsult,
} from "../consult.js";
import {
	digestFindings,
	findingFingerprint,
	mergeLensFindings,
	type OrchestratedFinding,
	type RawFinding,
} from "../findings.js";
import { consultEnabled, resolveLensSpec } from "../models.js";
import { type RunReviewerDeps, runReviewer } from "../run-reviewer.js";

function raw(over?: Partial<RawFinding>): RawFinding {
	return {
		severity: "IMPORTANT",
		file: "x.ts",
		line: 1,
		title: "an issue",
		description: "desc",
		...over,
	};
}

function curated(over?: Partial<OrchestratedFinding>): OrchestratedFinding {
	return {
		...raw(),
		confidence: "medium",
		confirmedByTiers: [],
		confirmedByRoles: ["code-review"],
		staticToolSource: null,
		...over,
	};
}

describe("resolveLensSpec", () => {
	function settings(review?: unknown): RelevantSettings {
		return { extensionConfig: review ? { review } : {} } as RelevantSettings;
	}

	it("defaults to single model, single pass", () => {
		const spec = resolveLensSpec(settings(), "security");
		expect(spec.passes).toBe(1);
		expect(spec.models).toEqual([{ set: "secondary", tier: "heavy" }]);
	});

	it("bare {set,tier} normalises to one model, one pass", () => {
		const spec = resolveLensSpec(
			settings({ models: { security: { set: "primary", tier: "heavy" } } }),
			"security",
		);
		expect(spec).toEqual({
			models: [{ set: "primary", tier: "heavy" }],
			passes: 1,
		});
	});

	it("full {models[], passes} is honoured; invalid entries dropped", () => {
		const spec = resolveLensSpec(
			settings({
				models: {
					security: {
						models: [
							{ set: "secondary", tier: "heavy" },
							{ set: "primary", tier: "heavy" },
							{ set: "tertiary", tier: "huge" },
						],
						passes: 2,
					},
				},
			}),
			"security",
		);
		expect(spec.models).toHaveLength(2);
		expect(spec.passes).toBe(2);
	});

	it("consultEnabled reads review.consult.enabled", () => {
		expect(consultEnabled(settings())).toBe(false);
		expect(consultEnabled(settings({ consult: { enabled: true } }))).toBe(true);
	});
});

describe("mergeLensFindings / digestFindings", () => {
	it("dedupes by file/line/title fingerprint, promoting severity", () => {
		const merged = mergeLensFindings([
			[raw(), raw({ title: "other issue" })],
			[raw({ severity: "CRITICAL", description: "longer description!" })],
		]);
		expect(merged).toHaveLength(2);
		const dup = merged.find((f) => f.title === "an issue");
		expect(dup?.severity).toBe("CRITICAL");
		expect(dup?.description).toBe("longer description!");
	});

	it("fingerprints normalise title case and missing lines", () => {
		expect(findingFingerprint(raw({ line: undefined }))).toBe(
			findingFingerprint(raw({ line: undefined, title: "AN ISSUE" })),
		);
	});

	it("digest renders one bullet per finding", () => {
		const digest = digestFindings([raw(), raw({ title: "b", line: 9 })]);
		expect(digest).toContain("- [IMPORTANT] x.ts:1 — an issue");
		expect(digest).toContain("- [IMPORTANT] x.ts:9 — b");
		expect(digestFindings([])).toBe("(no findings so far)");
	});
});

describe("consult", () => {
	it("parseConsultVerdict tolerates prose-wrapped JSON", () => {
		expect(parseConsultVerdict('{"agree": true, "reason": "checked"}')).toEqual(
			{ agree: true, reason: "checked" },
		);
		expect(parseConsultVerdict("not json")).toBeNull();
	});

	it("candidates are non-high CRITICAL/IMPORTANT only, capped", () => {
		const list = [
			curated({ confidence: "high" }),
			curated({ severity: "NOTE" }),
			curated({ severity: "CRITICAL", confidence: "low" }),
			...Array.from({ length: 9 }, (_, i) =>
				curated({ title: `c${i}`, confidence: "medium" }),
			),
		];
		const out = consultCandidates(list);
		expect(out).toHaveLength(5);
		expect(out[0]?.severity).toBe("CRITICAL");
	});

	it("agree bumps confidence and fills a missing fix; disagree drops to low", async () => {
		const findings = [
			curated({ title: "agreed", confidence: "medium" }),
			curated({ title: "denied", confidence: "medium" }),
			curated({ title: "untouched", confidence: "high" }),
		];
		const result = await runConsult({
			provider: "p",
			model: "m",
			findings,
			diff: "",
			scopeLabel: "s",
			cwd: "/tmp",
			consultOne: async (f) =>
				f.title === "agreed"
					? { agree: true, reason: "real", suggestedAction: "fix it" }
					: { agree: false, reason: "not real" },
		});
		const byTitle = new Map(result.findings.map((f) => [f.title, f]));
		expect(byTitle.get("agreed")?.confidence).toBe("high");
		expect(byTitle.get("agreed")?.suggestedAction).toBe("fix it");
		expect(byTitle.get("denied")?.confidence).toBe("low");
		expect(byTitle.get("untouched")?.confidence).toBe("high");
		expect(result.consulted).toBe(2);
	});
});

describe("runReviewer multi-pass integration (stubbed)", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "pi-review-mp-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		git("config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "x.ts"), "export const a = 1;\n");
		git("add", ".");
		git("commit", "-qm", "init");
		writeFileSync(join(repo, "x.ts"), "export const a = 2;\n");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	function makeCtx(): ExtensionContext {
		return { cwd: repo, hasUI: false } as ExtensionContext;
	}

	function settingsFixture(review: unknown): void {
		mkdirSync(join(repo, ".pi"), { recursive: true });
		writeFileSync(
			join(repo, ".pi", "settings.json"),
			JSON.stringify({ extensionConfig: { review } }),
		);
	}

	it("passes=2 runs the lens twice with a digest on pass 2 and dedupes", async () => {
		const lensCalls: Array<{ model: string; task: string }> = [];
		const deps: Partial<RunReviewerDeps> = {
			runScanners: async () => ({ byLane: new Map(), toolResults: [] }),
			runIndexer: async () => ({ tag: "indexer", sketch: null }),
			runLens: async (input) => {
				lensCalls.push({ model: input.model, task: input.task });
				return { lens: input.lens, findings: [raw()] };
			},
			runCurator: async (opts) => ({
				// Curator sees the deduped lens bundle: one finding despite
				// two models × two passes all reporting it.
				findings: opts.inputs
					.flatMap((i) => i.findings)
					.map((f) => curated({ title: f.title, confidence: "high" })),
				ran: true,
			}),
			resolveModel: (async (
				_ctx: unknown,
				req: { tier: string; set: string },
			) => ({
				model: { provider: "test", id: `${req.set}-${req.tier}` },
			})) as unknown as RunReviewerDeps["resolveModel"],
		};
		const result = await runReviewer(
			{
				deps,
				lenses: ["security"],
				models: [
					{ set: "secondary", tier: "heavy" },
					{ set: "primary", tier: "heavy" },
				],
				passes: 2,
			},
			makeCtx(),
		);
		expect(result.ran).toBe(true);
		// 2 models × 2 passes.
		expect(lensCalls).toHaveLength(4);
		const pass2 = lensCalls.slice(2);
		for (const call of pass2) {
			expect(call.task).toContain("Prior passes already found");
			expect(call.task).toContain("an issue");
			expect(call.task).toContain("DIFFERENT");
		}
		// Deduped to one finding before the curator.
		expect(result.findings).toHaveLength(1);
	});

	it("identical resolved models collapse to one run", async () => {
		const lensCalls: string[] = [];
		const deps: Partial<RunReviewerDeps> = {
			runScanners: async () => ({ byLane: new Map(), toolResults: [] }),
			runIndexer: async () => ({ tag: "indexer", sketch: null }),
			runLens: async (input) => {
				lensCalls.push(input.model);
				return { lens: input.lens, findings: [] };
			},
			runCurator: async () => ({ findings: [], ran: true }),
			// Both sets resolve to the same model (secondary falls back).
			resolveModel: (async (_ctx: unknown, req: { tier: string }) => ({
				model: { provider: "test", id: `same-${req.tier}` },
			})) as unknown as RunReviewerDeps["resolveModel"],
		};
		const result = await runReviewer(
			{
				deps,
				lenses: ["generic"],
				models: [
					{ set: "secondary", tier: "normal" },
					{ set: "primary", tier: "normal" },
				],
			},
			makeCtx(),
		);
		expect(result.ran).toBe(true);
		expect(lensCalls).toHaveLength(1);
	});

	it("consult stage adjusts confidence when enabled", async () => {
		settingsFixture({ consult: { enabled: true } });
		const deps: Partial<RunReviewerDeps> = {
			runScanners: async () => ({ byLane: new Map(), toolResults: [] }),
			runIndexer: async () => ({ tag: "indexer", sketch: null }),
			runLens: async (input) => ({ lens: input.lens, findings: [raw()] }),
			runCurator: async () => ({
				findings: [curated({ confidence: "medium" })],
				ran: true,
			}),
			runConsult: async (opts) => ({
				findings: opts.findings.map((f) => ({
					...f,
					confidence: "high" as const,
				})),
				consulted: 1,
				errors: 0,
			}),
			resolveModel: (async (_ctx: unknown, req: { set: string }) => ({
				model: { provider: "test", id: `m-${req.set}` },
			})) as unknown as RunReviewerDeps["resolveModel"],
		};
		const result = await runReviewer({ deps, lenses: ["generic"] }, makeCtx());
		expect(result.consult).toEqual({ consulted: 1, errors: 0 });
		expect(result.findings[0]?.confidence).toBe("high");
		expect(result.agentModels.consult).toBe("test/m-primary");
	});
});
