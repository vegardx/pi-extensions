/**
 * Pure helpers for /develop. No I/O, no pi APIs — everything here is unit
 * testable without a running session.
 */

/** Branch prefix keyed by the verb signal found in the description. */
export type BranchPrefix = "feat/" | "fix/" | "refactor/" | "docs/" | "chore/";

interface PrefixRule {
	prefix: BranchPrefix;
	keywords: readonly string[];
}

// Ordered most-specific → least-specific. We match the first rule whose
// keywords appear in the description. Ambiguous or unmatched falls back to
// `feat/`, matching the `/feature` skill from awesome-agents.
const PREFIX_RULES: readonly PrefixRule[] = [
	{
		prefix: "fix/",
		keywords: [
			"fix",
			"bug",
			"broken",
			"error",
			"crash",
			"issue",
			"regression",
			"patch",
		],
	},
	{
		prefix: "refactor/",
		keywords: [
			"refactor",
			"restructure",
			"reorganize",
			"simplify",
			"cleanup",
			"clean up",
			"rework",
		],
	},
	{
		prefix: "docs/",
		keywords: ["doc", "docs", "documentation", "readme", "guide", "tutorial"],
	},
	{
		prefix: "chore/",
		keywords: [
			"chore",
			"config",
			"ci",
			"tooling",
			"deps",
			"dependency",
			"dependencies",
			"upgrade",
			"bump",
		],
	},
	{
		prefix: "feat/",
		keywords: [
			"add",
			"implement",
			"create",
			"new",
			"support",
			"introduce",
			"build",
		],
	},
] as const;

/**
 * Derive a conventional branch prefix from a free-form description.
 * Matches whole words to avoid accidentally picking `docs/` from "doctor".
 */
export function derivePrefix(description: string): BranchPrefix {
	const text = description.toLowerCase();
	for (const rule of PREFIX_RULES) {
		for (const kw of rule.keywords) {
			// Escape nothing — keywords are plain words, but we still build a
			// whole-word regex so "ci" doesn't match "decimal".
			const re = new RegExp(`\\b${kw}\\b`);
			if (re.test(text)) return rule.prefix;
		}
	}
	return "feat/";
}

/**
 * Kebab-case slug from a description: 3–5 alphanumeric tokens, max 50 chars.
 * Mirrors the slug the awesome-agents `/feature` hook produces so branches
 * and session titles line up across harnesses.
 *
 * TODO: this is dumb — it just keeps the first 3–5 alphanumeric tokens of
 * whatever the user typed, so "I think we can just remove the example
 * extension" becomes `feat/i-think-we-can-just`. Replace with a smarter
 * naming pass that hands the description to a `fast`-tier background
 * model (see root `README.md` “Background models” + `_shared/model-resolver.ts`)
 * and asks for a 3–5 word kebab-case branch slug describing the *intent*.
 * Fall back to this token-truncation behaviour when no fast-tier model
 * resolves (offline, no auth, etc.) so the extension still works without
 * a model. The same suggestion should also feed `pi.setSessionName` in
 * the Implement path so session titles aren’t the user’s first sentence
 * either. Mirror any change into `packages/session-title/` if it grows
 * an `auto-title` mode that should agree with the branch name. See
 * `packages/develop/README.md` “Known limitations” for the user-facing
 * note.
 */
export function slugify(
	description: string,
	opts: { maxTokens?: number; maxLength?: number } = {},
): string {
	const maxTokens = opts.maxTokens ?? 5;
	const maxLength = opts.maxLength ?? 50;
	const tokens = description.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return tokens.slice(0, maxTokens).join("-").slice(0, maxLength);
}

/** `feat/add-payment-webhooks` style branch name. Empty slug → empty string. */
export function deriveBranchName(description: string): string {
	const slug = slugify(description);
	if (!slug) return "";
	return `${derivePrefix(description)}${slug}`;
}

/**
 * Regexes matching plausibly-leaked credentials. Kept in sync with
 * awesome-agents/feature/hooks/name-session.mjs so the two harnesses share
 * the same secret-scan coverage.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:ghp_|gho_|ghs_|glpat-|sk-|xox[bpras]-|AKIA)[A-Za-z0-9_-]{12,}\b/i,
	// High-entropy fallback: 32+ contiguous base64url-ish chars.
	/[A-Za-z0-9_-]{32,}/,
];

export interface SecretScanResult {
	hasSecret: boolean;
	/** Short human-readable reason, suitable for a notify() call. */
	reason?: string;
}

/**
 * Scan free text for obvious pasted credentials. Used by the park path to
 * refuse to publish a plan that contains an API key to a tracking issue.
 *
 * This is intentionally conservative — it produces false positives on long
 * hashes and minified content. The park path asks for user confirmation on a
 * hit rather than aborting outright.
 */
export function scanForSecrets(text: string): SecretScanResult {
	for (const re of SECRET_PATTERNS) {
		const m = re.exec(text);
		if (m) {
			return {
				hasSecret: true,
				reason: `possible credential matched /${re.source}/`,
			};
		}
	}
	return { hasSecret: false };
}

/** Trim + clamp a description into something usable as a GitHub issue title. */
export function deriveIssueTitle(
	description: string,
	fallback: string,
	maxLength = 72,
): string {
	const candidate = description.trim().split("\n")[0]?.trim() ?? "";
	const source = candidate || fallback.trim();
	return source.length > maxLength
		? `${source.slice(0, maxLength - 1)}…`
		: source;
}
