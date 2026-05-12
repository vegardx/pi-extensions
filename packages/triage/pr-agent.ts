/**
 * PR triage orchestrator.
 *
 * Discovers open PRs that have bot reviews, spins up one primary.normal
 * sub-agent per selected PR (each in its own git worktree), and handles
 * the merge decisions once all agents finish.
 *
 * Sub-agents are fully autonomous: they validate findings, apply fixes,
 * commit, push, and resolve review threads. The main session only drives
 * PR selection and post-fix merge decisions.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import {
	runSubagentsParallel,
	type SubagentTask,
} from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import {
	createTriageWorktree,
	getRepoRoot,
	type PrInfo,
	removeTriageWorktree,
} from "./worktree.js";

// ---- Constants -------------------------------------------------------

const AGENT_PROMPT = join(
	dirname(fileURLToPath(import.meta.url)),
	"skills",
	"triage",
	"reference",
	"pr-reviews-agent.md",
);

/** 10 minutes — agents fix code, run git ops, make network calls. */
const AGENT_TIMEOUT_MS = 600_000;

const TRIAGE_TOOLS = ["read", "grep", "find", "ls", "bash", "edit"] as const;

// ---- Shell helper ----------------------------------------------------

interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function sh(cmd: string, args: string[], cwd: string): ShellResult {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		shell: false,
		env: process.env,
	});
	return {
		ok: (r.status ?? -1) === 0,
		stdout: (r.stdout ?? "").toString().trim(),
		stderr: (r.stderr ?? "").toString().trim(),
	};
}

/** Run a `gh` command, return parsed JSON, or null on failure. */
function ghJson<T>(args: string[], cwd: string): T | null {
	const r = sh("gh", args, cwd);
	if (!r.ok || !r.stdout) return null;
	try {
		return JSON.parse(r.stdout) as T;
	} catch {
		return null;
	}
}

// ---- Types -----------------------------------------------------------

interface BotReview {
	id: number;
	login: string;
	state: string;
	body: string;
}

interface ReviewComment {
	path: string;
	line: number | null;
	body: string;
	side: string;
}

interface PrWithReviews {
	pr: PrInfo;
	reviews: Array<{ review: BotReview; comments: ReviewComment[] }>;
}

interface TriageResult {
	pr: PrInfo;
	rawSummary: string;
	error?: string;
}

// ---- GitHub helpers --------------------------------------------------

function getOwnerRepo(cwd: string): string | null {
	const r = sh("git", ["remote", "get-url", "origin"], cwd);
	if (!r.ok) return null;
	const url = r.stdout;
	// https://github.com/owner/repo(.git)
	let m = url.match(/https?:\/\/[^/]+\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
	if (m) return `${m[1]}/${m[2]}`;
	// git@github.com:owner/repo(.git)
	m = url.match(/git@[^:]+:([^/]+)\/([^/.]+?)(?:\.git)?$/);
	if (m) return `${m[1]}/${m[2]}`;
	return null;
}

function listOpenPrs(cwd: string): PrInfo[] {
	const data = ghJson<
		Array<{ number: number; title: string; headRefName: string }>
	>(["pr", "list", "--json", "number,title,headRefName"], cwd);
	return data ?? [];
}

function fetchBotReviews(
	ownerRepo: string,
	prNumber: number,
	cwd: string,
): BotReview[] {
	type RawReview = {
		id: number;
		user: { login: string };
		state: string;
		body: string;
	};
	const data = ghJson<RawReview[]>(
		["api", `repos/${ownerRepo}/pulls/${prNumber}/reviews`],
		cwd,
	);
	if (!data) return [];
	return data
		.filter((r) => r.user.login.endsWith("[bot]"))
		.map((r) => ({
			id: r.id,
			login: r.user.login,
			state: r.state,
			body: r.body ?? "",
		}));
}

function fetchReviewComments(
	ownerRepo: string,
	prNumber: number,
	reviewId: number,
	cwd: string,
): ReviewComment[] {
	type RawComment = {
		path: string;
		line: number | null;
		body: string;
		side: string;
	};
	const data = ghJson<RawComment[]>(
		[
			"api",
			`repos/${ownerRepo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
		],
		cwd,
	);
	return (data ?? []).map((c) => ({
		path: c.path,
		line: c.line ?? null,
		body: c.body,
		side: c.side,
	}));
}

// ---- Task builder ----------------------------------------------------

function buildSubagentTask(
	pr: PrInfo,
	ownerRepo: string,
	reviews: PrWithReviews["reviews"],
): string {
	const lines: string[] = [
		`# Triage PR #${pr.number}: ${pr.title}`,
		``,
		`**Branch:** \`${pr.headRefName}\``,
		`**Repository:** \`${ownerRepo}\``,
		``,
		`You are already checked out on branch \`${pr.headRefName}\` in a dedicated`,
		`worktree. Work entirely within this directory — do not change branches.`,
		``,
		`## Bot Reviews`,
		``,
	];

	for (const { review, comments } of reviews) {
		lines.push(`### ${review.login} (review ID: ${review.id})`);
		lines.push(`State: ${review.state}`);
		lines.push(``);
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
	}

	return lines.join("\n");
}

// ---- Merge decision --------------------------------------------------

async function handleMergeDecision(
	pr: PrInfo,
	cwd: string,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) return;

	// Quick CI status check.
	const checks = sh("gh", ["pr", "checks", String(pr.number)], cwd);
	const checkSummary = checks.ok
		? checks.stdout.split("\n").slice(0, 5).join("\n")
		: "Unable to fetch CI status.";

	const choice = await ctx.ui.select(
		`PR #${pr.number} — CI status:\n${checkSummary}\n\nMerge?`,
		[
			"Enable auto-merge (squash, delete branch)",
			"Merge now (squash, delete branch)",
			"Skip — leave for later",
		],
	);

	if (choice == null || choice === "Skip — leave for later") return;

	const autoMerge = choice.startsWith("Enable auto-merge");
	const mergeArgs = [
		"pr",
		"merge",
		String(pr.number),
		"--squash",
		"--delete-branch",
		...(autoMerge ? ["--auto"] : []),
	];

	const result = sh("gh", mergeArgs, cwd);
	if (result.ok) {
		ctx.ui.notify(
			`triage: PR #${pr.number} ${autoMerge ? "queued for auto-merge" : "merged"}`,
			"info",
		);
		return;
	}

	// Auto-merge may fail if the repo doesn't allow it yet.
	if (autoMerge && result.stderr.includes("auto-merge")) {
		const enable = await ctx.ui.confirm(
			"Enable auto-merge?",
			"Auto-merge is not enabled on this repository. Enable it? This allows PRs to merge automatically once all required checks pass.",
		);
		if (enable) {
			sh(
				"gh",
				[
					"api",
					`repos/${getOwnerRepo(cwd)}`,
					"-X",
					"PATCH",
					"-f",
					"allow_auto_merge=true",
				],
				cwd,
			);
			sh("gh", mergeArgs, cwd);
			ctx.ui.notify(`triage: PR #${pr.number} queued for auto-merge`, "info");
		}
	} else {
		ctx.ui.notify(
			`triage: merge failed for PR #${pr.number} — ${result.stderr}`,
			"error",
		);
	}
}

// ---- Main entry ------------------------------------------------------

/**
 * Discover open PRs with bot reviews, fan out one primary.normal
 * sub-agent per selected PR (in a dedicated worktree), and handle
 * merge decisions after all agents finish.
 */
export async function runPrsTriage(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const notify = (msg: string, level: "info" | "warning" | "error" = "info") =>
		ctx.ui.notify(`triage: ${msg}`, level);

	// 1. Resolve the repo root and owner/repo.
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

	// 2. Check gh auth.
	if (!sh("gh", ["auth", "status"], ctx.cwd).ok) {
		notify("gh is not authenticated — run `gh auth login` first", "error");
		return;
	}

	// 3. Discover open PRs.
	notify("discovering open PRs…");
	const allPrs = listOpenPrs(ctx.cwd);
	if (allPrs.length === 0) {
		notify("no open PRs found");
		return;
	}

	// 4. Fetch bot reviews for each PR (in parallel via Promise.all).
	const withReviews: PrWithReviews[] = (
		await Promise.all(
			allPrs.map(async (pr) => {
				const botReviews = fetchBotReviews(ownerRepo, pr.number, ctx.cwd);
				if (botReviews.length === 0) return null;
				const reviews = botReviews.map((review) => ({
					review,
					comments: fetchReviewComments(
						ownerRepo,
						pr.number,
						review.id,
						ctx.cwd,
					),
				}));
				return { pr, reviews } satisfies PrWithReviews;
			}),
		)
	).filter((x): x is PrWithReviews => x !== null);

	if (withReviews.length === 0) {
		notify("no open PRs have bot reviews to triage");
		return;
	}

	// 5. Let the user pick which PRs to process.
	const summaryLines = withReviews.map(({ pr, reviews }) => {
		const total = reviews.reduce((n, r) => n + r.comments.length, 0);
		return `#${pr.number}: ${pr.title} (${total} comment${total === 1 ? "" : "s"})`;
	});

	const choices = [
		`All ${withReviews.length} PR${withReviews.length === 1 ? "" : "s"}`,
		...summaryLines,
		"Cancel",
	];

	const picked = await ctx.ui.select(
		`Found ${withReviews.length} PR${withReviews.length === 1 ? "" : "s"} with bot reviews:`,
		choices,
	);

	if (picked == null || picked === "Cancel") return;

	const selected = picked.startsWith("All ")
		? withReviews
		: withReviews.filter(({ pr }) => picked.startsWith(`#${pr.number}:`));

	if (selected.length === 0) return;

	// 6. Resolve the background model.
	const resolved = await resolveModel(ctx, {
		name: "triage-pr",
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

	// 7. Create worktrees and build sub-agent inputs.
	notify(
		`starting ${selected.length} sub-agent${selected.length === 1 ? "" : "s"} in parallel…`,
	);

	const worktrees = new Map<number, string>();

	const inputs: Array<SubagentTask<number>> = [];
	// Parallel tracking so outcomes[i] maps back to inputPrs[i].
	const inputPrs: PrInfo[] = [];
	for (const { pr, reviews } of selected) {
		let wtPath: string;
		try {
			wtPath = createTriageWorktree(pr, repoRoot);
		} catch (err) {
			notify(
				`skipping PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			continue;
		}
		worktrees.set(pr.number, wtPath);
		inputPrs.push(pr);
		inputs.push({
			tag: pr.number,
			task: buildSubagentTask(pr, ownerRepo, reviews),
			systemPromptPath: AGENT_PROMPT,
			provider,
			model: modelId,
			tools: TRIAGE_TOOLS,
			cwd: wtPath,
			signal: ctx.signal,
			timeoutMs: AGENT_TIMEOUT_MS,
		});
	}

	if (inputs.length === 0) return;

	// 8. Run all sub-agents in parallel (cap at 5 to avoid overload).
	const outcomes = await runSubagentsParallel(inputs, { maxParallel: 5 });

	// 9. Clean up worktrees.
	for (const [prNumber, wtPath] of worktrees) {
		try {
			removeTriageWorktree(wtPath, repoRoot);
		} catch {
			notify(
				`could not remove worktree for PR #${prNumber} at ${wtPath} — run \`git worktree prune\` to clean up`,
				"warning",
			);
		}
	}

	// 10. Collect results — outcomes and inputPrs are index-aligned.
	const results: TriageResult[] = outcomes.map((o, i) => ({
		pr: inputPrs[i] ?? {
			number: o.tag,
			title: `PR #${o.tag}`,
			headRefName: "",
		},
		rawSummary: o.rawText,
		error: o.error,
	}));

	// 11. Display summaries.
	for (const { pr, rawSummary, error } of results) {
		if (error) {
			notify(`PR #${pr.number} agent failed: ${error}`, "error");
		} else {
			// Surface the structured summary the agent produced.
			ctx.ui.notify(
				`triage: PR #${pr.number} — ${pr.title}\n\n${rawSummary}`,
				"info",
			);
		}
	}

	// 12. Merge decisions — one PR at a time, skip failed agents.
	for (const { pr, error } of results) {
		if (error) continue;
		await handleMergeDecision(pr, ctx.cwd, ctx);
	}
}
