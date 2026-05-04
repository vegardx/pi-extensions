/**
 * Pure helpers for /commit. No I/O, no pi — unit-testable standalone.
 */

// ---- PR title/body extraction -----------------------------------------
//
// After committing, we ask the agent to write a PR title and body. To
// avoid having to parse free-form markdown, we tell the agent to wrap
// its output in sentinels:
//
//     ---TITLE---
//     short one-line title
//     ---BODY---
//     multi-line markdown body
//     ---END---
//
// `parseTitleAndBody` pulls the two sections out. Any surrounding chatter
// is tolerated. Returns null if either section is missing.

export interface TitleAndBody {
	title: string;
	body: string;
}

const TITLE_RE = /---TITLE---\s*\n([\s\S]*?)\n---BODY---/;
const BODY_RE = /---BODY---\s*\n([\s\S]*?)\n---END---/;

export function parseTitleAndBody(text: string): TitleAndBody | null {
	const title = TITLE_RE.exec(text)?.[1]?.trim();
	const body = BODY_RE.exec(text)?.[1]?.trim();
	if (!title || !body) return null;
	return { title, body };
}

// ---- Validation -------------------------------------------------------

/**
 * Safe to interpolate into a shell command key like
 * `git config branch.<name>.tracking-issue`. We accept the conservative
 * set `[A-Za-z0-9/_.-]+` — matches every branch name I've seen in
 * practice and rejects anything that could inject shell metacharacters.
 */
export function isSafeBranchName(branch: string): boolean {
	return /^[A-Za-z0-9/_.-]+$/.test(branch) && branch.length > 0;
}

/**
 * GitHub issue numbers are positive integers. Accept the same range
 * awesome-agents' `/commit` uses: 1..9999999.
 */
export function isValidIssueNumber(raw: string): boolean {
	return /^[1-9][0-9]{0,6}$/.test(raw.trim());
}

// ---- Fork URL derivation ---------------------------------------------

/**
 * Swap only the owner/repo path component of a git remote URL, preserving
 * the host, protocol, and any auth bits. Used when adding a fork as a
 * remote on a cross-repo PR: we want the fork URL on the SAME host as
 * origin so corporate GHE setups keep working.
 *
 * Handles both common forms:
 *   - SSH:   git@host.example:owner/repo.git
 *   - HTTPS: https://host.example/owner/repo.git
 *
 * Returns null if `originUrl` doesn't match either form — caller should
 * fall back to asking the user.
 */
export function buildForkUrl(
	originUrl: string,
	forkNameWithOwner: string,
): string | null {
	const trimmed = originUrl.trim();
	// SSH: git@host:owner/repo(.git)? — capture up to and including the ':'.
	const sshMatch = /^(.*@[^:]+:)[^/]+\/[^/]+?(\.git)?$/.exec(trimmed);
	if (sshMatch) {
		const prefix = sshMatch[1];
		const suffix = sshMatch[2] ?? "";
		return `${prefix}${forkNameWithOwner}${suffix}`;
	}
	// HTTPS/HTTP/git protocols: capture everything up to the final
	// `owner/repo(.git)?` suffix.
	const httpsMatch = /^(.*:\/\/[^/]+\/)[^/]+\/[^/]+?(\.git)?$/.exec(trimmed);
	if (httpsMatch) {
		const prefix = httpsMatch[1];
		const suffix = httpsMatch[2] ?? "";
		return `${prefix}${forkNameWithOwner}${suffix}`;
	}
	return null;
}

// ---- Plan summary helpers --------------------------------------------

/**
 * When the agent's commit plan turn finishes, we want a terse
 * description for notifications. Grab the first non-empty, non-header
 * line. Falls back to "proposed commit plan" when nothing interesting
 * is in view.
 */
export function summarisePlan(text: string, maxLength = 80): string {
	let insideFence = false;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("```")) {
			// Toggle on the fence itself, then skip this line.
			insideFence = !insideFence;
			continue;
		}
		if (insideFence) continue;
		if (!line) continue;
		if (line.startsWith("#")) continue; // markdown heading
		const clipped =
			line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
		return clipped;
	}
	return "proposed commit plan";
}
