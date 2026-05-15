/**
 * Handover file discovery and ranking for /continue.
 *
 * Scans the handover directory, parses frontmatter from each file,
 * and ranks candidates by relevance to the current working context.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHandoverDir } from "./context.js";
import { type HandoverMeta, parseHandover } from "./frontmatter.js";

export interface RankedHandover {
	filePath: string;
	meta: HandoverMeta;
	body: string;
	score: number;
}

/**
 * Returns true when the caller must show a picker rather than auto-selecting
 * the top candidate.
 *
 * Rules:
 *  - Score < 50: no branch/repo signal matched — recency alone is too weak.
 *  - Tie at the top: two candidates are equally relevant; the user must choose.
 *
 * Exported as a pure function so the picker threshold is directly testable
 * without spinning up a session or touching the filesystem.
 */
export function needsHandoverPicker(candidates: RankedHandover[]): boolean {
	if (candidates.length === 0) return false;
	return (
		candidates[0].score < 50 ||
		(candidates.length > 1 && candidates[0].score === candidates[1].score)
	);
}

/**
 * Get the current git remote URL for the given cwd (best-effort).
 */
function getRemoteUrl(cwd: string): string | null {
	const r = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd,
		encoding: "utf8",
		shell: false,
	});
	const out = (r.stdout ?? "").trim();
	return out && !out.startsWith("fatal") ? out : null;
}

/**
 * Get the current git branch for the given cwd (best-effort).
 */
function getCurrentBranch(cwd: string): string | null {
	const r = spawnSync("git", ["branch", "--show-current"], {
		cwd,
		encoding: "utf8",
		shell: false,
	});
	const out = (r.stdout ?? "").trim();
	return out || null;
}

/**
 * Normalize git remote URLs for comparison.
 * Strips .git suffix and protocol differences so that
 * `git@github.com:foo/bar.git` matches `https://github.com/foo/bar`.
 */
export function normalizeRemote(url: string): string {
	let normalized = url.trim();
	// Strip trailing .git
	normalized = normalized.replace(/\.git$/, "");
	// Convert SSH to path form: git@host:org/repo → host/org/repo
	const sshMatch = normalized.match(/^[\w-]+@([^:]+):(.+)$/);
	if (sshMatch) {
		normalized = `${sshMatch[1]}/${sshMatch[2]}`;
	} else {
		// Strip protocol: https://host/org/repo → host/org/repo
		normalized = normalized.replace(/^[a-z+]+:\/\//, "");
		// Strip auth: x-access-token:token@host → host
		normalized = normalized.replace(/^[^@]+@/, "");
	}
	return normalized.toLowerCase();
}

/**
 * Score a handover candidate against the current context.
 *
 * Scoring (additive):
 *   +100  branch matches exactly
 *   +50   repo matches (normalized)
 *   +1-10 recency (date within last 10 days gets 10 - daysDiff)
 */
export function scoreHandover(
	meta: HandoverMeta,
	currentBranch: string | null,
	currentRemote: string | null,
	today: string,
): number {
	let score = 0;

	if (currentBranch && meta.branch && meta.branch === currentBranch) {
		score += 100;
	}

	if (currentRemote && meta.repo) {
		if (normalizeRemote(currentRemote) === normalizeRemote(meta.repo)) {
			score += 50;
		}
	}

	// Recency: days between handover date and today
	const handoverTime = new Date(meta.date).getTime();
	const todayTime = new Date(today).getTime();
	if (!Number.isNaN(handoverTime) && !Number.isNaN(todayTime)) {
		const daysDiff = Math.floor(
			(todayTime - handoverTime) / (1000 * 60 * 60 * 24),
		);
		if (daysDiff >= 0 && daysDiff < 10) {
			score += 10 - daysDiff;
		}
	}

	return score;
}

/**
 * Discover and rank all handover files in the configured directory.
 * Returns candidates sorted by score (highest first), then by date (newest first).
 */
export function discoverHandovers(
	cwd: string,
	opts?: { configuredDir?: string },
): RankedHandover[] {
	const dir = resolveHandoverDir(opts?.configuredDir);

	let files: string[];
	try {
		files = readdirSync(dir).filter(
			(f) => f.startsWith("handover-") && f.endsWith(".md"),
		);
	} catch {
		return [];
	}

	const currentBranch = getCurrentBranch(cwd);
	const currentRemote = getRemoteUrl(cwd);
	const today = new Date().toISOString().slice(0, 10);

	const results: RankedHandover[] = [];

	for (const file of files) {
		const filePath = join(dir, file);
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}

		const parsed = parseHandover(content);
		if (!parsed) continue;

		const score = scoreHandover(
			parsed.meta,
			currentBranch,
			currentRemote,
			today,
		);
		results.push({
			filePath,
			meta: parsed.meta,
			body: parsed.body,
			score,
		});
	}

	// Sort: highest score first, then newest date first
	results.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.meta.date.localeCompare(a.meta.date);
	});

	return results;
}
