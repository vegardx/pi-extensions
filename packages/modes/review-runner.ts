/**
 * review-runner — batch review system with consensus + cross-validation.
 *
 * Flow:
 *   1. Warm up agents at /implement time (build codebase context)
 *   2. At plan-complete, send the full branch diff for review
 *   3. Collect findings, deduplicate, run consensus algorithm
 *   4. Cross-validate disputed critical/high findings in parallel
 *   5. Return classified findings for triage dialog
 */

import type {
	BackgroundTier,
	Finding,
	ReviewerRole,
} from "pi-ext-review/findings";

// ---- Types ----------------------------------------------------------------

export const REVIEW_ROLES: ReviewerRole[] = [
	"code-reviewer",
	"code-simplifier",
	"security-analyst",
];

export interface ReviewModel {
	provider: string;
	model: string;
	tier: BackgroundTier;
}

export interface ReviewRunnerConfig {
	roles: ReviewerRole[];
	primary: ReviewModel;
	secondary?: ReviewModel;
	cwd: string;
	signal?: AbortSignal;
}

export interface ReviewProgress {
	/** Total number of reviewer invocations (roles × models). */
	total: number;
	/** Number completed so far. */
	completed: number;
	/** Per-agent status. */
	agents: AgentStatus[];
}

export interface AgentStatus {
	role: ReviewerRole;
	tier: BackgroundTier;
	status: "warming" | "reviewing" | "done" | "error";
	findingCount?: number;
	error?: string;
}

/** Classified findings after consensus + cross-validation. */
export interface ClassifiedFindings {
	/** Findings with consensus (2+ agents agree) — will be auto-fixed. */
	consensus: Finding[];
	/** Disputed critical/high findings cross-validated and confirmed. */
	confirmed: Finding[];
	/** Disputed critical/high findings where cross-validation disagreed — surface to user. */
	disputed: Finding[];
	/** Skipped findings (single-agent, low severity, or cross-validation rejected). */
	skipped: Finding[];
	/** Errors from agents that failed. */
	errors: Array<{ role: ReviewerRole; tier: BackgroundTier; error: string }>;
}

/** Result of a single cross-validation challenge. */
export interface ChallengeResult {
	finding: Finding;
	agree: boolean;
	reason: string;
	suggestedAction?: string;
}

// ---- Consensus algorithm (pure, testable) ---------------------------------

/**
 * Classify deduped findings into consensus / needs-challenge / skip.
 * Pure function — no I/O.
 */
export function classifyFindings(findings: readonly Finding[]): {
	consensus: Finding[];
	needsChallenge: Finding[];
	skip: Finding[];
} {
	const consensus: Finding[] = [];
	const needsChallenge: Finding[] = [];
	const skip: Finding[] = [];

	for (const f of findings) {
		if (f.consensus || f.crossModelConsensus) {
			// 2+ agents or cross-model agreement → auto-fix.
			consensus.push(f);
		} else if (f.severity === "CRITICAL" || f.severity === "IMPORTANT") {
			// Single-agent, high severity → needs cross-validation.
			needsChallenge.push(f);
		} else {
			// Single-agent, low severity → skip.
			skip.push(f);
		}
	}

	return { consensus, needsChallenge, skip };
}

/**
 * After cross-validation, partition challenged findings into confirmed
 * (challenger agreed), disputed (challenger disagreed but original was
 * critical), and rejected (disagreed, not critical enough to surface).
 */
export function partitionChallengeResults(
	results: readonly ChallengeResult[],
): { confirmed: Finding[]; disputed: Finding[] } {
	const confirmed: Finding[] = [];
	const disputed: Finding[] = [];

	for (const r of results) {
		if (r.agree) {
			// Challenger confirmed — promote to fix.
			if (r.suggestedAction && !r.finding.suggestedAction) {
				r.finding.suggestedAction = r.suggestedAction;
			}
			confirmed.push(r.finding);
		} else {
			// Challenger disagreed — surface CRITICAL to user, skip IMPORTANT.
			if (r.finding.severity === "CRITICAL") {
				disputed.push(r.finding);
			}
			// IMPORTANT findings rejected by cross-validation are dropped.
		}
	}

	return { confirmed, disputed };
}

// ---- Review task builder --------------------------------------------------

export function buildReviewTask(opts: {
	diff: string;
	changedFiles: string[];
	scopeLabel: string;
}): string {
	const lines: string[] = [
		`Scope: ${opts.scopeLabel}. ${opts.changedFiles.length} changed files.`,
		"",
		"Changed files:",
		...opts.changedFiles.slice(0, 100).map((f) => `- ${f}`),
	];
	if (opts.changedFiles.length > 100) {
		lines.push(`… and ${opts.changedFiles.length - 100} more.`);
	}
	lines.push("");
	lines.push("Scope: diff. Review only the lines the diff touches.");
	lines.push("");
	lines.push("Unified diff:");
	lines.push("```diff");
	lines.push(opts.diff.trimEnd());
	lines.push("```");
	lines.push("");
	lines.push(
		"If nothing in this diff falls within your lane, reply `[]` and stop.",
		"Otherwise, emit JSON per your system prompt.",
	);
	return lines.join("\n");
}

export function buildWarmUpTask(opts: {
	planText: string;
	changedFiles: string[];
}): string {
	return [
		"You will shortly be reviewing a code change. Prepare by reading",
		"the relevant areas of the codebase described below.",
		"",
		"## Plan being implemented",
		"",
		opts.planText.trim(),
		"",
		"## Files likely affected",
		"",
		...opts.changedFiles.slice(0, 50).map((f) => `- ${f}`),
		"",
		"Use your read/grep/find/ls tools to build context in the areas",
		"this plan touches. Do NOT produce any output yet — just explore.",
		"You will receive the actual diff to review in a follow-up message.",
	].join("\n");
}

export function buildChallengeTask(opts: {
	finding: Finding;
	diff: string;
}): string {
	return [
		"## Finding to validate",
		"",
		`**File:** ${opts.finding.file}${opts.finding.line ? `:${opts.finding.line}` : ""}`,
		`**Severity:** ${opts.finding.severity}`,
		`**Title:** ${opts.finding.title}`,
		`**Description:** ${opts.finding.description}`,
		...(opts.finding.suggestedAction
			? [`**Suggested fix:** ${opts.finding.suggestedAction}`]
			: []),
		"",
		`**Raised by:** ${opts.finding.flaggedBy.join(", ")}`,
		"",
		"## Diff context",
		"",
		"```diff",
		opts.diff.trimEnd(),
		"```",
	].join("\n");
}

// ---- Fix prompt builder ---------------------------------------------------

export function buildFixPrompt(findings: readonly Finding[]): string {
	const items = findings.map((f, i) => {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		const parts = [
			`${i + 1}. **[${f.severity}]** ${f.title}`,
			`   Location: \`${loc}\``,
			`   ${f.description}`,
		];
		if (f.suggestedAction) {
			parts.push(`   Suggested fix: ${f.suggestedAction}`);
		}
		return parts.join("\n");
	});

	return [
		"The following review findings need to be fixed before committing.",
		"Address each one. Run tests after fixing to ensure nothing breaks.",
		"",
		...items,
	].join("\n");
}
