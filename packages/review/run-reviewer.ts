/**
 * The review pipeline behind the `reviewer` delegate target.
 *
 * Stages:
 *   0   — Scanners (tsc, biome, npm audit, …) run before any AI agent.
 *         Findings are injected into the matching lens's task payload
 *         as pre-computed evidence and into the curator's input.
 *   0.5 — Indexer builds a structured sketch of the diff that is
 *         threaded into every lens's task payload. Best-effort.
 *   1   — Lens fan-out: the configured lenses run in parallel, each at
 *         its per-agent resolved model.
 *   2   — Curator synthesises all raw findings: fuzzy dedupe,
 *         cross-validation with read-only code access, confidence.
 *   3   — Confidence split: high+fix → autoApplied; high/medium
 *         without fix or low CRITICAL → surfaced; the rest drop.
 *
 * Returns a text summary (what crosses back through the delegate
 * tool) plus the structured findings in the result for TS-side
 * consumers (commit's review walk, modes' picker, worker loops). The
 * full report is written as an artifact under
 * `<agentDir>/review/` so large reviews never blow up the caller's
 * context.
 *
 * Timeout layering: when the caller passes `timeoutMs` (the delegate
 * tool's hard cap), per-stage budgets are derived from it; otherwise
 * each stage falls back to the diff-proportional heuristic in
 * `lens-client.ts`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionContext,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import { acquireKeepAwake } from "@vegardx/pi-extensions-shared/caffeinate.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runConsult } from "./consult.js";
import {
	type CuratorInput,
	type CuratorResult,
	type RunCuratorOpts,
	runCurator,
} from "./curator.js";
import {
	digestFindings,
	mergeLensFindings,
	type OrchestratedFinding,
	type RawFinding,
} from "./findings.js";
import {
	detectDefaultBranch,
	diffStat,
	filesInDiff,
	getBranchDiff,
	getWorkingDiff,
	isGitRepo,
} from "./git.js";
import {
	buildIndexerTask,
	type IndexerInvocation,
	type IndexerOutcome,
	type IndexSketch,
	renderIndexSketchForReviewer,
	runIndexer,
} from "./indexer.js";
import {
	type LensInvocation,
	type LensOutcome,
	reviewTimeoutMs,
	runLens,
} from "./lens-client.js";
import {
	type AgentModelSpec,
	ALL_LENSES,
	consultEnabled,
	isLensId,
	type LensId,
	type LensSpec,
	resolveAllAgentModels,
	resolveLensSpec,
} from "./models.js";
import {
	runStaticAnalysisFromSettings,
	type StaticAnalysisResult,
	type StaticToolLane,
} from "./static-checker.js";

export const REVIEW_WIDGET = "review-progress";

/** Static-tool lanes feed the matching deep lens's task payload. */
const STATIC_LANE_TO_LENS: Record<StaticToolLane, LensId> = {
	"code-reviewer": "code-review",
	"security-analyst": "security",
	"code-simplifier": "simplification",
};

export type ReviewScope = "auto" | "branch" | "working";

export interface ReviewScopeContext {
	scopeMode: "branch" | "working";
	scopeLabel: string;
	diff: string;
	files: string[];
	changedFiles: number;
	additions: number;
	deletions: number;
}

export interface RunReviewerOptions {
	/** Lenses to run; unknown ids are dropped with a warning. Default: all four. */
	lenses?: string[];
	/**
	 * Diff scope. "auto" (default) prefers the branch diff against the
	 * default branch and falls back to the working tree; "branch" /
	 * "working" force one and fail when it's empty.
	 */
	scope?: ReviewScope;
	/** Directory for the full report artifact. Default: `<agentDir>/review`. */
	artifactDir?: string;
	/**
	 * Overall budget (the delegate tool's hard cap). Per-stage budgets
	 * derive from it; unset means diff-proportional heuristics.
	 */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Extension name for model-resolver overrides. Default "review". */
	extensionName?: string;
	/**
	 * Per-call lens fan-out overrides (the delegate target passes these
	 * through): `models` replaces every selected lens's model list,
	 * `passes` its pass count. Settings (`review.models.<lens>`) apply
	 * when unset.
	 */
	models?: AgentModelSpec[];
	passes?: number;
	/** Test seam — replace the stage runners without subprocesses. */
	deps?: Partial<RunReviewerDeps>;
}

export interface RunReviewerDeps {
	runScanners(
		cwd: string,
		settings: ReturnType<typeof readRelevantSettings>,
	): Promise<StaticAnalysisResult>;
	runIndexer(input: IndexerInvocation): Promise<IndexerOutcome>;
	runLens(input: LensInvocation): Promise<LensOutcome>;
	runCurator(opts: RunCuratorOpts): Promise<CuratorResult>;
	runConsult: typeof runConsult;
	resolveModel: typeof resolveModel;
}

export type RunReviewerAbortReason =
	| "not-git"
	| "no-diff"
	| "no-valid-lenses"
	| "no-curator-model"
	| "no-lens-models";

export interface RunReviewerResult {
	ran: boolean;
	abortReason?: RunReviewerAbortReason;
	scopeLabel?: string;
	/** All findings as curated. */
	findings: OrchestratedFinding[];
	/** high-confidence + concrete fix. */
	autoApplied: OrchestratedFinding[];
	/** High/medium without fix, medium with fix, or low CRITICAL. */
	surfaced: OrchestratedFinding[];
	/** Per-lens errors (the affected lens was treated as empty). */
	errors: Array<{ lens: LensId; error: string }>;
	/** Human-readable summary — what the delegate tool returns. */
	text: string;
	/** Full report markdown on disk; undefined when the run aborted early. */
	artifactPath?: string;
	/** True when the curator ran and produced parseable output. */
	curatorRan: boolean;
	curatorError?: string;
	/** `provider/id` per agent that actually ran. */
	agentModels: Record<string, string>;
	staticToolsRan: number;
	indexError?: string;
	/** Consult stage stats (present when review.consult.enabled). */
	consult?: { consulted: number; errors: number };
}

function notify(
	ctx: ExtensionContext,
	msg: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(`review: ${msg}`, level);
}

/**
 * Resolve the diff scope. "auto" prefers the branch diff and falls
 * back to the working tree (covers being on the default branch with
 * uncommitted edits); explicit modes fail when their diff is empty.
 */
export function resolveReviewScope(
	cwd: string,
	scope: ReviewScope,
): ReviewScopeContext | { error: string } {
	const defaultBranch = detectDefaultBranch(cwd);
	if (scope !== "working" && defaultBranch) {
		const diff = getBranchDiff(cwd, defaultBranch);
		if (diff.trim()) {
			const stat = diffStat(cwd, `${defaultBranch}...HEAD`);
			return {
				scopeMode: "branch",
				scopeLabel: `current branch vs. ${defaultBranch}`,
				diff,
				files: filesInDiff(diff),
				changedFiles: stat.changedFiles,
				additions: stat.additions,
				deletions: stat.deletions,
			};
		}
		if (scope === "branch") {
			return { error: `branch diff vs. ${defaultBranch} is empty` };
		}
	}
	if (scope === "branch") {
		return { error: "no default branch detected for a branch-scope review" };
	}
	const workingDiff = getWorkingDiff(cwd);
	if (!workingDiff.trim()) {
		return {
			error:
				"no diff to review (branch matches default and working tree is clean)",
		};
	}
	const stat = diffStat(cwd);
	return {
		scopeMode: "working",
		scopeLabel: "working tree (unstaged + staged)",
		diff: workingDiff,
		files: filesInDiff(workingDiff),
		changedFiles: stat.changedFiles,
		additions: stat.additions,
		deletions: stat.deletions,
	};
}

/**
 * Build a single lens's task payload — diff, file list, optional
 * index sketch, and the lens's static-scan evidence.
 */
export function buildLensTask(
	lens: LensId,
	rc: ReviewScopeContext,
	indexSketch: IndexSketch | null,
	staticFindings?: readonly RawFinding[],
): string {
	const lines: string[] = [
		`Lens: ${lens}`,
		`Scope: ${rc.scopeLabel}. ${rc.changedFiles} changed files, ` +
			`+${rc.additions} / -${rc.deletions}.`,
		"",
		"Files in scope:",
		...rc.files.slice(0, 200).map((f) => `- ${f}`),
	];
	if (rc.files.length > 200) {
		lines.push(
			`… and ${rc.files.length - 200} more (read via tools as needed).`,
		);
	}
	lines.push("");
	lines.push("Scope: diff. Review only the lines the diff touches.");
	lines.push("");
	lines.push("Unified diff:");
	lines.push("```diff");
	lines.push(rc.diff.trimEnd());
	lines.push("```");
	lines.push("");
	lines.push(
		"If nothing in this diff falls within your lane, reply `[]` and stop.",
		"Otherwise, emit JSON per your system prompt.",
	);
	const sketchSection = renderIndexSketchForReviewer(indexSketch);
	if (sketchSection) {
		lines.push("", sketchSection);
	}
	if (staticFindings && staticFindings.length > 0) {
		lines.push(
			"",
			"## Static analysis pre-scan",
			"",
			"The following findings were produced by deterministic CLI tools",
			"(tsc, biome, npm audit, etc.) before you started. They are",
			"provided as additional evidence for your lane. Reference them",
			"in your `description` when they support a finding you'd flag",
			"anyway; you do not need to re-emit them verbatim.",
			"",
			"```json",
			JSON.stringify(staticFindings, null, 2),
			"```",
		);
	}
	return lines.join("\n");
}

/**
 * Should the curator be skipped when there are 0 input findings?
 * Skip when enough lenses ran successfully and genuinely found
 * nothing; run anyway when the error rate makes "0 findings"
 * untrustworthy.
 */
export function shouldSkipCurator(
	totalInputFindings: number,
	lensErrorRate: number,
): boolean {
	if (totalInputFindings > 0) return false;
	return lensErrorRate < 1 / 3;
}

/**
 * Partition curated findings into auto-apply and needs-discussion
 * buckets based on confidence and fix availability. Low-confidence
 * CRITICALs are surfaced (never silently dropped); low-confidence
 * IMPORTANT/NOTE findings drop.
 */
export function partitionCuratedFindings(
	findings: readonly OrchestratedFinding[],
): {
	autoApplied: OrchestratedFinding[];
	surfaced: OrchestratedFinding[];
} {
	const withFix = (f: OrchestratedFinding) =>
		f.suggestedAction !== undefined && f.suggestedAction.trim() !== "";
	const isHighOrMedium = (f: OrchestratedFinding) =>
		f.confidence === "high" || f.confidence === "medium";

	const autoApplied = findings.filter(
		(f) => f.confidence === "high" && withFix(f),
	);
	const surfaced = findings.filter((f) => {
		if (autoApplied.includes(f)) return false;
		if (isHighOrMedium(f) && !withFix(f)) return true;
		if (f.confidence === "medium" && withFix(f)) return true;
		if (f.confidence === "low" && f.severity === "CRITICAL") return true;
		return false;
	});
	return { autoApplied, surfaced };
}

interface StageBudgets {
	indexerMs: number;
	lensMs: number;
	curatorMs: number;
}

/**
 * Derive per-stage budgets. With an overall cap: 10% indexer, 45%
 * lenses, 40% curator (lenses run in parallel, so the lens budget is
 * per lens, not summed). Each stage still never exceeds its
 * diff-proportional heuristic.
 */
export function deriveStageBudgets(
	diffChars: number,
	overallMs?: number,
): StageBudgets {
	const heuristic = reviewTimeoutMs(diffChars);
	if (!overallMs || !Number.isFinite(overallMs) || overallMs <= 0) {
		return {
			indexerMs: heuristic,
			lensMs: heuristic,
			curatorMs: Math.min(heuristic * 2, 600_000),
		};
	}
	return {
		indexerMs: Math.min(heuristic, Math.floor(overallMs * 0.1)),
		lensMs: Math.min(heuristic, Math.floor(overallMs * 0.45)),
		curatorMs: Math.min(heuristic * 2, Math.floor(overallMs * 0.4)),
	};
}

function renderProgress(
	status: ReadonlyMap<string, "running" | "done">,
): string[] {
	const lines: string[] = [];
	const total = status.size;
	let done = 0;
	for (const v of status.values()) if (v === "done") done++;
	lines.push(`🔍 review (${done}/${total} lenses done)`);
	for (const [lens, s] of status) {
		const glyph = s === "done" ? "✓" : "⏳";
		lines.push(`  ${glyph} ${lens}`);
	}
	return lines;
}

function buildSummaryText(opts: {
	scopeLabel: string;
	lenses: readonly LensId[];
	agentModels: Record<string, string>;
	findings: readonly OrchestratedFinding[];
	autoApplied: readonly OrchestratedFinding[];
	surfaced: readonly OrchestratedFinding[];
	curatorRan: boolean;
	curatorError?: string;
	staticToolsRan: number;
	errors: ReadonlyArray<{ lens: LensId; error: string }>;
	artifactPath?: string;
	diffSize: number;
}): string {
	const lines: string[] = [];
	lines.push("## Review summary");
	lines.push("");
	lines.push(`**Scope**: ${opts.scopeLabel}`);
	lines.push(`**Lenses**: ${opts.lenses.join(", ")}`);
	if (opts.staticToolsRan > 0) {
		lines.push(`**Static analysis**: ${opts.staticToolsRan} tool(s) ran`);
	}
	const dropped =
		opts.findings.length - opts.autoApplied.length - opts.surfaced.length;
	lines.push(
		`**Findings**: ${opts.findings.length} total · ${opts.autoApplied.length} with high-confidence fixes · ${opts.surfaced.length} for discussion · ${dropped} low-confidence (dropped)`,
	);
	const firstLine = (s: string) => s.split("\n")[0].slice(0, 120);
	if (!opts.curatorRan) {
		lines.push(
			opts.curatorError
				? `**Curator**: failed — ${firstLine(opts.curatorError)}`
				: "**Curator**: skipped (no input findings from lenses or scanners)",
		);
	}
	if (opts.errors.length > 0) {
		lines.push(
			`**Lens errors**: ${opts.errors.length} (the affected lens was treated as empty)`,
		);
		for (const e of opts.errors) {
			lines.push(`  - \`${e.lens}\`: ${firstLine(e.error)}`);
		}
	}
	const renderFinding = (f: OrchestratedFinding, idx: number) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		const conf = f.confidence === "low" ? " ⚠️ low confidence" : "";
		const staticTag = f.staticToolSource ? ` [${f.staticToolSource}]` : "";
		return `${idx + 1}. [${f.severity}] \`${loc}\` — ${f.title} (${f.confirmedByRoles.join(", ") || "curator"})${conf}${staticTag}`;
	};
	if (opts.autoApplied.length > 0) {
		lines.push("", "### High-confidence fixes:", "");
		opts.autoApplied.forEach((f, i) => {
			lines.push(renderFinding(f, i));
		});
	}
	if (opts.surfaced.length > 0) {
		lines.push("", "### Needs discussion:", "");
		opts.surfaced.forEach((f, i) => {
			lines.push(renderFinding(f, i));
			if (f.orchestratorNote) lines.push(`   → ${f.orchestratorNote}`);
		});
	}
	if (opts.autoApplied.length === 0 && opts.surfaced.length === 0) {
		lines.push("");
		const successfulLenses = opts.lenses.length - opts.errors.length;
		if (
			successfulLenses > 0 &&
			opts.findings.length === 0 &&
			opts.diffSize > 50 &&
			!opts.curatorError
		) {
			lines.push(
				"⚠️ All lenses found nothing on a non-trivial diff — consider",
				"re-running to rule out systemic subagent failures.",
				"",
			);
		}
		lines.push("No actionable findings after curation.");
	}
	if (opts.artifactPath) {
		lines.push("", `Full report: ${opts.artifactPath}`);
	}
	return lines.join("\n");
}

function buildArtifact(opts: {
	scopeLabel: string;
	lenses: readonly LensId[];
	agentModels: Record<string, string>;
	findings: readonly OrchestratedFinding[];
	autoApplied: readonly OrchestratedFinding[];
	surfaced: readonly OrchestratedFinding[];
	errors: ReadonlyArray<{ lens: LensId; error: string }>;
	summary: string;
}): string {
	const lines: string[] = [opts.summary, "", "---", "", "## All findings", ""];
	if (opts.findings.length === 0) {
		lines.push("(none)");
	}
	opts.findings.forEach((f, idx) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		lines.push(
			`### [${idx + 1}/${opts.findings.length}] ${f.severity} — ${f.title}`,
			"",
			`**Location**: \`${loc}\``,
			`**Confidence**: ${f.confidence}`,
			`**Lenses**: ${f.confirmedByRoles.join(", ") || "curator"}`,
			...(f.staticToolSource ? [`**Static tool**: ${f.staticToolSource}`] : []),
			"",
			f.description,
			"",
			...(f.suggestedAction
				? [`**Suggested fix**: ${f.suggestedAction}`, ""]
				: []),
			...(f.orchestratorNote
				? [`**Curator note**: ${f.orchestratorNote}`, ""]
				: []),
		);
	});
	lines.push("## Agent models", "");
	for (const [agent, spec] of Object.entries(opts.agentModels)) {
		lines.push(`- ${agent}: \`${spec}\``);
	}
	return lines.join("\n");
}

const DEFAULT_DEPS: RunReviewerDeps = {
	runScanners: (cwd, settings) => runStaticAnalysisFromSettings(cwd, settings),
	runIndexer,
	runLens,
	runCurator,
	runConsult,
	resolveModel,
};

/**
 * Run the full review pipeline. Pure-ish orchestration: all stage
 * runners are injectable via `opts.deps` for tests.
 */
export async function runReviewer(
	opts: RunReviewerOptions,
	ctx: ExtensionContext,
): Promise<RunReviewerResult> {
	const deps: RunReviewerDeps = { ...DEFAULT_DEPS, ...opts.deps };
	const extensionName = opts.extensionName ?? "review";

	const empty = (
		abortReason: RunReviewerAbortReason,
		text: string,
		scopeLabel?: string,
	): RunReviewerResult => ({
		ran: false,
		abortReason,
		scopeLabel,
		findings: [],
		autoApplied: [],
		surfaced: [],
		errors: [],
		text,
		curatorRan: false,
		agentModels: {},
		staticToolsRan: 0,
	});

	if (!isGitRepo(ctx.cwd)) {
		return empty("not-git", "[review] not inside a git repository");
	}

	const rc = resolveReviewScope(ctx.cwd, opts.scope ?? "auto");
	if ("error" in rc) {
		return empty("no-diff", `[review] ${rc.error}`);
	}

	const rawLenses = opts.lenses?.length ? opts.lenses : [...ALL_LENSES];
	const lenses: LensId[] = [];
	for (const l of rawLenses) {
		if (isLensId(l)) {
			lenses.push(l);
		} else {
			notify(ctx, `unknown lens "${l}" — skipping`, "warning");
		}
	}
	if (lenses.length === 0) {
		return empty(
			"no-valid-lenses",
			`[review] no valid lenses among: ${rawLenses.join(", ")}`,
			rc.scopeLabel,
		);
	}

	const settings = readRelevantSettings(ctx.cwd);
	const agentSpecs = resolveAllAgentModels(settings);
	const agentModels: Record<string, string> = {};

	const resolveAgent = async (id: string, spec: AgentModelSpec) => {
		const resolved = await deps.resolveModel(ctx, {
			name: extensionName,
			tier: spec.tier,
			set: spec.set,
		});
		if (!resolved) return null;
		agentModels[id] = `${resolved.model.provider}/${resolved.model.id}`;
		return resolved.model;
	};

	const curatorModel = await resolveAgent("curator", agentSpecs.curator);
	if (!curatorModel) {
		return empty(
			"no-curator-model",
			`[review] no usable curator model (${agentSpecs.curator.set}.${agentSpecs.curator.tier})`,
			rc.scopeLabel,
		);
	}

	// Per-lens fan-out spec: settings-resolved, with per-call overrides
	// from the delegate params winning.
	const lensSpecs = new Map<LensId, LensSpec>();
	for (const lens of lenses) {
		const base = resolveLensSpec(settings, lens);
		lensSpecs.set(lens, {
			models: opts.models?.length ? opts.models : base.models,
			passes:
				opts.passes && Number.isFinite(opts.passes) && opts.passes >= 1
					? Math.floor(opts.passes)
					: base.passes,
		});
	}

	const lensModels = new Map<LensId, Array<{ provider: string; id: string }>>();
	for (const lens of lenses) {
		const spec = lensSpecs.get(lens);
		if (!spec) continue;
		const resolvedModels: Array<{ provider: string; id: string }> = [];
		for (const [i, modelSpec] of spec.models.entries()) {
			const label = spec.models.length > 1 ? `${lens}#${i + 1}` : lens;
			const model = await resolveAgent(label, modelSpec);
			if (model) {
				resolvedModels.push({ provider: model.provider, id: model.id });
			}
		}
		// Dedupe models that resolved identically (e.g. secondary falls
		// back to primary) — a second identical run adds cost, not signal.
		const seen = new Set<string>();
		const unique = resolvedModels.filter((m) => {
			const key = `${m.provider}/${m.id}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		if (unique.length === 0) {
			notify(ctx, `no usable model for ${lens} — skipping`, "warning");
			continue;
		}
		lensModels.set(lens, unique);
	}
	if (lensModels.size === 0) {
		return empty(
			"no-lens-models",
			"[review] no lens resolved to a usable model",
			rc.scopeLabel,
		);
	}

	const budgets = deriveStageBudgets(rc.diff.length, opts.timeoutMs);
	const keepAwake = acquireKeepAwake("review", ctx);

	try {
		// ---- Stage 0: scanners --------------------------------------------
		const staticFindings = await deps.runScanners(ctx.cwd, settings);
		const staticToolsRan = staticFindings.toolResults.filter(
			(r) => r.available && r.enabled,
		).length;

		// ---- Stage 0.5: indexer -------------------------------------------
		let indexSketch: IndexSketch | null = null;
		let indexError: string | undefined;
		const indexerModel = await resolveAgent("indexer", agentSpecs.indexer);
		if (indexerModel) {
			const out = await deps.runIndexer({
				task: buildIndexerTask(rc),
				provider: indexerModel.provider,
				model: indexerModel.id,
				cwd: ctx.cwd,
				signal: opts.signal,
				timeoutMs: budgets.indexerMs,
			});
			if (out.error) {
				indexError = out.error;
				notify(
					ctx,
					`indexer failed: ${out.error.split("\n")[0]} — lenses continue without index`,
					"warning",
				);
			} else {
				indexSketch = out.sketch;
			}
		}

		// ---- Stage 1: lens fan-out ----------------------------------------
		const activeLenses = [...lensModels.keys()];
		const status = new Map<string, "running" | "done">(
			activeLenses.map((l) => [l, "running"] as const),
		);
		if (ctx.hasUI) {
			ctx.ui.setStatus(extensionName, `review 0/${activeLenses.length}`);
			ctx.ui.setWidget(REVIEW_WIDGET, renderProgress(status));
		}
		let completed = 0;
		const lensFor = (lane: StaticToolLane): LensId => STATIC_LANE_TO_LENS[lane];
		const staticByLens = new Map<LensId, RawFinding[]>();
		for (const [lane, findings] of staticFindings.byLane) {
			const lens = lensFor(lane);
			staticByLens.set(lens, [...(staticByLens.get(lens) ?? []), ...findings]);
		}
		const outcomes = await Promise.all(
			activeLenses.map(async (lens) => {
				const models = lensModels.get(lens);
				const spec = lensSpecs.get(lens);
				if (!models || !spec) {
					throw new Error("unreachable: lens without models");
				}
				const baseTask = buildLensTask(
					lens,
					rc,
					indexSketch,
					staticByLens.get(lens),
				);
				// Pass 1: every model in parallel. Passes 2..N: sequential,
				// each seeded with a digest of everything found so far and an
				// instruction to hunt for DIFFERENT issues.
				const collected: RawFinding[][] = [];
				const lensErrors: string[] = [];
				for (let pass = 1; pass <= spec.passes; pass++) {
					const task =
						pass === 1
							? baseTask
							: [
									baseTask,
									"",
									"## Prior passes already found",
									"",
									digestFindings(mergeLensFindings(collected)),
									"",
									"Do NOT re-report the issues above. Hunt for DIFFERENT",
									"issues this pass; reply `[]` if nothing new exists.",
								].join("\n");
					const passResults = await Promise.all(
						models.map((model) =>
							deps.runLens({
								lens,
								task,
								provider: model.provider,
								model: model.id,
								cwd: ctx.cwd,
								signal: opts.signal,
								timeoutMs: budgets.lensMs,
							}),
						),
					);
					for (const r of passResults) {
						if (r.error) lensErrors.push(r.error);
						else collected.push(r.findings);
					}
				}
				completed++;
				status.set(lens, "done");
				if (ctx.hasUI) {
					ctx.ui.setStatus(
						extensionName,
						`review ${completed}/${activeLenses.length}`,
					);
					ctx.ui.setWidget(REVIEW_WIDGET, renderProgress(status));
				}
				// A lens only counts as errored when EVERY invocation failed;
				// partial results still feed the curator.
				const totalRuns = spec.passes * models.length;
				return {
					lens,
					findings: mergeLensFindings(collected),
					...(lensErrors.length === totalRuns ? { error: lensErrors[0] } : {}),
				};
			}),
		);
		if (ctx.hasUI) {
			ctx.ui.setStatus(extensionName, undefined);
			ctx.ui.setWidget(REVIEW_WIDGET, undefined);
		}

		const errors = outcomes
			.filter((o) => o.error)
			.map((o) => ({ lens: o.lens, error: o.error as string }));
		for (const e of errors) {
			notify(ctx, `${e.lens} failed: ${e.error.split("\n")[0]}`, "warning");
		}

		// ---- Stage 2: curator ----------------------------------------------
		const curatorInputs: CuratorInput[] = outcomes.map((o) => ({
			source: o.lens,
			findings: o.findings,
		}));
		const allStatic = [...staticFindings.byLane.values()].flat();
		if (allStatic.length > 0) {
			curatorInputs.push({
				source: "scanners",
				findings: allStatic,
				staticTool: true,
			});
		}
		const totalInput = curatorInputs.reduce((n, b) => n + b.findings.length, 0);
		const lensErrorRate =
			activeLenses.length > 0 ? errors.length / activeLenses.length : 0;

		let curatorResult: CuratorResult = { findings: [], ran: false };
		if (!shouldSkipCurator(totalInput, lensErrorRate)) {
			if (ctx.hasUI) {
				ctx.ui.setStatus(extensionName, "curating");
				ctx.ui.setWidget(REVIEW_WIDGET, ["🧠 curator: synthesising findings…"]);
			}
			curatorResult = await deps.runCurator({
				provider: curatorModel.provider,
				model: curatorModel.id,
				inputs: curatorInputs,
				diff: rc.diff,
				scopeLabel: rc.scopeLabel,
				cwd: ctx.cwd,
				signal: opts.signal,
				timeoutMs: budgets.curatorMs,
			});
			if (ctx.hasUI) {
				ctx.ui.setStatus(extensionName, undefined);
				ctx.ui.setWidget(REVIEW_WIDGET, undefined);
			}
			if (curatorResult.error) {
				notify(
					ctx,
					`curator error: ${curatorResult.error.split("\n")[0]}`,
					"warning",
				);
			}
		}

		// ---- Stage 2.5: consult (opt-in) -------------------------------------
		// Second opinion on findings the curator couldn't confidently
		// confirm, from a model in the opposite set. Adjusts confidence
		// before the split.
		let consultStats: { consulted: number; errors: number } | undefined;
		if (consultEnabled(settings) && curatorResult.findings.length > 0) {
			const consultModel = await resolveAgent("consult", agentSpecs.consult);
			if (consultModel) {
				if (ctx.hasUI) {
					ctx.ui.setStatus(extensionName, "consulting");
					ctx.ui.setWidget(REVIEW_WIDGET, [
						"🤝 consult: second opinion on contested findings…",
					]);
				}
				const consultOut = await deps.runConsult({
					provider: consultModel.provider,
					model: consultModel.id,
					findings: curatorResult.findings,
					diff: rc.diff,
					scopeLabel: rc.scopeLabel,
					cwd: ctx.cwd,
					signal: opts.signal,
					timeoutMs: budgets.lensMs,
				});
				curatorResult = { ...curatorResult, findings: consultOut.findings };
				consultStats = {
					consulted: consultOut.consulted,
					errors: consultOut.errors,
				};
				if (ctx.hasUI) {
					ctx.ui.setStatus(extensionName, undefined);
					ctx.ui.setWidget(REVIEW_WIDGET, undefined);
				}
			} else {
				notify(ctx, "consult enabled but no usable consult model", "info");
			}
		}

		// ---- Stage 3: confidence split --------------------------------------
		const { autoApplied, surfaced } = partitionCuratedFindings(
			curatorResult.findings,
		);

		// ---- Artifact + summary ---------------------------------------------
		const summaryBase = {
			scopeLabel: rc.scopeLabel,
			lenses: activeLenses,
			agentModels,
			findings: curatorResult.findings,
			autoApplied,
			surfaced,
			curatorRan: curatorResult.ran,
			curatorError: curatorResult.error,
			staticToolsRan,
			errors,
			diffSize: rc.additions + rc.deletions,
		};
		let artifactPath: string | undefined;
		try {
			const dir = opts.artifactDir ?? join(getAgentDir(), "review");
			mkdirSync(dir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			artifactPath = join(dir, `review-${stamp}.md`);
			const summaryForArtifact = buildSummaryText(summaryBase);
			writeFileSync(
				artifactPath,
				buildArtifact({ ...summaryBase, summary: summaryForArtifact }),
			);
		} catch (err) {
			notify(
				ctx,
				`could not write report artifact: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			artifactPath = undefined;
		}
		const text = buildSummaryText({ ...summaryBase, artifactPath });

		return {
			ran: true,
			scopeLabel: rc.scopeLabel,
			findings: curatorResult.findings,
			autoApplied,
			surfaced,
			errors,
			text,
			artifactPath,
			curatorRan: curatorResult.ran,
			...(curatorResult.error ? { curatorError: curatorResult.error } : {}),
			agentModels,
			staticToolsRan,
			...(indexError ? { indexError } : {}),
			...(consultStats ? { consult: consultStats } : {}),
		};
	} finally {
		keepAwake.release();
		if (ctx.hasUI) {
			ctx.ui.setStatus(extensionName, undefined);
			ctx.ui.setWidget(REVIEW_WIDGET, undefined);
		}
	}
}
