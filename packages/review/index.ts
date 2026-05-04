import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	countBySeverity,
	dedupeFindings,
	type Finding,
	type RawFinding,
	type Recommendation,
	type ReviewerRole,
	recommendationFor,
	type Severity,
} from "./findings.js";
import {
	detectDefaultBranch,
	diffStat,
	filesInDiff,
	getBranchDiff,
	getFileDiff,
	getStagedDiff,
	getWorkingDiff,
	isGitRepo,
	listTrackedFiles,
} from "./git.js";
import { runReviewer } from "./reviewer-client.js";
import { parseScope, type ReviewMode, type ReviewScope } from "./scope.js";

const EXT_ID = "review";

/**
 * The seven specialist reviewer roles. Every role receives the same scope
 * (diff or whole codebase) and decides for itself whether anything in its
 * lane applies — if not, it returns `[]`. The scope-handling rules are
 * defined identically in every prompt under `prompts/`.
 */
const ALL_ROLES: readonly ReviewerRole[] = [
	"architect",
	"code-reviewer",
	"scope-analyst",
	"security-analyst",
	"code-simplifier",
	"doc-reviewer",
	"dependency-checker",
] as const;

interface ReviewContext {
	scope: ReviewScope;
	diff: string;
	files: string[];
	/** Human-readable scope summary for the report header. */
	scopeLabel: string;
	changedFiles: number;
	additions: number;
	deletions: number;
}

export default function (pi: ExtensionAPI) {
	function notify(
		ctx: ExtensionContext,
		msg: string,
		level: "info" | "warning" | "error" = "info",
	): void {
		if (ctx.hasUI) ctx.ui.notify(`review: ${msg}`, level);
	}

	// ---- Scope resolution (I/O wrapper around parseScope) -------------------
	function resolveContext(
		ctx: ExtensionContext,
		scope: ReviewScope,
	): ReviewContext | { error: string } {
		const cwd = ctx.cwd;
		switch (scope.mode) {
			case "working": {
				const diff = getWorkingDiff(cwd);
				if (!diff.trim()) {
					return {
						error:
							"no unstaged or staged changes to review. Pass --all, --branch, or a file path to review more.",
					};
				}
				const stat = diffStat(cwd);
				return {
					scope,
					diff,
					files: filesInDiff(diff),
					scopeLabel: "working tree (unstaged + staged)",
					changedFiles: stat.changedFiles,
					additions: stat.additions,
					deletions: stat.deletions,
				};
			}
			case "staged": {
				const diff = getStagedDiff(cwd);
				if (!diff.trim()) return { error: "no staged changes to review." };
				// `git diff --shortstat --cached` uses a different path than diffStat's
				// default; just derive from the diff itself for count accuracy.
				const stat = diffStat(cwd);
				return {
					scope,
					diff,
					files: filesInDiff(diff),
					scopeLabel: "staged changes",
					changedFiles: stat.changedFiles,
					additions: stat.additions,
					deletions: stat.deletions,
				};
			}
			case "branch": {
				const defaultBranch = detectDefaultBranch(cwd);
				if (!defaultBranch) {
					return {
						error:
							"could not detect a default branch — pass --staged / a file path instead.",
					};
				}
				const diff = getBranchDiff(cwd, defaultBranch);
				if (!diff.trim()) {
					return {
						error: `no changes on the current branch vs. ${defaultBranch}.`,
					};
				}
				const stat = diffStat(cwd, `${defaultBranch}...HEAD`);
				return {
					scope,
					diff,
					files: filesInDiff(diff),
					scopeLabel: `current branch vs. ${defaultBranch}`,
					changedFiles: stat.changedFiles,
					additions: stat.additions,
					deletions: stat.deletions,
				};
			}
			case "all": {
				const files = listTrackedFiles(cwd);
				if (files.length === 0) {
					return { error: "no tracked files found — is this an empty repo?" };
				}
				return {
					scope,
					diff: "",
					files,
					scopeLabel: "whole codebase",
					changedFiles: files.length,
					additions: 0,
					deletions: 0,
				};
			}
			case "file": {
				if (scope.paths.length === 0) {
					return { error: "file scope but no paths provided (internal bug)." };
				}
				const diff = getFileDiff(cwd, scope.paths);
				if (!diff.trim()) {
					return {
						error: `no changes detected in: ${scope.paths.join(", ")}`,
					};
				}
				const stat = diffStat(cwd);
				return {
					scope,
					diff,
					files:
						filesInDiff(diff).length > 0 ? filesInDiff(diff) : [...scope.paths],
					scopeLabel: `paths: ${scope.paths.join(", ")}`,
					changedFiles: stat.changedFiles,
					additions: stat.additions,
					deletions: stat.deletions,
				};
			}
			default: {
				const _exhaustive: never = scope.mode;
				return { error: `unknown review mode: ${_exhaustive}` };
			}
		}
	}

	// ---- Task payload builders ---------------------------------------------
	function buildTaskFor(role: ReviewerRole, rc: ReviewContext): string {
		const scopeLine =
			rc.scope.mode === "all"
				? `Scope: whole codebase (${rc.files.length} tracked files).`
				: `Scope: ${rc.scopeLabel}. ${rc.changedFiles} changed files, ` +
					`+${rc.additions} / -${rc.deletions}.`;
		const lines: string[] = [
			`Role: ${role}`,
			scopeLine,
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
		if (rc.scope.mode === "all") {
			lines.push(
				"Scope: whole codebase. Use your read/grep/find/ls tools to examine",
				"whatever slice is relevant to your lane. Do not assume any particular",
				"file is more important than others without evidence.",
			);
		} else {
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
		}
		return lines.join("\n");
	}

	// ---- Fan-out -----------------------------------------------------------
	async function runAllReviewers(
		ctx: ExtensionCommandContext,
		rc: ReviewContext,
	): Promise<{
		bundles: Array<{ role: ReviewerRole; findings: RawFinding[] }>;
		errors: Array<{ role: ReviewerRole; error: string }>;
	}> {
		const model = ctx.model;
		if (!model) {
			throw new Error(
				"no active model — /review uses the main agent's model, set one first.",
			);
		}
		const roles: ReviewerRole[] = [...ALL_ROLES];

		let completed = 0;
		ctx.ui.setStatus(EXT_ID, `reviewing 0/${roles.length}`);

		const results = await Promise.all(
			roles.map(async (role) => {
				const outcome = await runReviewer({
					role,
					task: buildTaskFor(role, rc),
					provider: model.provider,
					model: model.id,
					cwd: ctx.cwd,
					signal: ctx.signal,
				});
				completed++;
				ctx.ui.setStatus(EXT_ID, `reviewing ${completed}/${roles.length}`);
				return outcome;
			}),
		);

		ctx.ui.setStatus(EXT_ID, undefined);

		const bundles = results.map((r) => ({
			role: r.role,
			findings: r.findings,
		}));
		const errors = results
			.filter((r) => r.error)
			.map((r) => ({ role: r.role, error: r.error as string }));
		return { bundles, errors };
	}

	// ---- Report + walkthrough ---------------------------------------------
	function buildReport(
		rc: ReviewContext,
		findings: readonly Finding[],
	): string {
		const counts = countBySeverity(findings);
		return [
			"",
			"## Review Report",
			"",
			`**Scope**: ${rc.scopeLabel}`,
			`**Files**: ${rc.changedFiles} changed, +${rc.additions} / -${rc.deletions}`,
			`**Agents**: ${ALL_ROLES.join(", ")}`,
			"",
			"| Severity | Count |",
			"|----------|-------|",
			`| CRITICAL | ${counts.CRITICAL} |`,
			`| IMPORTANT | ${counts.IMPORTANT} |`,
			`| NOTE | ${counts.NOTE} |`,
			"",
		].join("\n");
	}

	function formatFinding(n: number, total: number, f: Finding): string {
		const loc = f.line ? `${f.file}:${f.line}` : f.file;
		const flagged = f.flaggedBy.join(", ");
		const consensus = f.consensus ? " _(consensus)_" : "";
		const parts = [
			`## [${n}/${total}] ${f.severity} — ${f.title}`,
			"",
			`**Location**: \`${loc}\``,
			`**Flagged by**: ${flagged}${consensus}`,
			"",
			f.description,
		];
		if (f.suggestedAction) {
			parts.push("", `**Suggested action**: ${f.suggestedAction}`);
		}
		const rec = recommendationFor(f);
		if (rec) {
			// Nudge toward the picker option we think is best, with the reasoning
			// up-front so the user can override with eyes open.
			const verb = rec.action === "accept" ? "Accept" : "Explain";
			parts.push(
				"",
				`**Confidence**: high — recommending **${verb}** (${rec.reasons.join(", ")}).`,
			);
		}
		return parts.join("\n");
	}

	/**
	 * Build the three picker options, optionally tagging one with
	 * “(Recommended)” based on the finding's confidence-based recommendation.
	 */
	function pickerOptions(rec: Recommendation | null): string[] {
		const accept = "Accept — queue the suggested fix";
		const skip = "Skip — move to the next finding";
		const explain = "Explain — have the agent walk me through this one";
		if (rec?.action === "accept") {
			return [`${accept} (Recommended)`, skip, explain];
		}
		if (rec?.action === "explain") {
			return [accept, skip, `${explain} (Recommended)`];
		}
		return [accept, skip, explain];
	}

	/**
	 * Walk every finding and ask the user to accept / skip / explain it.
	 * NOTEs are presented en-bloc first as read-only observations; the user
	 * gets the option to promote them into the accept/skip flow later.
	 */
	async function walkFindings(
		ctx: ExtensionCommandContext,
		findings: readonly Finding[],
	): Promise<{ accepted: Finding[]; explainRequests: Finding[] }> {
		const accepted: Finding[] = [];
		const explainRequests: Finding[] = [];
		const actionable = findings.filter((f) => f.severity !== "NOTE");
		const notes = findings.filter((f) => f.severity === "NOTE");

		// Render NOTEs up-front as a single batch.
		if (notes.length > 0) {
			const lines = [
				`## ${notes.length} NOTE finding(s)`,
				"",
				...notes.map(
					(n) =>
						`- \`${n.file}${n.line ? `:${n.line}` : ""}\` (${n.flaggedBy.join(", ")}) — ${n.title}`,
				),
				"",
				"Notes are informational; they can be promoted into the fix batch after the main walk-through.",
			];
			pi.sendMessage(
				{
					customType: EXT_ID,
					content: lines.join("\n"),
					display: true,
				},
				{ deliverAs: "steer" },
			);
		}

		for (let i = 0; i < actionable.length; i++) {
			const f = actionable[i];
			if (!f) continue;
			pi.sendMessage(
				{
					customType: EXT_ID,
					content: formatFinding(i + 1, actionable.length, f),
					display: true,
				},
				{ deliverAs: "steer" },
			);
			const choice = await ctx.ui.select(
				`${f.severity}: ${f.title.slice(0, 60)}`,
				pickerOptions(recommendationFor(f)),
			);
			if (!choice) {
				// ESC / timeout — treat as skip so we don't hang indefinitely.
				continue;
			}
			if (choice.startsWith("Accept")) accepted.push(f);
			else if (choice.startsWith("Explain")) explainRequests.push(f);
		}

		// After the main walk, offer to promote NOTEs.
		if (notes.length > 0) {
			const promote = await ctx.ui.confirm(
				"Promote NOTE findings?",
				`There are ${notes.length} NOTE finding(s). Walk through them with Accept/Skip?`,
			);
			if (promote) {
				for (let i = 0; i < notes.length; i++) {
					const f = notes[i];
					if (!f) continue;
					pi.sendMessage(
						{
							customType: EXT_ID,
							content: formatFinding(i + 1, notes.length, f),
							display: true,
						},
						{ deliverAs: "steer" },
					);
					const choice = await ctx.ui.select(
						`NOTE: ${f.title.slice(0, 60)}`,
						pickerOptions(recommendationFor(f)),
					);
					if (!choice) continue;
					if (choice.startsWith("Accept")) accepted.push(f);
					else if (choice.startsWith("Explain")) explainRequests.push(f);
				}
			}
		}

		return { accepted, explainRequests };
	}

	// ---- Hand fixes back to the agent --------------------------------------
	function buildFixPrompt(
		accepted: readonly Finding[],
		explain: readonly Finding[],
	): string {
		const lines: string[] = [
			"The user has walked the /review findings and made the following decisions.",
			"Apply the accepted fixes directly (edit/write) and stage them when done.",
			"Group related fixes into cohesive commits — do not commit until the user",
			"says so, but do propose a commit structure.",
			"",
		];
		if (accepted.length > 0) {
			lines.push("## Accepted — apply these fixes", "");
			accepted.forEach((f, idx) => {
				const loc = f.line ? `${f.file}:${f.line}` : f.file;
				lines.push(
					`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
					`   - Why: ${f.description}`,
				);
				if (f.suggestedAction) {
					lines.push(`   - Fix: ${f.suggestedAction}`);
				}
				lines.push("");
			});
		}
		if (explain.length > 0) {
			lines.push("## Explain — user requested more detail", "");
			explain.forEach((f, idx) => {
				const loc = f.line ? `${f.file}:${f.line}` : f.file;
				lines.push(
					`${idx + 1}. **[${f.severity}] \`${loc}\`** — ${f.title}`,
					`   - ${f.description}`,
				);
				if (f.suggestedAction) {
					lines.push(`   - Proposed fix: ${f.suggestedAction}`);
				}
				lines.push("");
			});
			lines.push(
				"For each Explain item, walk the user through what the issue is, why it",
				"matters, and the trade-offs of the proposed fix. Then ask if they want",
				"to accept it.",
			);
		}
		return lines.join("\n");
	}

	// ---- Command -----------------------------------------------------------
	pi.registerCommand(EXT_ID, {
		description:
			"Multi-agent review: seven specialists (architect, code-reviewer, scope-analyst, security-analyst, code-simplifier, doc-reviewer, dependency-checker) " +
			"run in parallel on the same scope. Each one reviews its own lane and returns [] if nothing applies. Walk findings, queue fixes for the agent.",
		handler: async (args, ctx) => {
			if (!isGitRepo(ctx.cwd)) {
				notify(ctx, "not inside a git repository", "error");
				return;
			}

			let scope: ReviewScope;
			try {
				scope = parseScope(args);
			} catch (err) {
				notify(ctx, err instanceof Error ? err.message : String(err), "error");
				return;
			}

			const rc = resolveContext(ctx, scope);
			if ("error" in rc) {
				notify(ctx, rc.error, "warning");
				return;
			}

			if (!ctx.model) {
				notify(
					ctx,
					"no active model — set one with /model before running /review",
					"error",
				);
				return;
			}

			notify(
				ctx,
				`${rc.scopeLabel}: ${rc.changedFiles} file(s), fanning out ${ALL_ROLES.length} reviewers`,
				"info",
			);

			let bundles: Array<{ role: ReviewerRole; findings: RawFinding[] }>;
			let errors: Array<{ role: ReviewerRole; error: string }>;
			try {
				const r = await runAllReviewers(ctx, rc);
				bundles = r.bundles;
				errors = r.errors;
			} catch (err) {
				notify(ctx, err instanceof Error ? err.message : String(err), "error");
				return;
			}

			for (const e of errors) {
				notify(ctx, `${e.role} failed: ${e.error.split("\n")[0]}`, "warning");
			}

			const findings = dedupeFindings(bundles);
			pi.sendMessage(
				{
					customType: EXT_ID,
					content: buildReport(rc, findings),
					display: true,
				},
				{ deliverAs: "steer" },
			);

			if (findings.length === 0) {
				notify(ctx, "no findings — you're clear.", "info");
				return;
			}

			const { accepted, explainRequests } = await walkFindings(ctx, findings);

			if (accepted.length === 0 && explainRequests.length === 0) {
				notify(ctx, "no fixes accepted — nothing to apply.", "info");
				return;
			}

			const confirm = await ctx.ui.confirm(
				"Apply accepted fixes?",
				`${accepted.length} accepted, ${explainRequests.length} to explain. ` +
					`Hand these to the agent now?`,
			);
			if (!confirm) {
				notify(ctx, "aborted — no fixes applied.", "warning");
				return;
			}

			pi.sendMessage(
				{
					customType: EXT_ID,
					content: buildFixPrompt(accepted, explainRequests),
					display: false,
					details: {
						acceptedCount: accepted.length,
						explainCount: explainRequests.length,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			notify(
				ctx,
				`handed ${accepted.length} fix(es) and ${explainRequests.length} explain request(s) to the agent.`,
				"info",
			);
		},
	});
}

export type { ReviewMode, Severity };
// Re-export pure helpers for test reach-through.
export { dedupeFindings, parseScope };
