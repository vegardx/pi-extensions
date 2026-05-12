/**
 * Copilot review watcher for the triage extension.
 *
 * Checks whether a Copilot review is expected on a PR, waits for it to
 * land, then spawns a full-capability primary.normal sub-agent in a
 * dedicated worktree to validate findings, apply fixes, commit, push,
 * and resolve review threads autonomously.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	type BotReview,
	checkCopilotExpectation,
	fetchBotReviews,
	fetchReviewComments,
	getOwnerRepo,
	ghJson,
	type ReviewComment,
	sh,
} from "./gh.js";
import {
	AGENT_TIMEOUT_MS,
	handleMergeDecision,
	TRIAGE_TOOLS,
} from "./pr-agent.js";
import {
	createTriageWorktree,
	getRepoRoot,
	type PrInfo,
	removeTriageWorktree,
} from "./worktree.js";

// ---- Constants -------------------------------------------------------

const COPILOT_PROMPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"skills",
	"triage",
	"reference",
	"copilot-review-agent.md",
);

const COPILOT_LOGIN_PREFIX = "copilot";

// ---- Helpers ---------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch a single PR's metadata. */
function fetchPr(prNumber: number, cwd: string): PrInfo | null {
	const data = ghJson<{ number: number; title: string; headRefName: string }>(
		["pr", "view", String(prNumber), "--json", "number,title,headRefName"],
		cwd,
	);
	if (!data) return null;
	return {
		number: data.number,
		title: data.title,
		headRefName: data.headRefName,
	};
}

/**
 * List open PRs with their numbers and titles so the user can pick one.
 */
function listOpenPrs(cwd: string): Array<{ number: number; title: string }> {
	const data = ghJson<Array<{ number: number; title: string }>>(
		["pr", "list", "--json", "number,title"],
		cwd,
	);
	return data ?? [];
}

/**
 * Fetch the Copilot review on a PR, if one exists.
 * Returns the first review whose login starts with "copilot", or null.
 */
function fetchCopilotReview(
	ownerRepo: string,
	prNumber: number,
	cwd: string,
): BotReview | null {
	const reviews = fetchBotReviews(ownerRepo, prNumber, cwd);
	return reviews.find((r) => r.login.startsWith(COPILOT_LOGIN_PREFIX)) ?? null;
}

/**
 * Poll until a Copilot review appears, or we time out.
 * Notifies the user each poll cycle so the wait is visible.
 */
async function pollForCopilotReview(
	ownerRepo: string,
	prNumber: number,
	cwd: string,
	ctx: ExtensionContext,
	opts = { pollMs: 30_000, maxAttempts: 20 },
): Promise<BotReview | null> {
	for (let i = 0; i < opts.maxAttempts; i++) {
		const review = fetchCopilotReview(ownerRepo, prNumber, cwd);
		if (review) return review;

		const elapsed = Math.round(((i + 1) * opts.pollMs) / 60_000);
		ctx.ui.notify(
			`triage: waiting for Copilot review on PR #${prNumber} (${i + 1}/${opts.maxAttempts}, ~${elapsed} min elapsed)…`,
			"info",
		);
		await sleep(opts.pollMs);
	}
	return null;
}

// ---- Task builder ----------------------------------------------------

function buildCopilotTask(
	pr: PrInfo,
	ownerRepo: string,
	review: BotReview,
	comments: ReviewComment[],
): string {
	const lines: string[] = [
		`# Triage Copilot Review on PR #${pr.number}: ${pr.title}`,
		``,
		`**Branch:** \`${pr.headRefName}\``,
		`**Repository:** \`${ownerRepo}\``,
		``,
		`You are already checked out on branch \`${pr.headRefName}\` in a dedicated`,
		`worktree. Work entirely within this directory — do not change branches.`,
		``,
		`The Copilot review body and inline comments have been pre-fetched and are`,
		`included below. Skip straight to fetching thread IDs and validating findings.`,
		``,
		`## Copilot Review (ID: ${review.id})`,
		`State: ${review.state}`,
		``,
	];

	if (review.body) {
		lines.push(`**Summary:**`);
		lines.push(review.body);
		lines.push(``);
	}

	if (comments.length > 0) {
		lines.push(`**Inline comments (${comments.length}):**`);
		for (const c of comments) {
			const loc = c.line != null ? ` line ${c.line}` : "";
			lines.push(`- \`${c.path}\`${loc}: ${c.body}`);
		}
		lines.push(``);
	}

	return lines.join("\n");
}

// ---- Main entry ------------------------------------------------------

/**
 * Wait for a Copilot review on a specific PR, then triage it
 * autonomously via a dedicated sub-agent in a worktree.
 *
 * If `prNumber` is omitted, asks the user to pick from open PRs.
 */
export async function runCopilotTriage(
	ctx: ExtensionContext,
	prNumber?: number,
): Promise<void> {
	if (!ctx.hasUI) return;

	const notify = (msg: string, level: "info" | "warning" | "error" = "info") =>
		ctx.ui.notify(`triage: ${msg}`, level);

	// 1. Resolve repo context.
	const repoRoot = getRepoRoot(ctx.cwd);
	if (!repoRoot) {
		notify("not inside a git repository", "error");
		return;
	}

	const ownerRepo = getOwnerRepo(ctx.cwd);
	if (!ownerRepo) {
		notify("could not determine owner/repo from git remote origin", "error");
		return;
	}

	if (!sh("gh", ["auth", "status"], ctx.cwd).ok) {
		notify("gh is not authenticated — run `gh auth login` first", "error");
		return;
	}

	// 2. Resolve the PR number.
	let resolvedPrNumber = prNumber;
	if (!resolvedPrNumber) {
		const prs = listOpenPrs(ctx.cwd);
		if (prs.length === 0) {
			notify("no open PRs found");
			return;
		}
		const choice = await ctx.ui.select(
			"Which PR should Copilot watch?",
			prs.map((p) => `#${p.number}: ${p.title}`),
		);
		if (!choice) return;
		const m = choice.match(/^#(\d+)/);
		if (!m) return;
		resolvedPrNumber = parseInt(m[1], 10);
	}

	// 3. Fetch PR metadata.
	const pr = fetchPr(resolvedPrNumber, ctx.cwd);
	if (!pr) {
		notify(`could not fetch PR #${resolvedPrNumber}`, "error");
		return;
	}

	// 4. Check whether a Copilot review is expected before polling.
	const expectation = checkCopilotExpectation(
		ownerRepo,
		pr.number,
		pr.headRefName,
		ctx.cwd,
	);

	let review: BotReview | null = null;

	if (expectation === "already-reviewed") {
		// Review is already there — fetch it and skip polling.
		notify(`Copilot review already present on PR #${pr.number} — triaging now`);
		review = fetchCopilotReview(ownerRepo, pr.number, ctx.cwd);
	} else {
		if (expectation === "none") {
			// No signal that Copilot will review — ask before committing to a long wait.
			const proceed = await ctx.ui.confirm(
				"No Copilot review expected",
				`Copilot hasn't been requested as a reviewer on PR #${pr.number} and no auto-review ruleset is active on branch \`${pr.headRefName}\`. Watch anyway?`,
			);
			if (!proceed) return;
		} else {
			const reason =
				expectation === "requested"
					? "Copilot has been requested as a reviewer"
					: "auto-review ruleset is active on this branch";
			notify(`${reason} — watching PR #${pr.number} for Copilot review…`);
		}

		// Poll (up to 10 min / 20 × 30s).
		review = await pollForCopilotReview(ownerRepo, pr.number, ctx.cwd, ctx);

		if (!review) {
			notify(
				`no Copilot review appeared on PR #${pr.number} after 10 minutes — giving up`,
				"warning",
			);
			return;
		}

		notify(`Copilot review landed on PR #${pr.number} — starting triage`);
	}

	if (!review) {
		notify(`no Copilot review found on PR #${pr.number}`, "warning");
		return;
	}

	// 5. Pre-fetch inline comments.
	const comments = fetchReviewComments(
		ownerRepo,
		pr.number,
		review.id,
		ctx.cwd,
	);

	// 6. Resolve the background model.
	const resolved = await resolveModel(ctx, {
		name: "triage-copilot",
		tier: "normal",
		set: "primary",
	});

	const provider = resolved?.model.provider ?? ctx.model?.provider;
	const modelId = resolved?.model.id ?? ctx.model?.id;

	if (!provider || !modelId) {
		notify(
			"no model available — configure backgroundModels.primary.normal or use an active session model",
			"error",
		);
		return;
	}

	// 7. Create worktree and spawn sub-agent.
	let wtPath: string;
	try {
		wtPath = createTriageWorktree(pr, repoRoot);
	} catch (err) {
		notify(
			`could not create worktree: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return;
	}

	let rawSummary: string;
	let agentError: string | undefined;

	try {
		notify(`sub-agent running in worktree for PR #${pr.number}…`);
		const outcome = await runSubagent({
			tag: `copilot-pr-${pr.number}`,
			task: buildCopilotTask(pr, ownerRepo, review, comments),
			systemPromptPath: COPILOT_PROMPT,
			provider,
			model: modelId,
			tools: TRIAGE_TOOLS,
			cwd: wtPath,
			signal: ctx.signal,
			timeoutMs: AGENT_TIMEOUT_MS,
		});
		rawSummary = outcome.rawText;
		agentError = outcome.error;
	} finally {
		try {
			removeTriageWorktree(wtPath, repoRoot);
		} catch {
			notify(
				`could not remove worktree at ${wtPath} — run \`git worktree prune\` to clean up`,
				"warning",
			);
		}
	}

	// 8. Display summary.
	if (agentError) {
		notify(`agent failed: ${agentError}`, "error");
		return;
	}

	ctx.ui.notify(
		`triage: PR #${pr.number} — ${pr.title}\n\n${rawSummary}`,
		"info",
	);

	// 9. Merge decision.
	await handleMergeDecision(pr, ctx.cwd, ctx);
}
