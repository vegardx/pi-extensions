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
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	ModelRegistry,
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

/** Fixed tier this pass uses on both `primary` and `secondary` sets. */
const AUTO_REVIEW_TIER: Tier = "heavy";

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

interface AutoReviewContext {
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
	 * When true (default), run each role on both `primary.heavy` and
	 * `secondary.heavy`, then synthesise with the orchestrator. When
	 * false, run only `primary.heavy`; the orchestrator still runs but
	 * has only one tier's findings.
	 */
	multiModel?: boolean;
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
	/** Models actually used (for the report message). */
	primaryModel?: string;
	secondaryModel?: string;
	/** True when the orchestrator agent ran and produced parseable output. */
	orchestratorRan?: boolean;
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

function buildTaskFor(
	role: ReviewerRole,
	rc: AutoReviewContext,
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

interface ResolvedTierModel {
	tier: BackgroundTier;
	provider: string;
	modelId: string;
	spec: string;
}

async function resolveTierModel(
	ctx: ExtensionContext,
	extensionName: string,
	tier: BackgroundTier,
): Promise<ResolvedTierModel | null> {
	const set: BackgroundSet = tier;
	const resolved = await resolveModel(ctx, {
		name: extensionName,
		tier: AUTO_REVIEW_TIER,
		set,
	});
	if (!resolved) return null;
	return {
		tier,
		provider: resolved.model.provider,
		modelId: resolved.model.id,
		spec: `${resolved.model.provider}/${resolved.model.id}`,
	};
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
	primary: ResolvedTierModel;
	/** When provided, the orchestrator gets a `consult_secondary_model`
	 *  custom tool it can call for uncertain CRITICAL findings. */
	secondary: ResolvedTierModel | null;
	extensionName: string;
	ctx: ExtensionContext;
	signal?: AbortSignal;
}): Promise<{
	findings: OrchestratedFinding[];
	orchestratorRan: boolean;
	error?: string;
}> {
	const { bundles, rc, primary, secondary, extensionName, ctx } = opts;

	const totalInputFindings = bundles.reduce((n, b) => n + b.findings.length, 0);

	if (totalInputFindings === 0) {
		return { findings: [], orchestratorRan: false };
	}

	notify(
		ctx,
		`orchestrator: synthesising ${totalInputFindings} raw finding(s)${
			secondary ? " (consult tool available)" : ""
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

	// ---- Build consultation tool (if secondary model available) ----------
	//
	// The orchestrator can call this tool for any CRITICAL finding it is
	// uncertain about. The secondary model evaluates the finding using the
	// challenger system prompt and returns its verdict as a JSON string.
	// The orchestrator reads the response and adjusts confidence accordingly.
	const customTools = secondary
		? [
				defineTool({
					name: "consult_secondary_model",
					label: "Consult Secondary Model",
					description:
						"Ask the secondary reviewer model whether it agrees with a finding " +
						"you are uncertain about. The secondary model has independent code " +
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
						// Tool is only registered when secondary != null;
						// guard defensively so TypeScript/biome are happy.
						if (!secondary) {
							return {
								content: [
									{
										type: "text" as const,
										text: '{"agree":false,"reason":"secondary model unavailable"}',
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
							provider: secondary.provider,
							model: secondary.modelId,
							cwd: ctx.cwd,
							signal,
							timeoutMs: reviewTimeoutMs(rc.diff.length),
						});

						const text = out.error
							? `{"agree":false,"reason":"consultation error: ${out.error.slice(0, 100)}"}`
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
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const model = modelRegistry.find(primary.provider, primary.modelId);

	if (!model) {
		const err = `orchestrator: could not resolve model ${primary.spec} from registry`;
		notify(ctx, err, "warning");
		if (ctx.hasUI) {
			ctx.ui.setStatus(extensionName, undefined);
			ctx.ui.setWidget(AUTO_REVIEW_WIDGET, undefined);
		}
		return { findings: [], orchestratorRan: false, error: err };
	}

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
		model,
		// Read-only built-in tools + the optional consult custom tool.
		tools: ["read", "grep", "find", "ls"],
		customTools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(ctx.cwd),
		authStorage,
		modelRegistry,
	});

	const task = buildOrchestratorTask(bundles, rc);

	try {
		const promptPromise = session.prompt(task);
		const timeoutPromise = new Promise<never>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error("orchestrator timeout")),
				timeoutMs,
			);
			opts.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					reject(new Error("aborted"));
				},
				{ once: true },
			);
		});

		await Promise.race([promptPromise, timeoutPromise]);
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

/**
 * Build the fix prompt the host agent receives once the orchestrator
 * has produced high-confidence findings with concrete fix suggestions.
 */
export function buildAutoReviewFixPrompt(
	accepted: readonly OrchestratedFinding[],
	primaryModel: string,
	secondaryModel?: string,
): string {
	const reviewerDesc = secondaryModel
		? `The review orchestrator (\`${primaryModel}\` synthesising \`${primaryModel}\` + \`${secondaryModel}\` reviewer output) flagged the following high-confidence findings. Apply the suggested fixes directly.`
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
		lines.push(
			`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
			`   - Confidence: ${conf} | Roles: ${roles}`,
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
	staticToolsRan: number;
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
		lines.push(`**Primary model**: \`${opts.primaryModel}\``);
		lines.push(`**Secondary model**: \`${opts.secondaryModel}\``);
		lines.push(`**Mode**: multi-model + orchestrator synthesis`);
	} else {
		lines.push(`**Model**: \`${opts.primaryModel}\``);
		lines.push(`**Mode**: single-model + orchestrator synthesis`);
	}
	if (opts.staticToolsRan > 0) {
		lines.push(`**Static analysis**: ${opts.staticToolsRan} tool(s) ran`);
	}
	lines.push("");
	const totalFindings = opts.findings.length;
	const autoCount = opts.autoApplied.length;
	const surfacedCount = opts.surfaced.length;
	const dropped = totalFindings - autoCount - surfacedCount;
	lines.push(
		`**Findings**: ${totalFindings} total · ${autoCount} auto-applying · ${surfacedCount} for discussion · ${dropped} low-confidence (dropped)`,
	);
	if (!opts.orchestratorRan) {
		lines.push("**Orchestrator**: did not run or produced no parseable output");
	}
	if (opts.errors.length > 0) {
		lines.push(
			`**Reviewer errors**: ${opts.errors.length} (the affected lane was treated as empty)`,
		);
	}
	if (autoCount === 0 && surfacedCount === 0) {
		lines.push("");
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
			lines.push(
				`${idx + 1}. [${f.severity}] \`${loc}\` — ${f.title} (${f.confirmedByRoles.join(", ") || "orchestrator"})${staticTag}`,
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
			lines.push(
				`${idx + 1}. [${f.severity}] \`${loc}\` — ${f.title} (${f.confirmedByRoles.join(", ") || "orchestrator"})${confTag}${staticTag}`,
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
		lines.push(
			`${idx + 1}. **[${f.severity}] \`${loc}\`** \u2014 ${f.title}${conf}`,
			`   - Roles: ${f.confirmedByRoles.join(", ") || "orchestrator"}`,
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
 * Public entry point. Resolves both heavy models, runs Phase 0 static
 * analysis, fans out to role reviewers in parallel, then runs the
 * orchestrator agent to synthesise findings.
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
	const multiModel = opts.multiModel ?? true;

	const primary = await resolveTierModel(ctx, extensionName, "primary");
	if (!primary) {
		notify(
			ctx,
			"no usable primary heavy model (set backgroundModels.primary.heavy)",
			"warning",
		);
		return {
			ran: false,
			abortReason: "no-primary-model",
			scopeLabel: rc.scopeLabel,
		};
	}
	let secondary: ResolvedTierModel | null = null;
	if (multiModel) {
		secondary = await resolveTierModel(ctx, extensionName, "secondary");
		if (!secondary) {
			notify(
				ctx,
				"no usable secondary heavy model (set backgroundModels.secondary.heavy)",
				"warning",
			);
			return {
				ran: false,
				abortReason: "no-secondary-model",
				scopeLabel: rc.scopeLabel,
				primaryModel: primary.spec,
			};
		}
	}

	const tierModels = multiModel && secondary ? [primary, secondary] : [primary];

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

	notify(
		ctx,
		`${rc.scopeLabel}: ${rc.changedFiles} file(s), fanning out ${roles.length * tierModels.length} reviewers (${primary.spec}${secondary ? ` + ${secondary.spec}` : ""})`,
		"info",
	);

	const status = new Map<string, "running" | "done">();
	const invocations: Array<ReviewerInvocationKey & ResolvedTierModel> = [];
	for (const role of roles) {
		for (const tierModel of tierModels) {
			invocations.push({ role: role as ReviewerRole, ...tierModel });
			status.set(`${role}|${tierModel.tier}`, "running");
		}
	}
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
						staticFindings.byLane.get(
							inv.role as
								| "code-reviewer"
								| "security-analyst"
								| "code-simplifier",
						),
					),
					provider: inv.provider,
					model: inv.modelId,
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
			primaryModel: primary.spec,
			...(secondary ? { secondaryModel: secondary.spec } : {}),
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
			tier: "primary" as BackgroundTier,
			findings: allStaticFindings,
		});
	}

	// ---- Phase 2: Orchestrator -------------------------------------------
	const {
		findings,
		orchestratorRan,
		error: orchError,
	} = await runOrchestratorPhase({
		bundles: orchestratorBundles,
		rc,
		primary,
		secondary,
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
	//   orchestrator should have called consult_secondary_model, but if
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
		// High/medium without a fix
		if (isHighOrMedium(f) && !withFix(f)) return true;
		// Low-confidence CRITICAL: the orchestrator consulted and still
		// wasn't sure — surface rather than drop.
		if (f.confidence === "low" && f.severity === "CRITICAL") return true;
		return false;
	});

	const secondarySpec = secondary?.spec;
	pi.sendMessage(
		{
			customType: "auto-review-report",
			content: buildAutoReviewReport({
				scopeLabel: rc.scopeLabel,
				roles: roles as readonly string[],
				multiModel,
				primaryModel: primary.spec,
				...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
				findings,
				autoApplied,
				surfaced,
				orchestratorRan,
				staticToolsRan,
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
				primaryModel: primary.spec,
				...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
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
					primary.spec,
					secondarySpec,
				),
				display: false,
				details: {
					autoApplied: autoApplied.length,
					primaryModel: primary.spec,
					...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
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
					primary.spec,
					secondarySpec,
				),
				display: false,
				details: {
					surfaced: surfaced.length,
					primaryModel: primary.spec,
					...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
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
		staticToolsRan,
		primaryModel: primary.spec,
		...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
		errors,
	};
}
