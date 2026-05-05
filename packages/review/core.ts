/**
 * Pure /review run — used by both `/review`'s command handler and
 * `/develop`'s post-loop picker. The picker bypasses slash-command
 * dispatch (`pi.sendUserMessage("/cmd")` is hard-coded to skip slash
 * expansion in pi-coding-agent ≤ 0.73.0; see badlogic/pi-mono#2549/
 * #2994/#3673) and calls `runReview(...)` directly.
 */
import type {
	ExtensionAPI,
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
import { parseScope, type ReviewScope } from "./scope.js";

export const EXT_ID = "review";

// ---- Post-/review /commit offer (in-process chain) ---------------------
//
// After /review queues accepted fixes for the agent (via
// `pi.sendMessage(..., { triggerTurn: true })`), the agent runs a
// turn applying them. The natural next step is `/commit`. Today the
// chain `/commit → /review` exists (at the start of /commit) but
// `/review → /commit` did not.
//
// We can't dispatch a slash command — `pi.sendUserMessage("/cmd")` is
// hard-coded to skip slash expansion in pi-coding-agent ≤ 0.73.0
// (badlogic/pi-mono#2549/#2994/#3673). Instead, when the user opts
// into the offer, we register a flag-gated permanent `agent_end`
// listener that fires exactly once: when the agent_end after the
// queued fix turn arrives, we consume the pending offer slot,
// dynamic-import `pi-ext-commit/core`, and call `runCommit` directly.
//
// `pi.on()` returns no unsubscribe handle, so the listener stays
// registered for the lifetime of the extension. The flag-based
// one-shot pattern keeps subsequent agent_end events as no-ops until
// another /review run opts in.

interface PendingPostReviewCommit {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}

const postReviewListenerInstalledFor = new WeakSet<object>();
const pendingPostReviewCommit = new WeakMap<object, PendingPostReviewCommit>();

function ensurePostReviewCommitListener(pi: ExtensionAPI): void {
	if (postReviewListenerInstalledFor.has(pi)) return;
	postReviewListenerInstalledFor.add(pi);
	pi.on("agent_end", () => {
		// Defer one microtask so any post-agent_end state propagation
		// settles before we open a new turn via runCommit.
		queueMicrotask(async () => {
			const pending = pendingPostReviewCommit.get(pi);
			if (!pending) return;
			pendingPostReviewCommit.delete(pi);
			const { ctx, pi: api } = pending;
			if (!api.getCommands().some((c) => c.name === "commit")) {
				notify(ctx, "commit extension not installed", "warning");
				return;
			}
			try {
				const mod = await import("pi-ext-commit/core");
				await mod.runCommit({
					ctx,
					pi: api,
					guidance: "",
					skipReviewOffer: true,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				notify(ctx, `commit failed: ${msg}`, "error");
			}
		});
	});
}

/**
 * Pure decision: should /review offer to chain into /commit on
 * completion? Only when the user is interactive and the commit
 * extension is installed. The fix-count axis is intentionally NOT
 * a precondition: a clean review (no findings) is just as natural
 * a moment to commit as a fix-walked one. Whether to use a one-shot
 * `agent_end` listener or dispatch immediately depends on whether a
 * fix turn was queued; that's a separate decision handled by
 * `chainToCommit`.
 *
 * Exported (and re-exported from `index.ts`) so unit tests can
 * cover the edge cases without mocking pi.
 */
export function shouldOfferPostReviewCommit(opts: {
	hasUI: boolean;
	commitInstalled: boolean;
}): boolean {
	if (!opts.hasUI) return false;
	if (!opts.commitInstalled) return false;
	return true;
}

/**
 * The seven specialist reviewer roles. Every role receives the same scope
 * (diff or whole codebase) and decides for itself whether anything in its
 * lane applies — if not, it returns `[]`. The scope-handling rules are
 * defined identically in every prompt under `prompts/`.
 */
export const ALL_ROLES: readonly ReviewerRole[] = [
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
	scopeLabel: string;
	changedFiles: number;
	additions: number;
	deletions: number;
}

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

const REVIEW_PROGRESS_WIDGET = "review-progress";

function renderReviewProgress(
	status: ReadonlyMap<ReviewerRole, "running" | "done">,
): string[] {
	const lines: string[] = [];
	const total = status.size;
	let done = 0;
	for (const v of status.values()) if (v === "done") done++;
	lines.push(`🔬 review (${done}/${total} reviewers done)`);
	for (const role of ALL_ROLES) {
		const s = status.get(role);
		const glyph = s === "done" ? "✓" : "⏳";
		lines.push(`  ${glyph} ${role}`);
	}
	return lines;
}
async function runAllReviewers(
	ctx: ExtensionContext,
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

	// Track per-role state for the progress widget. All seven start as
	// in-flight (⏳) since we kick them off in parallel; each flips to
	// ✓ the moment its outcome resolves.
	const roleStatus = new Map<ReviewerRole, "running" | "done">(
		roles.map((r) => [r, "running"]),
	);

	let completed = 0;
	if (ctx.hasUI) {
		ctx.ui.setStatus(EXT_ID, `reviewing 0/${roles.length}`);
		ctx.ui.setWidget(REVIEW_PROGRESS_WIDGET, renderReviewProgress(roleStatus));
	}

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
			roleStatus.set(role, "done");
			if (ctx.hasUI) {
				ctx.ui.setStatus(EXT_ID, `reviewing ${completed}/${roles.length}`);
				ctx.ui.setWidget(
					REVIEW_PROGRESS_WIDGET,
					renderReviewProgress(roleStatus),
				);
			}
			return outcome;
		}),
	);

	if (ctx.hasUI) {
		ctx.ui.setStatus(EXT_ID, undefined);
		ctx.ui.setWidget(REVIEW_PROGRESS_WIDGET, undefined);
	}

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
function buildReport(rc: ReviewContext, findings: readonly Finding[]): string {
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
		const verb = rec.action === "accept" ? "Accept" : "Explain";
		parts.push(
			"",
			`**Confidence**: high — recommending **${verb}** (${rec.reasons.join(", ")}).`,
		);
	}
	return parts.join("\n");
}

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

async function walkFindings(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	findings: readonly Finding[],
): Promise<{ accepted: Finding[]; explainRequests: Finding[] }> {
	const accepted: Finding[] = [];
	const explainRequests: Finding[] = [];
	const actionable = findings.filter((f) => f.severity !== "NOTE");
	const notes = findings.filter((f) => f.severity === "NOTE");

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
		if (!choice) continue;
		if (choice.startsWith("Accept")) accepted.push(f);
		else if (choice.startsWith("Explain")) explainRequests.push(f);
	}

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

// ---- Public entry point -------------------------------------------------

export interface RunReviewOptions {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	/** Raw command argument string (scope flags / file paths). Defaults to "" (working tree). */
	arg?: string;
}

export interface RunReviewResult {
	ran: boolean;
	abortReason?:
		| "not-git"
		| "scope-error"
		| "scope-empty"
		| "no-model"
		| "fanout-error";
	scopeLabel?: string;
	findings?: Finding[];
}

export async function runReview(
	opts: RunReviewOptions,
): Promise<RunReviewResult> {
	const { ctx, pi, arg = "" } = opts;

	if (!isGitRepo(ctx.cwd)) {
		notify(ctx, "not inside a git repository", "error");
		return { ran: false, abortReason: "not-git" };
	}

	let scope: ReviewScope;
	try {
		scope = parseScope(arg);
	} catch (err) {
		notify(ctx, err instanceof Error ? err.message : String(err), "error");
		return { ran: false, abortReason: "scope-error" };
	}

	const rc = resolveContext(ctx, scope);
	if ("error" in rc) {
		notify(ctx, rc.error, "warning");
		return { ran: false, abortReason: "scope-empty" };
	}

	if (!ctx.model) {
		notify(
			ctx,
			"no active model — set one with /model before running /review",
			"error",
		);
		return { ran: false, abortReason: "no-model", scopeLabel: rc.scopeLabel };
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
		return {
			ran: false,
			abortReason: "fanout-error",
			scopeLabel: rc.scopeLabel,
		};
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
		await chainToCommit(ctx, pi, false);
		return { ran: true, scopeLabel: rc.scopeLabel, findings: [] };
	}

	if (!ctx.hasUI) {
		// Non-interactive — surface findings via the report message above
		// and return. Caller (RPC mode) can read the structured data later.
		return { ran: true, scopeLabel: rc.scopeLabel, findings };
	}

	const { accepted, explainRequests } = await walkFindings(ctx, pi, findings);

	if (accepted.length === 0 && explainRequests.length === 0) {
		notify(ctx, "no fixes accepted — nothing to apply.", "info");
		return { ran: true, scopeLabel: rc.scopeLabel, findings };
	}

	const confirm = await ctx.ui.confirm(
		"Apply accepted fixes?",
		`${accepted.length} accepted, ${explainRequests.length} to explain. ` +
			`Hand these to the agent now?`,
	);
	if (!confirm) {
		notify(ctx, "aborted — no fixes applied.", "warning");
		return { ran: true, scopeLabel: rc.scopeLabel, findings };
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

	// Chain into /commit. A fix turn is pending (we just queued it),
	// so we install a one-shot agent_end listener instead of
	// dispatching immediately.
	await chainToCommit(ctx, pi, true);

	return { ran: true, scopeLabel: rc.scopeLabel, findings };
}

/**
 * Offer /commit on /review completion and — if the user accepts —
 * either install a one-shot `agent_end` listener (when a fix turn
 * is pending) or dispatch /commit immediately. Gated on
 * `shouldOfferPostReviewCommit` so non-interactive runs and missing
 * /commit installations stay silent.
 */
async function chainToCommit(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	fixesPending: boolean,
): Promise<void> {
	const commitInstalled = pi.getCommands().some((c) => c.name === "commit");
	if (!shouldOfferPostReviewCommit({ hasUI: ctx.hasUI, commitInstalled })) {
		return;
	}

	const title = fixesPending
		? "Run /commit after the agent applies these fixes?"
		: "Run /commit now?";
	const message = fixesPending
		? "Recommended. /commit will run once the next agent turn ends so the fixes are committed without needing to re-invoke it manually."
		: "Recommended. The review didn't queue any agent work, so /commit can run immediately.";
	const chain = await ctx.ui.confirm(title, message);
	if (!chain) return;

	if (fixesPending) {
		ensurePostReviewCommitListener(pi);
		pendingPostReviewCommit.set(pi, { ctx, pi });
		notify(ctx, "will run /commit after the fix turn ends", "info");
		return;
	}

	// No fix turn pending — dispatch /commit immediately. Mirrors
	// /develop's post-loop picker dispatch shape.
	try {
		const mod = await import("pi-ext-commit/core");
		await mod.runCommit({ ctx, pi, guidance: "", skipReviewOffer: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		notify(ctx, `commit failed: ${msg}`, "error");
	}
}
