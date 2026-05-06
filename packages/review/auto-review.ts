/**
 * Auto-review pass — used by `/develop` after auto-verify completes.
 *
 * Unlike interactive `/review`, the auto-review:
 *   - Runs ONLY the `code-reviewer` and `code-simplifier` lanes.
 *     Architect / scope / security / docs / deps are all out of
 *     scope here (the user opted into a focused, auto-applied pass).
 *   - Runs each lane TWICE: once against `backgroundModels.primary.heavy`,
 *     once against `backgroundModels.secondary.heavy`. Both must agree
 *     on a finding (cross-model consensus) before it is eligible for
 *     auto-application.
 *   - Has NO interactive walk-through. Findings the two model tiers
 *     agree on are queued for the host agent as a single fix prompt
 *     directly; everything else is dropped (the manual `/review`
 *     command is still available for the broader pass).
 *
 * Wired in by `/develop` between `loop-complete`/`loop-bailed` and
 * the post-loop picker. `/develop` owns the state-machine plumbing;
 * this module owns the model resolution, fan-out, consensus filtering,
 * and fix-prompt assembly.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type {
	BackgroundSet,
	Tier,
} from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import {
	type BackgroundTier,
	crossModelConsensus,
	dedupeFindings,
	type Finding,
	type FindingsBundle,
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
import { runReviewer } from "./reviewer-client.js";

/**
 * The two reviewer roles the auto-review covers. Deliberately narrow:
 * the auto-apply path means we trade breadth for high-confidence
 * mechanical fixes only.
 */
export const AUTO_REVIEW_ROLES: readonly ReviewerRole[] = [
	"code-reviewer",
	"code-simplifier",
] as const;

/** Fixed tier this pass uses on both `primary` and `secondary` sets. */
const AUTO_REVIEW_TIER: Tier = "heavy";

const AUTO_REVIEW_WIDGET = "auto-review-progress";

/** Diff scope the auto-review operates on. Matches `/review`'s scopes
 *  but narrowed to the two relevant in-branch contexts: `/develop`
 *  always runs after a sequence of edits on a feature branch, so we
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
	 *  to "develop" because that's where the call site lives. */
	extensionName?: string;
	/**
	 * Reviewer roles to run. Defaults to `AUTO_REVIEW_ROLES`.
	 * Strings are cast to `ReviewerRole`; unknown values are silently
	 * dropped by the role-not-found path in `buildTaskFor`.
	 */
	roles?: string[];
	/**
	 * When true (default), run each role on both `primary.heavy` and
	 * `secondary.heavy` and require cross-model consensus before
	 * auto-applying. When false, run only `primary.heavy` and apply
	 * any finding that has a `suggestedAction`.
	 */
	multiModel?: boolean;
}

export type AutoReviewAbortReason =
	| "not-git"
	| "no-diff"
	| "no-primary-model"
	| "no-secondary-model"
	| "fanout-error";

export interface RunAutoReviewResult {
	ran: boolean;
	abortReason?: AutoReviewAbortReason;
	scopeLabel?: string;
	/** Every deduped finding (with tier metadata) — diagnostic. */
	findings?: Finding[];
	/** Subset auto-eligible: cross-model consensus + concrete fix. */
	autoApplied?: Finding[];
	/** Models actually used (for the report message). */
	primaryModel?: string;
	secondaryModel?: string;
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

function buildTaskFor(role: ReviewerRole, rc: AutoReviewContext): string {
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

/**
 * Build the fix prompt the host agent receives once we have the
 * cross-model-consensus findings in hand. Mirrors the shape of
 * `/review`'s `buildFixPrompt` but trims the "explain" bucket
 * (auto-review never asks for explanations) and adds an explicit
 * "two heavy models independently agreed" context line so the agent
 * understands the unusually high confidence.
 */
export function buildAutoReviewFixPrompt(
	accepted: readonly Finding[],
	primaryModel: string,
	secondaryModel?: string,
): string {
	const reviewerDesc = secondaryModel
		? `Two heavy reviewers (\`${primaryModel}\` and \`${secondaryModel}\`) independently flagged the following findings on the same file/line/title. Apply the suggested fixes directly.`
		: `The reviewer (\`${primaryModel}\`) flagged the following findings with concrete fix suggestions. Apply them directly.`;
	const lines: string[] = [
		"[/develop auto-review]",
		"",
		reviewerDesc,
		"Group related fixes into cohesive commits, but do not commit",
		"until the user says so.",
		"",
	];
	accepted.forEach((f, idx) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		const lanes = f.flaggedBy.join(", ");
		lines.push(
			`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
			`   - Lanes: ${lanes}`,
			`   - Why: ${f.description}`,
		);
		if (f.suggestedAction) {
			lines.push(`   - Fix: ${f.suggestedAction}`);
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
	findings: readonly Finding[];
	autoApplied: readonly Finding[];
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
		lines.push(`**Mode**: cross-model consensus (both must agree)`);
	} else {
		lines.push(`**Model**: \`${opts.primaryModel}\``);
		lines.push(`**Mode**: single-model`);
	}
	lines.push("");
	const totalFindings = opts.findings.length;
	const agreed = opts.autoApplied.length;
	const disagreed = totalFindings - agreed;
	if (opts.multiModel) {
		lines.push(
			`**Findings**: ${totalFindings} total · ${agreed} cross-model agreed · ${disagreed} flagged by only one tier (dropped)`,
		);
	} else {
		lines.push(
			`**Findings**: ${totalFindings} total · ${agreed} with concrete fix (auto-applying) · ${disagreed} without fix suggestion (dropped)`,
		);
	}
	if (opts.errors.length > 0) {
		lines.push(
			`**Reviewer errors**: ${opts.errors.length} (the affected lane was treated as empty)`,
		);
	}
	if (agreed === 0) {
		lines.push("");
		if (opts.multiModel) {
			lines.push(
				"No cross-model consensus findings. Nothing to auto-apply.",
				"Run `/review` for the full seven-lane interactive walk-through if",
				"you want to look at the per-tier flags individually.",
			);
		} else {
			lines.push(
				"No findings with concrete fix suggestions. Nothing to auto-apply.",
				"Run `/review` for the full seven-lane interactive walk-through.",
			);
		}
		return lines.join("\n");
	}
	lines.push("");
	lines.push("### Auto-applying:");
	lines.push("");
	opts.autoApplied.forEach((f, idx) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		lines.push(
			`${idx + 1}. [${f.severity}] \`${loc}\` — ${f.title} (${f.flaggedBy.join(", ")})`,
		);
	});
	return lines.join("\n");
}

/**
 * Public entry point. Resolves both heavy models, runs the four
 * subagents in parallel, computes cross-model consensus, sends a
 * report message + (when there are agreed findings) a fix-followup
 * to the host agent, and returns a structured result for the caller.
 *
 * The caller (`/develop`) is responsible for state-machine
 * bookkeeping: deciding whether to wait for the host fix turn before
 * showing the post-loop picker. This function never opens a picker
 * and never blocks on user input.
 */
export async function runAutoReview(
	opts: RunAutoReviewOptions,
): Promise<RunAutoReviewResult> {
	const { ctx, pi } = opts;
	const extensionName = opts.extensionName ?? "develop";

	if (!isGitRepo(ctx.cwd)) {
		notify(ctx, "not inside a git repository", "error");
		return { ran: false, abortReason: "not-git" };
	}

	const rc = resolveAutoReviewContext(ctx);
	if ("error" in rc) {
		notify(ctx, rc.error, "info");
		return { ran: false, abortReason: "no-diff" };
	}

	const roles = (
		opts.roles?.length ? opts.roles : AUTO_REVIEW_ROLES
	) as ReviewerRole[];
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
					task: buildTaskFor(inv.role, rc),
					provider: inv.provider,
					model: inv.modelId,
					cwd: ctx.cwd,
					signal: ctx.signal,
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

	const bundles: FindingsBundle[] = outcomes.map((o) => ({
		role: o.role,
		findings: o.findings,
		tier: o.tier,
	}));
	const findings = dedupeFindings(bundles);
	// Auto-apply: in multi-model mode, require cross-model consensus.
	// In single-model mode, apply any finding with a concrete fix.
	const withFix = (f: Finding) =>
		f.suggestedAction !== undefined && f.suggestedAction.trim() !== "";
	const autoApplied = multiModel
		? crossModelConsensus(findings).filter(withFix)
		: findings.filter(withFix);

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
				errors,
			}),
			display: true,
			details: {
				scopeLabel: rc.scopeLabel,
				totalFindings: findings.length,
				autoApplied: autoApplied.length,
				primaryModel: primary.spec,
				...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
				errorCount: errors.length,
			},
		},
		{ triggerTurn: false },
	);

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
			{ deliverAs: "followUp", triggerTurn: true },
		);
		const howMany = multiModel
			? `${autoApplied.length} cross-model agreed finding(s)`
			: `${autoApplied.length} finding(s) with suggested fix(es)`;
		notify(ctx, `${howMany} handed to the host agent`, "info");
	} else {
		const msg = multiModel
			? "no cross-model consensus — nothing to apply"
			: "no findings with suggested fixes — nothing to apply";
		notify(ctx, msg, "info");
	}

	return {
		ran: true,
		scopeLabel: rc.scopeLabel,
		findings,
		autoApplied,
		primaryModel: primary.spec,
		...(secondarySpec ? { secondaryModel: secondarySpec } : {}),
		errors,
	};
}
