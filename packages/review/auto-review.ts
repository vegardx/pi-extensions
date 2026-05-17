/**
 * Auto-review pass — invoked by extensions (e.g. `modes`) after an
 * implement phase completes.
 *
 * Pipeline:
 *   Phase 0 — Static analysis (tsc, biome, npm audit, …) runs before
 *             any AI agent. Findings are injected into the relevant
 *             reviewer lane's task payload as pre-computed evidence.
 *
 *   Phase 1 — Fan-out: N reviewer roles × M model tiers run in
 *             parallel. Each gets the diff + its lane's static output.
 *
 *   Phase 2 — Orchestrator: a single synthesis agent receives all raw
 *             findings from every role + tier, deduplicates (fuzzy),
 *             cross-validates using its own tool access, and emits a
 *             final curated list with confidence levels.
 *
 *   Phase 3 — Split: high-confidence + fix → auto-apply;
 *             high/medium without fix, or low-confidence CRITICAL →
 *             surface for discussion; low-confidence IMPORTANT/NOTE →
 *             drop.
 *
 * The caller owns state-machine plumbing. This module owns model
 * resolution, static analysis, fan-out, orchestration, and prompt
 * assembly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
	BackgroundSet,
	Tier,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	type BackgroundTier,
	type OrchestratedFinding,
	parseOrchestratorOutput,
	type RawFinding,
	type ReviewerRole,
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
	type IndexSketch,
	renderIndexSketchForReviewer,
	runIndexer,
} from "./indexer.js";
import { type LaneId, type LaneSpec, resolveAllLanes } from "./lanes.js";
import { reviewTimeoutMs, runReviewer } from "./reviewer-client.js";
import {
	runStaticAnalysis,
	type StaticAnalysisConfig,
} from "./static-checker.js";

/**
 * Default reviewer roles for the auto-review pass. Deliberately narrow:
 * the auto-apply path means we trade breadth for high-confidence
 * mechanical fixes only.
 */
export const AUTO_REVIEW_ROLES: readonly ReviewerRole[] = [
	"code-reviewer",
	"code-simplifier",
	"security-analyst",
] as const;

/** Allowlist used to validate user-supplied role strings at runtime. */
export const VALID_REVIEWER_ROLES: readonly ReviewerRole[] = [
	"architect",
	"code-reviewer",
	"scope-analyst",
	"security-analyst",
	"code-simplifier",
	"doc-reviewer",
	"dependency-checker",
] as const;

const VALID_REVIEWER_ROLES_SET = new Set<ReviewerRole>(VALID_REVIEWER_ROLES);

/**
 * Map a `ReviewerRole` to its lane id. Reviewer ids and lane ids are
 * deliberately the same string for the seven roles tracked by
 * `LaneId`. `implementation-checker` is not in `LaneId` (the
 * auto-review pass doesn't fan it out) — callers should route those
 * through the orchestrator's lane spec instead.
 */
function laneIdForRole(role: ReviewerRole): LaneId | null {
	switch (role) {
		case "architect":
		case "code-reviewer":
		case "scope-analyst":
		case "security-analyst":
		case "code-simplifier":
		case "doc-reviewer":
		case "dependency-checker":
			return role;
		default:
			return null;
	}
}

const AUTO_REVIEW_WIDGET = "auto-review-progress";

const ORCHESTRATOR_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"orchestrator.md",
);

const CHALLENGER_PROMPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"prompts",
	"challenger.md",
);

/** Diff scope the auto-review operates on. Narrowed to in-branch
 *  contexts: the caller runs after edits on a feature branch, so we
 *  default to the branch diff against the default branch and fall
 *  back to the working-tree diff when no default branch is detected
 *  (e.g. a freshly-init'd repo with no `origin/HEAD`). */
type AutoReviewScopeMode = "branch" | "working";

export interface AutoReviewContext {
	scopeMode: AutoReviewScopeMode;
	scopeLabel: string;
	diff: string;
	files: string[];
	changedFiles: number;
	additions: number;
	deletions: number;
}

export interface RunAutoReviewOptions {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	/** Extension name used for per-extension model overrides. Defaults
	 *  to "modes". */
	extensionName?: string;
	/**
	 * Reviewer roles to run. Defaults to `AUTO_REVIEW_ROLES`.
	 * Strings are cast to `ReviewerRole`; unknown values are silently
	 * dropped by the role-not-found path in `buildTaskFor`.
	 */
	roles?: string[];
	/**
	 * When true (default), enable the `consult_other_model` tool on the
	 * orchestrator. The consult model is resolved in the *opposite*
	 * background set from the orchestrator's lane (orchestrator on
	 * `secondary` → consult on `primary`, and vice versa). When false
	 * (or no consult model is available), the orchestrator runs without
	 * the consult tool.
	 *
	 * Note: this no longer controls the fan-out shape — the fan-out is
	 * always a single secondary-first pass. The flag now only controls
	 * the second-opinion surface.
	 */
	multiModel?: boolean;
	/**
	 * When true (default), run the indexer lane before fan-out. The
	 * indexer produces a structured map of the diff that is threaded
	 * into every reviewer's task payload as additional context.
	 * Failures are best-effort and never block the fan-out.
	 */
	enableIndex?: boolean;
	/**
	 * Static analysis tool config. Passed verbatim to `runStaticAnalysis`.
	 * When omitted, all defaults apply (tsc + biome + npmAudit enabled;
	 * eslint, knip, semgrep off).
	 */
	staticAnalysisConfig?: StaticAnalysisConfig;
}

export type AutoReviewAbortReason =
	| "not-git"
	| "no-diff"
	| "no-primary-model"
	| "no-secondary-model"
	| "no-valid-roles"
	| "fanout-error";

export interface RunAutoReviewResult {
	ran: boolean;
	abortReason?: AutoReviewAbortReason;
	scopeLabel?: string;
	/** All findings as curated by the orchestrator agent. */
	findings?: OrchestratedFinding[];
	/** high-confidence + concrete fix → queued for auto-application. */
	autoApplied?: OrchestratedFinding[];
	/**
	 * High/medium confidence without a concrete fix, or low-confidence
	 * CRITICAL findings — surfaced for user discussion.
	 */
	surfaced?: OrchestratedFinding[];
	/** Models actually used (for the report message). Under the new
	 *  per-lane resolution, `primaryModel` is the *orchestrator* model
	 *  spec, `secondaryModel` (when present) is the consult model spec.
	 *  See `laneModels` for the full per-lane breakdown. */
	primaryModel?: string;
	secondaryModel?: string;
	/**
	 * Per-lane model spec map. Keys: reviewer role names, plus
	 * `"orchestrator"`, `"index"` (when enabled and resolved), and
	 * `"consult"` (when the consult tool was registered). Values are
	 * `"provider/id"` strings. Useful for callers and the report to
	 * show *which* model ran *which* lane when per-lane configuration
	 * is non-uniform.
	 */
	laneModels?: Record<string, string>;
	/** Indexer error message when the indexer ran and failed. */
	indexError?: string;
	/** True when the orchestrator agent ran and produced parseable output. */
	orchestratorRan?: boolean;
	/** Error message when the orchestrator failed (timeout, model not found, parse failure). */
	orchestratorError?: string;
	/** Count of enabled static analysis tools that ran. */
	staticToolsRan?: number;
	/** Per-(role, tier) reviewer errors, surfaced via the report. */
	errors?: Array<{ role: ReviewerRole; tier: BackgroundTier; error: string }>;
}

function notify(
	ctx: ExtensionContext,
	msg: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) ctx.ui.notify(`auto-review: ${msg}`, level);
}

function resolveAutoReviewContext(
	ctx: ExtensionContext,
): AutoReviewContext | { error: string } {
	const cwd = ctx.cwd;
	const defaultBranch = detectDefaultBranch(cwd);
	if (defaultBranch) {
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
		// Branch diff empty — fall through to working tree as a fallback
		// (e.g. user is on default branch with uncommitted edits).
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
 * Build a single reviewer's task payload. Exported so callers and
 * tests can verify what each lane sees — including the optional
 * indexer sketch and pre-computed static analysis findings.
 */
export function buildTaskFor(
	role: ReviewerRole,
	rc: AutoReviewContext,
	indexSketch: IndexSketch | null,
	staticFindings?: readonly RawFinding[],
): string {
	const lines: string[] = [
		`Role: ${role}`,
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

interface ReviewerInvocationKey {
	role: ReviewerRole;
	tier: BackgroundTier;
}

function renderProgress(
	status: ReadonlyMap<string, "running" | "done">,
): string[] {
	const lines: string[] = [];
	const total = status.size;
	let done = 0;
	for (const v of status.values()) if (v === "done") done++;
	lines.push(`🤖 auto-review (${done}/${total} reviewers done)`);
	for (const [key, s] of status) {
		const barIdx = key.indexOf("|");
		const role = barIdx >= 0 ? key.slice(0, barIdx) : key;
		const tier = barIdx >= 0 ? key.slice(barIdx + 1) : "";
		const glyph = s === "done" ? "✓" : "⏳";
		lines.push(`  ${glyph} ${role}${tier ? ` (${tier})` : ""}`);
	}
	return lines;
}

interface ResolvedLaneModel {
	/** The lane's resolved set (acts as the `BackgroundTier` tag for
	 *  findings — `primary` or `secondary`). */
	set: BackgroundSet;
	/** The tier the lane resolved to (`fast` | `normal` | `heavy`). */
	tier: Tier;
	/** Display string: `"provider/id"`. */
	spec: string;
	/** Retained Model reference for the in-process orchestrator session.
	 *  Avoids a second registry lookup that can fail if the provider
	 *  re-registers models between resolution and use. Subagent paths
	 *  (reviewer fan-out, consultation) pass provider/model strings to
	 *  separate processes and are not affected. */
	model: Model<Api>;
}

async function resolveLaneModel(
	ctx: ExtensionContext,
	extensionName: string,
	lane: LaneSpec,
): Promise<ResolvedLaneModel | null> {
	const resolved = await resolveModel(ctx, {
		name: extensionName,
		tier: lane.tier,
		set: lane.set,
	});
	if (!resolved) return null;
	return {
		set: lane.set,
		tier: lane.tier,
		spec: `${resolved.model.provider}/${resolved.model.id}`,
		model: resolved.model,
	};
}

/**
 * Pick the *opposite* set from the orchestrator's resolved lane and
 * resolve a model under it for the `consult_other_model` tool. When
 * the orchestrator already runs on `secondary`, this resolves under
 * `primary` (the historic default for the consult tool). When the
 * orchestrator is overridden onto `primary`, it falls back to
 * `secondary`. Either way the orchestrator gets a second-opinion
 * surface from a different model family.
 */
async function resolveConsultModel(
	ctx: ExtensionContext,
	extensionName: string,
	orchestratorLane: LaneSpec,
): Promise<ResolvedLaneModel | null> {
	const otherSet: BackgroundSet =
		orchestratorLane.set === "secondary" ? "primary" : "secondary";
	return resolveLaneModel(ctx, extensionName, {
		set: otherSet,
		tier: orchestratorLane.tier,
	});
}

// ---- Orchestrator phase (Phase 2) --------------------------------------
//
// Replaces the old one-at-a-time challenge phase. A single synthesis
// agent receives ALL raw findings from every reviewer lane and model
// tier, plus the diff. It deduplicates (fuzzy), cross-validates using
// its own read/grep/find/ls access, and assigns confidence levels.
//
// Confidence-based split (done by the caller after this returns):
//   high + suggestedAction  → auto-apply
//   high / medium           → surface for discussion
//   low + CRITICAL          → surface with caveat (NEVER dropped)
//   low + IMPORTANT/NOTE    → drop

interface OrchestratorInput {
	role: ReviewerRole;
	tier: BackgroundTier;
	findings: RawFinding[];
	/** When true, findings came from a deterministic static analysis tool. */
	staticTool?: boolean;
}

function buildOrchestratorTask(
	bundles: OrchestratorInput[],
	rc: AutoReviewContext,
): string {
	const lines: string[] = [
		"## Input findings from all reviewer agents",
		"",
		"Each entry has `role` (reviewer lane) and `tier` (model tier: primary",
		"or secondary). Same real issue may appear under different titles from",
		"different models — your job is to recognise and merge them.",
		"",
		"```json",
		JSON.stringify(
			bundles.map((b) => ({
				role: b.role,
				tier: b.tier,
				...(b.staticTool ? { staticTool: true } : {}),
				findings: b.findings,
			})),
			null,
			2,
		),
		"```",
		"",
		`## Diff (scope: ${rc.scopeLabel})`,
		"",
		"```diff",
		rc.diff.trimEnd(),
		"```",
	];
	return lines.join("\n");
}

async function runOrchestratorPhase(opts: {
	bundles: OrchestratorInput[];
	rc: AutoReviewContext;
	orchestrator: ResolvedLaneModel;
	/** When provided, the orchestrator gets a `consult_other_model`
	 *  custom tool it can call for uncertain CRITICAL findings. The
	 *  tool routes to a model in the *opposite* set from the
	 *  orchestrator's lane (orchestrator on secondary → consult primary,
	 *  and vice versa). */
	consult: ResolvedLaneModel | null;
	/** Fraction of reviewer invocations that errored (0–1). Used to
	 *  decide whether to run the orchestrator even with 0 input findings. */
	reviewerErrorRate: number;
	extensionName: string;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}): Promise<{
	findings: OrchestratedFinding[];
	orchestratorRan: boolean;
	error?: string;
}> {
	const { bundles, rc, orchestrator, consult, extensionName, ctx } = opts;

	const totalInputFindings = bundles.reduce((n, b) => n + b.findings.length, 0);

	if (shouldSkipOrchestrator(totalInputFindings, opts.reviewerErrorRate)) {
		return { findings: [], orchestratorRan: false };
	}

	if (totalInputFindings === 0) {
		notify(
			ctx,
			"high reviewer error rate — running orchestrator as fallback",
			"warning",
		);
	}

	notify(
		ctx,
		`orchestrator: synthesising ${totalInputFindings} raw finding(s)${
			consult ? " (consult tool available)" : ""
		}`,
		"info",
	);

	if (ctx.hasUI) {
		ctx.ui.setStatus(extensionName, "orchestrating");
		ctx.ui.setWidget(AUTO_REVIEW_WIDGET, [
			"🧠 orchestrator: synthesising findings…",
		]);
	}

	const timeoutMs = Math.min(reviewTimeoutMs(rc.diff.length) * 2, 600_000);

	// ---- Build consultation tool (if consult model available) ----------
	//
	// The orchestrator can call this tool for any CRITICAL finding it is
	// uncertain about. The consult model lives in the *opposite* set from
	// the orchestrator's lane (orchestrator on secondary → primary as
	// the second opinion). It evaluates the finding using the challenger
	// system prompt and returns its verdict as a JSON string. The
	// orchestrator reads the response and adjusts confidence accordingly.
	const customTools = consult
		? [
				defineTool({
					name: "consult_other_model",
					label: "Consult Other Model",
					description:
						"Ask a model in the opposite background set whether it agrees with a " +
						"finding you are uncertain about. The consult model has independent code " +
						"access and will return a JSON verdict with agree/reason/suggestedAction.",
					parameters: Type.Object({
						file: Type.String({ description: "File path" }),
						line: Type.Optional(
							Type.Number({ description: "Line number, if applicable" }),
						),
						title: Type.String({ description: "Finding title" }),
						description: Type.String({
							description: "Why this might be an issue",
						}),
						suggestedAction: Type.Optional(
							Type.String({ description: "Proposed fix, if any" }),
						),
					}),
					async execute(_toolCallId, params, signal) {
						// Tool is only registered when consult != null;
						// guard defensively so TypeScript/biome are happy.
						if (!consult) {
							return {
								content: [
									{
										type: "text" as const,
										text: '{"agree":false,"reason":"consult model unavailable"}',
									},
								],
								details: {},
							};
						}
						const loc = params.line
							? `${params.file}:${params.line}`
							: params.file;
						const consultTask = [
							"You are evaluating a finding from the primary reviewer. Respond with the JSON schema your system prompt describes.",
							"",
							"## Finding to evaluate",
							"",
							`- **File**: ${loc}`,
							`- **Title**: ${params.title}`,
							`- **Description**: ${params.description}`,
							`- **Proposed fix**: ${
								params.suggestedAction?.trim() || "none proposed"
							}`,
							"",
							`## Code diff (scope: ${rc.scopeLabel})`,
							"",
							"```diff",
							rc.diff.trimEnd(),
							"```",
						].join("\n");

						const out = await runSubagent({
							tag: "consultation",
							task: consultTask,
							systemPromptPath: CHALLENGER_PROMPT_PATH,
							provider: consult.model.provider,
							model: consult.model.id,
							cwd: ctx.cwd,
							signal,
							timeoutMs: reviewTimeoutMs(rc.diff.length),
						});

						const text = out.error
							? JSON.stringify({
									agree: false,
									reason: `consultation error: ${out.error.slice(0, 100)}`,
								})
							: out.rawText;
						return {
							content: [{ type: "text" as const, text }],
							details: {},
						};
					},
				}),
			]
		: [];

	// ---- Spin up in-process orchestrator session -------------------------
	// Use the model reference retained by resolveLaneModel so custom-provider
	// models (e.g. radicalai) remain usable even if the provider re-registers
	// its model list between resolution and use (async refresh race).

	const systemPrompt = readFileSync(ORCHESTRATOR_PROMPT_PATH, "utf8");
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => systemPrompt,
		// Prevent DefaultResourceLoader from appending global/project
		// APPEND_SYSTEM.md files — the orchestrator's prompt is self-contained.
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		model: orchestrator.model,
		// Read-only built-in tools + the optional consult custom tool.
		tools: ["read", "grep", "find", "ls"],
		customTools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		modelRegistry: ctx.modelRegistry,
	});

	const task = buildOrchestratorTask(bundles, rc);

	try {
		const promptPromise = session.prompt(task);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortHandler: (() => void) | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("orchestrator timeout")),
				timeoutMs,
			);
			abortHandler = () => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			};
			opts.signal?.addEventListener("abort", abortHandler, { once: true });
		});

		try {
			await Promise.race([promptPromise, timeoutPromise]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (abortHandler && opts.signal) {
				opts.signal.removeEventListener("abort", abortHandler);
			}
		}
	} catch (err) {
		session.dispose();
		if (ctx.hasUI) {
			ctx.ui.setStatus(extensionName, undefined);
			ctx.ui.setWidget(AUTO_REVIEW_WIDGET, undefined);
		}
		const msg = err instanceof Error ? err.message : String(err);
		return { findings: [], orchestratorRan: false, error: msg };
	}

	const rawText = session.getLastAssistantText() ?? "";
	session.dispose();

	if (ctx.hasUI) {
		ctx.ui.setStatus(extensionName, undefined);
		ctx.ui.setWidget(AUTO_REVIEW_WIDGET, undefined);
	}

	const parsed = parseOrchestratorOutput(rawText);
	if (parsed === null) {
		return {
			findings: [],
			orchestratorRan: false,
			error: `orchestrator output not parseable: ${rawText.slice(0, 300)}`,
		};
	}
	return { findings: parsed, orchestratorRan: true };
}

// ---- Tier → model label helper -----------------------------------------

/**
 * Format the `confirmedByTiers` array into a human-readable model
 * attribution string. When model specs are available, maps tier
 * labels to actual model names (e.g. "anthropic/claude-sonnet-4-20250514").
 * Falls back to raw tier labels when model specs aren't provided.
 *
 * NOTE (#164b): in the new secondary-first single-pass architecture
 * `confirmedByTiers` semantics are blurry — "secondary" findings come
 * from the fan-out lanes (whose model varies per lane) and "primary"
 * findings typically come from the consult tool. The `secondaryModel`
 * arg historically meant "secondary fan-out tier model" but is now
 * being filled with the consult spec at call sites. Per-finding
 * attribution is therefore approximate; the orchestrator/consult
 * split shown in the report header is the authoritative reference.
 * Tracked as a follow-up to plumb `laneModels` through to here.
 */
export function formatTierAttribution(
	tiers: readonly string[],
	primaryModel?: string,
	secondaryModel?: string,
): string {
	if (tiers.length === 0) return "";
	const unique = [...new Set(tiers)];
	const labels = unique.map((t) => {
		if (t === "primary" && primaryModel) return primaryModel;
		if (t === "secondary" && secondaryModel) return secondaryModel;
		return t;
	});
	return labels.join(" + ");
}

/**
 * Build the fix prompt the host agent receives once the orchestrator
 * has produced high-confidence findings with concrete fix suggestions.
 *
 * `primaryModel` is the orchestrator's model spec; `secondaryModel`
 * (optional) is the consult model spec (when registered).
 */
export function buildAutoReviewFixPrompt(
	accepted: readonly OrchestratedFinding[],
	primaryModel: string,
	secondaryModel?: string,
): string {
	const reviewerDesc = secondaryModel
		? `The review orchestrator (\`${primaryModel}\`, with consult fallback to \`${secondaryModel}\` for uncertain CRITICALs) flagged the following high-confidence findings. Apply the suggested fixes directly.`
		: `The review orchestrator (\`${primaryModel}\`) flagged the following findings with concrete fix suggestions. Apply them directly.`;
	const lines: string[] = [
		"[auto-review]",
		"",
		reviewerDesc,
		"Group related fixes into cohesive commits, but do not commit",
		"until the user says so.",
		"",
	];
	accepted.forEach((f, idx) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		const roles = f.confirmedByRoles.join(", ") || "(unknown)";
		const conf = f.confidence;
		const models = formatTierAttribution(
			f.confirmedByTiers,
			primaryModel,
			secondaryModel,
		);
		lines.push(
			`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
			`   - Confidence: ${conf} | Roles: ${roles}${models ? ` | Models: ${models}` : ""}`,
			`   - Why: ${f.description}`,
		);
		if (f.suggestedAction) {
			lines.push(`   - Fix: ${f.suggestedAction}`);
		}
		if (f.orchestratorNote) {
			lines.push(`   - Note: ${f.orchestratorNote}`);
		}
		lines.push("");
	});
	lines.push(
		"After applying, briefly summarize which fixes you applied and",
		"any you skipped (with one-line reasons).",
	);
	return lines.join("\n");
}

/**
 * Build the user-visible report message summarising the auto-review
 * pass. Pure — does not read from pi.
 */
export function buildAutoReviewReport(opts: {
	scopeLabel: string;
	roles: readonly string[];
	multiModel: boolean;
	primaryModel: string;
	secondaryModel?: string;
	findings: readonly OrchestratedFinding[];
	autoApplied: readonly OrchestratedFinding[];
	surfaced: readonly OrchestratedFinding[];
	orchestratorRan: boolean;
	orchestratorError?: string;
	staticToolsRan: number;
	/** Total reviewer invocations (roles × tiers). */
	totalInvocations: number;
	/** Sum of additions + deletions in the diff. */
	diffSize: number;
	/** Aggregate cost across all reviewer subagents. */
	totalCost?: number;
	errors: ReadonlyArray<{
		role: ReviewerRole;
		tier: BackgroundTier;
		error: string;
	}>;
}): string {
	const lines: string[] = [];
	lines.push("## Auto-review report");
	lines.push("");
	lines.push(`**Scope**: ${opts.scopeLabel}`);
	lines.push(`**Roles**: ${opts.roles.join(", ")}`);
	if (opts.multiModel && opts.secondaryModel) {
		lines.push(`**Orchestrator model**: \`${opts.primaryModel}\``);
		lines.push(`**Consult model**: \`${opts.secondaryModel}\``);
		lines.push(`**Mode**: secondary-first fan-out + consult-tool orchestrator`);
	} else {
		lines.push(`**Orchestrator model**: \`${opts.primaryModel}\``);
		lines.push(`**Mode**: secondary-first fan-out + orchestrator (no consult)`);
	}
	if (opts.staticToolsRan > 0) {
		lines.push(`**Static analysis**: ${opts.staticToolsRan} tool(s) ran`);
	}
	if (opts.totalCost !== undefined && opts.totalCost > 0) {
		lines.push(`**Cost**: $${opts.totalCost.toFixed(4)}`);
	}
	lines.push("");
	const totalFindings = opts.findings.length;
	const autoCount = opts.autoApplied.length;
	const surfacedCount = opts.surfaced.length;
	const dropped = totalFindings - autoCount - surfacedCount;
	lines.push(
		`**Findings**: ${totalFindings} total · ${autoCount} auto-applying · ${surfacedCount} for discussion · ${dropped} low-confidence (dropped)`,
	);
	const firstLine = (s: string) => s.split("\n")[0].slice(0, 120);
	if (!opts.orchestratorRan) {
		if (opts.orchestratorError) {
			lines.push(
				`**Orchestrator**: failed — ${firstLine(opts.orchestratorError)}`,
			);
		} else {
			lines.push(
				"**Orchestrator**: skipped (no input findings from reviewers or static tools)",
			);
		}
	}
	if (opts.errors.length > 0) {
		lines.push(
			`**Reviewer errors**: ${opts.errors.length} (the affected lane was treated as empty)`,
		);
		for (const e of opts.errors) {
			lines.push(`  - \`${e.role}/${e.tier}\`: ${firstLine(e.error)}`);
		}
	}
	if (autoCount === 0 && surfacedCount === 0) {
		lines.push("");
		// Suspicious silence: all successful lanes found nothing on a large diff.
		const successfulLanes = opts.totalInvocations - opts.errors.length;
		if (
			successfulLanes > 0 &&
			totalFindings === 0 &&
			opts.diffSize > 50 &&
			!opts.orchestratorError
		) {
			lines.push(
				"⚠️ All reviewers found nothing on a non-trivial diff — consider",
				"running `/review` manually to rule out systemic subagent failures.",
				"",
			);
		}
		lines.push(
			"No actionable findings after orchestrator synthesis. Nothing to",
			"auto-apply or discuss. Run `/review` for the full seven-lane",
			"interactive walk-through.",
		);
		return lines.join("\n");
	}
	if (autoCount > 0) {
		lines.push("");
		lines.push("### Auto-applying:");
		lines.push("");
		opts.autoApplied.forEach((f, idx) => {
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			const staticTag = f.staticToolSource ? ` [${f.staticToolSource}]` : "";
			const models = formatTierAttribution(
				f.confirmedByTiers,
				opts.primaryModel,
				opts.secondaryModel,
			);
			const modelTag = models ? ` {${models}}` : "";
			lines.push(
				`${idx + 1}. [${f.severity}] \`${loc}\` — ${f.title} (${f.confirmedByRoles.join(", ") || "orchestrator"})${modelTag}${staticTag}`,
			);
		});
	}
	if (surfacedCount > 0) {
		lines.push("");
		lines.push("### Needs discussion:");
		lines.push("");
		opts.surfaced.forEach((f, idx) => {
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			const confTag =
				f.confidence === "low" ? ` \u26a0\ufe0f low confidence` : "";
			const staticTag = f.staticToolSource ? ` [${f.staticToolSource}]` : "";
			const models = formatTierAttribution(
				f.confirmedByTiers,
				opts.primaryModel,
				opts.secondaryModel,
			);
			const modelTag = models ? ` {${models}}` : "";
			lines.push(
				`${idx + 1}. [${f.severity}] \`${loc}\` — ${f.title} (${f.confirmedByRoles.join(", ") || "orchestrator"})${modelTag}${confTag}${staticTag}`,
			);
			if (f.orchestratorNote) {
				lines.push(`   \u2192 ${f.orchestratorNote}`);
			}
		});
	}
	return lines.join("\n");
}

/**
 * Build the host-agent prompt for findings that have no concrete
 * `suggestedAction`, or are low-confidence CRITICALs.
 */
export function buildAutoReviewDiscussionPrompt(
	surfaced: readonly OrchestratedFinding[],
	primaryModel: string,
	secondaryModel: string | undefined,
): string {
	const intro = secondaryModel
		? `The review orchestrator (\`${primaryModel}\` + \`${secondaryModel}\`) flagged the following issue(s) but could not produce concrete fix suggestions, or confidence was low. Surface each one to the user and ask how they'd like to proceed.`
		: `The review orchestrator (\`${primaryModel}\`) flagged the following issue(s) without a concrete fix or with low confidence. Surface each one to the user and ask how they'd like to proceed.`;
	const lines: string[] = [
		"[auto-review \u2014 needs discussion]",
		"",
		intro,
		"",
	];
	surfaced.forEach((f, idx) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		const conf = f.confidence === "low" ? " \u26a0\ufe0f low confidence" : "";
		const models = formatTierAttribution(
			f.confirmedByTiers,
			primaryModel,
			secondaryModel,
		);
		lines.push(
			`${idx + 1}. **[${f.severity}] \`${loc}\`** \u2014 ${f.title}${conf}`,
			`   - Roles: ${f.confirmedByRoles.join(", ") || "orchestrator"}${models ? ` | Models: ${models}` : ""}`,
			`   - Why: ${f.description}`,
			``,
		);
		if (f.orchestratorNote) {
			lines.push(`   - Note: ${f.orchestratorNote}`, "");
		}
	});
	lines.push(
		`For each finding, ask the user whether they want to:`,
		`a) Fix it (propose a concrete fix based on context)`,
		`b) Investigate further (look deeper before deciding)`,
		`c) Accept the risk / skip (with a brief reason)`,
	);
	return lines.join("\n");
}

/**
 * Read the `staticAnalysis` sub-config from `extensionConfig.review`
 * in settings.json. Returns `{}` (all defaults apply) when absent or
 * malformed. Exported for testing and for callers that want to read
 * and inspect the config before passing it to `runAutoReview`.
 *
 * Settings shape:
 * ```json
 * {
 *   "extensionConfig": {
 *     "review": {
 *       "staticAnalysis": {
 *         "tsc":      { "enabled": true,  "timeout": 30000  },
 *         "biome":    { "enabled": true,  "timeout": 15000  },
 *         "eslint":   { "enabled": false },
 *         "knip":     { "enabled": false },
 *         "npmAudit": { "enabled": true,  "timeout": 20000  },
 *         "semgrep":  { "enabled": false, "timeout": 120000 }
 *       }
 *     }
 *   }
 * }
 * ```
 */
/**
 * Should the orchestrator be skipped when there are 0 input findings?
 * Returns `true` (skip) when the reviewer error rate is below the
 * threshold — i.e. enough reviewers ran successfully and genuinely
 * found nothing. Returns `false` (run anyway) when the error rate
 * is high enough that the "0 findings" result is untrustworthy.
 *
 * Exported for unit testing.
 */
export function shouldSkipOrchestrator(
	totalInputFindings: number,
	reviewerErrorRate: number,
): boolean {
	if (totalInputFindings > 0) return false;
	return reviewerErrorRate < 1 / 3;
}

export function readStaticAnalysisConfig(
	cwd: string,
	agentDir?: string,
): StaticAnalysisConfig {
	const settings = readRelevantSettings(cwd, agentDir);
	const reviewCfg = settings.extensionConfig?.review;
	if (!reviewCfg || typeof reviewCfg !== "object") return {};
	const raw = (reviewCfg as Record<string, unknown>).staticAnalysis;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	// Shallow-trust the user-supplied object; individual tool entries are
	// validated and defaulted inside resolveConfig() in static-checker.ts.
	return raw as StaticAnalysisConfig;
}

/**
 * Partition orchestrated findings into auto-apply and needs-discussion
 * buckets based on confidence and fix availability.
 */
export function partitionFindings(findings: readonly OrchestratedFinding[]): {
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

/**
 * Public entry point. Resolves per-lane models from settings, runs
 * Phase 0 static analysis, optionally runs the indexer (Phase 0.5),
 * fans out to role reviewers in a single secondary-first pass, then
 * runs the orchestrator agent to synthesise findings.
 */
export async function runAutoReview(
	opts: RunAutoReviewOptions,
): Promise<RunAutoReviewResult> {
	const { ctx, pi } = opts;
	const extensionName = opts.extensionName ?? "modes";

	if (!isGitRepo(ctx.cwd)) {
		notify(ctx, "not inside a git repository", "error");
		return { ran: false, abortReason: "not-git" };
	}

	const rc = resolveAutoReviewContext(ctx);
	if ("error" in rc) {
		notify(ctx, rc.error, "info");
		return { ran: false, abortReason: "no-diff" };
	}

	const rawRoles = opts.roles?.length
		? opts.roles
		: (AUTO_REVIEW_ROLES as string[]);
	const roles: ReviewerRole[] = [];
	for (const r of rawRoles) {
		if (VALID_REVIEWER_ROLES_SET.has(r as ReviewerRole)) {
			roles.push(r as ReviewerRole);
		} else {
			notify(
				ctx,
				`unknown reviewer role "${r}" in autoReviewRoles — skipping`,
				"warning",
			);
		}
	}
	if (roles.length === 0) {
		notify(
			ctx,
			"no valid roles remain after filtering autoReviewRoles — aborting auto-review",
			"warning",
		);
		return { ran: false, abortReason: "no-valid-roles" };
	}

	// `multiModel` toggles whether the orchestrator gets a consult-tool
	// surface for second-opinion lookups under the opposite background
	// set. It no longer controls the fan-out (the fan-out is always a
	// single secondary-first pass under the per-lane configuration).
	const multiModel = opts.multiModel ?? true;

	// Resolve the per-lane configuration once. `lanes.<id>` overrides
	// `defaultLane` overrides built-in defaults; invalid entries are
	// fail-closed (skipped, falling through to the next layer).
	const settings = readRelevantSettings(ctx.cwd);
	const laneTable = resolveAllLanes(settings);

	const orchestrator = await resolveLaneModel(
		ctx,
		extensionName,
		laneTable.orchestrator,
	);
	if (!orchestrator) {
		notify(
			ctx,
			`no usable orchestrator model (lane orchestrator: ${laneTable.orchestrator.set}.${laneTable.orchestrator.tier})`,
			"warning",
		);
		return {
			ran: false,
			abortReason: "no-primary-model",
			scopeLabel: rc.scopeLabel,
		};
	}

	// Consult model lives in the *opposite* set from the orchestrator's
	// lane so the orchestrator gets a second opinion from a different
	// model family. When unavailable the orchestrator simply runs
	// without the consult tool surface.
	const consultRaw: ResolvedLaneModel | null = multiModel
		? await resolveConsultModel(ctx, extensionName, laneTable.orchestrator)
		: null;
	// `resolveModel` falls back from `secondary.<tier>` to `primary.<tier>`
	// (and then to `ctx.model`), so with only one set configured the
	// orchestrator and consult specs can collapse to the same model. In
	// that case the consult tool isn't actually a second opinion — skip
	// it so we don't pretend.
	const consult: ResolvedLaneModel | null =
		consultRaw && consultRaw.spec !== orchestrator.spec ? consultRaw : null;
	if (multiModel && !consult) {
		const otherSet =
			laneTable.orchestrator.set === "secondary" ? "primary" : "secondary";
		const reason = consultRaw
			? `${otherSet}.${laneTable.orchestrator.tier} resolved to the same model as the orchestrator (${consultRaw.spec})`
			: `orchestrator on ${laneTable.orchestrator.set}, no usable model in ${otherSet}.${laneTable.orchestrator.tier}`;
		notify(
			ctx,
			`no consult model available (${reason}) — running without consult tool`,
			"info",
		);
	}

	// Resolve every reviewer-role lane independently. Each maps to one
	// invocation in the single fan-out pass. Roles whose model fails to
	// resolve are dropped with a warning rather than aborting the run.
	const roleLaneModels: Map<ReviewerRole, ResolvedLaneModel> = new Map();
	for (const role of roles) {
		const laneId = laneIdForRole(role);
		if (!laneId) continue;
		const spec = laneTable[laneId];
		const lm = await resolveLaneModel(ctx, extensionName, spec);
		if (!lm) {
			notify(
				ctx,
				`no usable model for ${role} (lane ${spec.set}.${spec.tier}) — skipping`,
				"warning",
			);
			continue;
		}
		roleLaneModels.set(role, lm);
	}
	if (roleLaneModels.size === 0) {
		notify(
			ctx,
			"no reviewer lanes resolved to a usable model — aborting auto-review",
			"warning",
		);
		return {
			ran: false,
			abortReason: "no-primary-model",
			scopeLabel: rc.scopeLabel,
		};
	}

	// ---- Phase 0: Static analysis ---------------------------------------
	// Run before spawning AI agents so findings can be injected as
	// pre-computed evidence into each reviewer's task payload.
	const staticFindings = await runStaticAnalysis(
		ctx.cwd,
		opts.staticAnalysisConfig ?? readStaticAnalysisConfig(ctx.cwd),
	);
	const staticToolsRan = staticFindings.toolResults.filter(
		(r) => r.available && r.enabled,
	).length;
	if (staticToolsRan > 0) {
		notify(
			ctx,
			`static analysis: ${staticToolsRan} tool(s) ran, ` +
				`${[...staticFindings.byLane.values()].reduce((n, f) => n + f.length, 0)} finding(s)`,
			"info",
		);
	}

	// ---- Phase 0.5: Indexer ---------------------------------------------
	// Build a structured map of the diff and thread it into every
	// reviewer's task payload. Best-effort: failures are captured but
	// never block the fan-out.
	let indexSketch: IndexSketch | null = null;
	let indexError: string | undefined;
	let indexerSpec: string | undefined;
	const enableIndex = opts.enableIndex ?? true;
	if (enableIndex) {
		const indexLane = await resolveLaneModel(
			ctx,
			extensionName,
			laneTable.index,
		);
		if (indexLane) {
			indexerSpec = indexLane.spec;
			notify(ctx, `indexer: building diff sketch (${indexLane.spec})`, "info");
			const out = await runIndexer({
				task: buildIndexerTask(rc),
				provider: indexLane.model.provider,
				model: indexLane.model.id,
				cwd: ctx.cwd,
				signal: ctx.signal,
				timeoutMs: reviewTimeoutMs(rc.diff.length),
			});
			if (out.error) {
				indexError = out.error;
				notify(
					ctx,
					`indexer failed: ${out.error.split("\n")[0]} — reviewers continue without index`,
					"warning",
				);
			} else {
				indexSketch = out.sketch;
			}
		} else {
			notify(
				ctx,
				`indexer: no usable model (lane ${laneTable.index.set}.${laneTable.index.tier}) — skipping`,
				"info",
			);
		}
	}

	// ---- Phase 1: Single-pass fan-out ----------------------------------
	// Each reviewer role runs once, at its per-lane resolved model.
	const invocations: Array<
		ReviewerInvocationKey & { laneModel: ResolvedLaneModel }
	> = [];
	const status = new Map<string, "running" | "done">();
	for (const role of roles) {
		const lm = roleLaneModels.get(role);
		if (!lm) continue;
		invocations.push({ role, tier: lm.set, laneModel: lm });
		status.set(`${role}|${lm.set}`, "running");
	}

	const laneSpecs = invocations
		.map((inv) => `${inv.role}:${inv.laneModel.spec}`)
		.join(", ");
	notify(
		ctx,
		`${rc.scopeLabel}: ${rc.changedFiles} file(s), fanning out ${invocations.length} reviewers (${laneSpecs})`,
		"info",
	);

	if (ctx.hasUI) {
		ctx.ui.setStatus(extensionName, `auto-review 0/${invocations.length}`);
		ctx.ui.setWidget(AUTO_REVIEW_WIDGET, renderProgress(status));
	}

	let completed = 0;
	let outcomes: Array<{
		role: ReviewerRole;
		tier: BackgroundTier;
		findings: RawFinding[];
		error?: string;
	}>;
	try {
		outcomes = await Promise.all(
			invocations.map(async (inv) => {
				const result = await runReviewer({
					role: inv.role,
					task: buildTaskFor(
						inv.role,
						rc,
						indexSketch,
						staticFindings.byLane.get(
							inv.role as
								| "code-reviewer"
								| "security-analyst"
								| "code-simplifier",
						),
					),
					provider: inv.laneModel.model.provider,
					model: inv.laneModel.model.id,
					cwd: ctx.cwd,
					signal: ctx.signal,
					timeoutMs: reviewTimeoutMs(rc.diff.length),
				});
				completed++;
				status.set(`${inv.role}|${inv.tier}`, "done");
				if (ctx.hasUI) {
					ctx.ui.setStatus(
						extensionName,
						`auto-review ${completed}/${invocations.length}`,
					);
					ctx.ui.setWidget(AUTO_REVIEW_WIDGET, renderProgress(status));
				}
				return {
					role: inv.role,
					tier: inv.tier,
					findings: result.findings,
					error: result.error,
				};
			}),
		);
	} catch (err) {
		notify(ctx, err instanceof Error ? err.message : String(err), "error");
		if (ctx.hasUI) {
			ctx.ui.setStatus(extensionName, undefined);
			ctx.ui.setWidget(AUTO_REVIEW_WIDGET, undefined);
		}
		return {
			ran: false,
			abortReason: "fanout-error",
			scopeLabel: rc.scopeLabel,
			primaryModel: orchestrator.spec,
			...(consult ? { secondaryModel: consult.spec } : {}),
		};
	}

	if (ctx.hasUI) {
		ctx.ui.setStatus(extensionName, undefined);
		ctx.ui.setWidget(AUTO_REVIEW_WIDGET, undefined);
	}

	const errors = outcomes
		.filter((o) => o.error)
		.map((o) => ({
			role: o.role,
			tier: o.tier,
			error: o.error as string,
		}));
	for (const e of errors) {
		notify(
			ctx,
			`${e.role}/${e.tier} failed: ${e.error.split("\n")[0]}`,
			"warning",
		);
	}

	const orchestratorBundles: OrchestratorInput[] = outcomes.map((o) => ({
		role: o.role,
		tier: o.tier,
		findings: o.findings,
	}));

	// Also inject static findings into the orchestrator's view (tagged
	// as synthetic bundles so it can treat them with higher reliability).
	const staticBundleRole: ReviewerRole = "code-reviewer";
	const allStaticFindings: RawFinding[] = [
		...[...staticFindings.byLane.values()].flat(),
	];
	if (allStaticFindings.length > 0) {
		orchestratorBundles.push({
			role: staticBundleRole,
			tier: orchestrator.set as BackgroundTier,
			findings: allStaticFindings,
			staticTool: true,
		});
	}

	// ---- Phase 2: Orchestrator -------------------------------------------
	const reviewerErrorRate =
		invocations.length > 0 ? errors.length / invocations.length : 0;
	const {
		findings,
		orchestratorRan,
		error: orchError,
	} = await runOrchestratorPhase({
		bundles: orchestratorBundles,
		rc,
		orchestrator,
		consult,
		reviewerErrorRate,
		extensionName,
		ctx,
		signal: ctx.signal,
	});

	if (orchError) {
		notify(ctx, `orchestrator error: ${orchError.split("\n")[0]}`, "warning");
	}

	// ---- Phase 3: Confidence-based split ---------------------------------
	//
	// high + fix → auto-apply
	// high / medium + no fix → surface for discussion
	// low + CRITICAL → surface with caveat (TypeScript safety net: the
	//   orchestrator should have called consult_other_model, but if
	//   it still returns low confidence we never silently drop a CRITICAL)
	// low + IMPORTANT/NOTE → drop
	const withFix = (f: OrchestratedFinding) =>
		f.suggestedAction !== undefined && f.suggestedAction.trim() !== "";
	const isHighOrMedium = (f: OrchestratedFinding) =>
		f.confidence === "high" || f.confidence === "medium";

	const autoApplied = findings.filter(
		(f) => f.confidence === "high" && withFix(f),
	);
	const surfaced = findings.filter((f) => {
		if (autoApplied.includes(f)) return false;
		// High/medium without a fix → discuss
		if (isHighOrMedium(f) && !withFix(f)) return true;
		// Medium with a fix → discuss (not confident enough to auto-apply)
		if (f.confidence === "medium" && withFix(f)) return true;
		// Low-confidence CRITICAL: the orchestrator consulted and still
		// wasn't sure — surface rather than drop.
		if (f.confidence === "low" && f.severity === "CRITICAL") return true;
		return false;
	});

	const orchestratorSpec = orchestrator.spec;
	const consultSpec = consult?.spec;
	const laneModelSummary: Record<string, string> = {};
	for (const [role, lm] of roleLaneModels) {
		laneModelSummary[role] = lm.spec;
	}
	laneModelSummary.orchestrator = orchestrator.spec;
	if (indexerSpec) laneModelSummary.index = indexerSpec;
	if (consultSpec) laneModelSummary.consult = consultSpec;

	pi.sendMessage(
		{
			customType: "auto-review-report",
			content: buildAutoReviewReport({
				scopeLabel: rc.scopeLabel,
				roles: roles as readonly string[],
				multiModel,
				primaryModel: orchestratorSpec,
				...(consultSpec ? { secondaryModel: consultSpec } : {}),
				findings,
				autoApplied,
				surfaced,
				orchestratorRan,
				...(orchError ? { orchestratorError: orchError } : {}),
				staticToolsRan,
				totalInvocations: invocations.length,
				diffSize: rc.additions + rc.deletions,
				errors,
			}),
			display: true,
			details: {
				scopeLabel: rc.scopeLabel,
				totalFindings: findings.length,
				autoApplied: autoApplied.length,
				surfaced: surfaced.length,
				orchestratorRan,
				staticToolsRan,
				primaryModel: orchestratorSpec,
				...(consultSpec ? { secondaryModel: consultSpec } : {}),
				laneModels: laneModelSummary,
				...(indexError ? { indexError } : {}),
				errorCount: errors.length,
			},
		},
		{ triggerTurn: false },
	);

	const hasPendingWork = autoApplied.length > 0 || surfaced.length > 0;

	if (autoApplied.length > 0) {
		pi.sendMessage(
			{
				customType: "auto-review-followup",
				content: buildAutoReviewFixPrompt(
					autoApplied,
					orchestratorSpec,
					consultSpec,
				),
				display: false,
				details: {
					autoApplied: autoApplied.length,
					primaryModel: orchestratorSpec,
					...(consultSpec ? { secondaryModel: consultSpec } : {}),
				},
			},
			{ deliverAs: "followUp", triggerTurn: surfaced.length === 0 },
		);
	}

	if (surfaced.length > 0) {
		pi.sendMessage(
			{
				customType: "auto-review-discussion",
				content: buildAutoReviewDiscussionPrompt(
					surfaced,
					orchestratorSpec,
					consultSpec,
				),
				display: false,
				details: {
					surfaced: surfaced.length,
					primaryModel: orchestratorSpec,
					...(consultSpec ? { secondaryModel: consultSpec } : {}),
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	if (!hasPendingWork) {
		notify(ctx, "no actionable findings after orchestrator synthesis", "info");
	} else {
		const parts: string[] = [];
		if (autoApplied.length > 0)
			parts.push(`${autoApplied.length} fix(es) queued`);
		if (surfaced.length > 0)
			parts.push(`${surfaced.length} finding(s) for discussion`);
		notify(ctx, parts.join(", "), "info");
	}

	return {
		ran: true,
		scopeLabel: rc.scopeLabel,
		findings,
		autoApplied,
		surfaced,
		orchestratorRan,
		...(orchError ? { orchestratorError: orchError } : {}),
		staticToolsRan,
		primaryModel: orchestratorSpec,
		...(consultSpec ? { secondaryModel: consultSpec } : {}),
		laneModels: laneModelSummary,
		...(indexError ? { indexError } : {}),
		errors,
	};
}
