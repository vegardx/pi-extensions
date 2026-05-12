/**
 * Shared shell and GitHub CLI utilities for the triage extension.
 *
 * Both `pr-agent.ts` (multi-PR fan-out) and `copilot-watcher.ts`
 * (single-PR Copilot watch) import from here.
 */

import { spawnSync } from "node:child_process";

// ---- Shell -----------------------------------------------------------

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

export function sh(cmd: string, args: string[], cwd: string): ShellResult {
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

/** Run a `gh` command, parse the output as JSON, or return null on failure. */
export function ghJson<T>(args: string[], cwd: string): T | null {
	const r = sh("gh", args, cwd);
	if (!r.ok || !r.stdout) return null;
	try {
		return JSON.parse(r.stdout) as T;
	} catch {
		return null;
	}
}

// ---- Repo identity ---------------------------------------------------

/**
 * Parse `owner/repo` from the git remote URL.
 * Handles both HTTPS and SSH remote formats.
 */
export function getOwnerRepo(cwd: string): string | null {
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

// ---- Review types ----------------------------------------------------

export interface BotReview {
	id: number;
	login: string;
	state: string;
	body: string;
}

export interface ReviewComment {
	path: string;
	line: number | null;
	body: string;
	side: string;
}

// ---- Review fetchers -------------------------------------------------

/** Fetch all bot reviews on a PR (login ends with `[bot]`). */
export function fetchBotReviews(
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

/** Fetch inline comments for a specific review. */
export function fetchReviewComments(
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

// ---- Copilot detection ----------------------------------------------

/** Canonical bot login prefix — handles both cloud and enterprise variants. */
export const COPILOT_LOGIN_PREFIX = "copilot";

export type CopilotReviewExpectation =
	/** Review already posted — no need to poll. */
	| "already-reviewed"
	/** Copilot is in the PR's requested_reviewers list. */
	| "requested"
	/** Repo has an active copilot_code_review branch ruleset. */
	| "auto-ruleset"
	/** No signal — Copilot may not review this PR. */
	| "none";

/**
 * Check whether a Copilot review is expected on `prNumber`.
 *
 * Returns:
 * - `already-reviewed`  review already posted, skip polling
 * - `requested`         Copilot is in requested_reviewers
 * - `auto-ruleset`      active copilot_code_review branch rule
 * - `none`              no signal found
 */
export function checkCopilotExpectation(
	ownerRepo: string,
	prNumber: number,
	headBranch: string,
	cwd: string,
): CopilotReviewExpectation {
	// Already reviewed? (Copilot is removed from requested_reviewers once done.)
	const existing = fetchBotReviews(ownerRepo, prNumber, cwd).filter((r) =>
		r.login.startsWith(COPILOT_LOGIN_PREFIX),
	);
	if (existing.length > 0) return "already-reviewed";

	// Explicitly requested?
	const pending = ghJson<{ users: Array<{ login: string }> }>(
		["api", `repos/${ownerRepo}/pulls/${prNumber}/requested_reviewers`],
		cwd,
	);
	if (pending?.users.some((u) => u.login.startsWith(COPILOT_LOGIN_PREFIX))) {
		return "requested";
	}

	// Active auto-review ruleset on this branch?
	const rules = ghJson<Array<{ type: string }>>(
		[
			"api",
			`repos/${ownerRepo}/rules/branches/${encodeURIComponent(headBranch)}`,
		],
		cwd,
	);
	if (rules?.some((r) => r.type === "copilot_code_review")) {
		return "auto-ruleset";
	}

	return "none";
}
