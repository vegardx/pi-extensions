/**
 * Helpers for /develop. The leaf functions (`derivePrefix`, `slugify`,
 * `sanitizeSlug`, `deriveBranchName`, `deriveIssueTitle`, `scanForSecrets`,
 * `needsIntake`, `buildIntakePrompt`, `buildSlugPrompt`) are pure and unit
 * testable without a running session. The model-driven helpers
 * (`slugifyWithModel`, `deriveBranchNameWithModel`) take an `ExtensionContext`
 * so they can resolve a fast-tier background model via
 * `_shared/model-resolver.ts`; they fall back to the pure path when no
 * model resolves so the extension still works offline.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";

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
 * Offline kebab-case slug: 3–5 alphanumeric tokens, max 50 chars.
 * The smart path is `slugifyWithModel`, which only falls back here when no
 * fast-tier background model resolves. See `packages/develop/README.md`
 * "Branch + session naming" for the user-facing note.
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

/**
 * Sanitize arbitrary text (typically an LLM completion) into a kebab-case
 * slug under the same `maxTokens` / `maxLength` envelope as `slugify`.
 * Strips wrapping quotes/backticks/code fences before tokenizing so
 * `'"add-payment-webhooks"'`, `` `add-payment-webhooks` ``, and a fenced
 * single-line ```` ```add-payment-webhooks``` ```` all yield the same slug.
 */
export function sanitizeSlug(
	raw: string,
	opts: { maxTokens?: number; maxLength?: number } = {},
): string {
	const maxTokens = opts.maxTokens ?? 5;
	const maxLength = opts.maxLength ?? 50;
	let s = raw.trim();
	// Drop fenced code blocks the model may have added (single or triple
	// backtick wrappers); we only need the inner content. Handle the
	// triple-backtick form first so we don't eat the slug.
	if (s.startsWith("```") && s.endsWith("```") && s.length >= 6) {
		s = s.slice(3, -3);
		// If the opener has a language tag (`text\n…`), drop just that line.
		const nl = s.indexOf("\n");
		if (nl >= 0 && /^[a-z0-9-]*$/i.test(s.slice(0, nl))) {
			s = s.slice(nl + 1);
		}
		s = s.trim();
	}
	// Strip wrapping quotes and stray punctuation, ASCII + curly.
	s = s.replace(/^["'`\u201C\u2018]+/, "").replace(/["'`\u201D\u2019]+$/, "");
	// Collapse the first line — model output is supposed to be single-line
	// but be tolerant of trailing prose.
	const nl = s.indexOf("\n");
	if (nl >= 0) s = s.slice(0, nl);
	const tokens = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return tokens.slice(0, maxTokens).join("-").slice(0, maxLength);
}

/**
 * Prompt for the fast-tier background model. Mirrors the style of
 * `session-title`'s `buildAutoTitlePrompt` — strict rules, single-line
 * output, no quotes/punctuation.
 */
export function buildSlugPrompt(description: string): string {
	const trimmed = description.trim();
	const clipped =
		trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}\u2026` : trimmed;
	return [
		"You are naming a git branch for a coding-agent change.",
		"",
		"Rules:",
		"- 3 to 5 words.",
		"- kebab-case (lowercase, alphanumerics joined with single hyphens).",
		"- No prefix (no `feat/`, `fix/`, etc — the caller adds that).",
		"- Describe the concrete *intent* of the change, not the user's wording.",
		"- No quotes, no trailing punctuation, no surrounding text.",
		"",
		"Output ONLY the slug on a single line.",
		"",
		"<description>",
		clipped,
		"</description>",
	].join("\n");
}

/** Env-var override for the slug model, mirroring `PI_SESSION_AUTO_TITLE_MODEL`. */
const ENV_SLUG_MODEL = "PI_DEVELOP_SLUG_MODEL";

/**
 * Indirection so tests can inject a fake `completeSimple` without standing
 * up a real provider. Default is the real one from `@mariozechner/pi-ai`.
 */
export type CompleteSimpleFn = typeof completeSimple;

export interface SlugifyWithModelOptions {
	maxTokens?: number;
	maxLength?: number;
	/** Test seam — defaults to the real `completeSimple` from pi-ai. */
	_complete?: CompleteSimpleFn;
	/** Test seam — defaults to the real `resolveModel` from `_shared`. */
	_resolveModel?: typeof resolveModel;
}

/**
 * Smart kebab-case slug. Resolves a `fast`-tier background model via the
 * shared resolver and asks it for a short slug describing the intent.
 * Falls back to the offline `slugify()` when:
 *   - no model resolves (no config, no auth, offline, …),
 *   - the model errors / aborts,
 *   - the model returns something that sanitizes to an empty slug.
 */
export async function slugifyWithModel(
	ctx: ExtensionContext,
	description: string,
	opts: SlugifyWithModelOptions = {},
): Promise<string> {
	const maxTokens = opts.maxTokens ?? 5;
	const maxLength = opts.maxLength ?? 50;
	const fallback = () => slugify(description, { maxTokens, maxLength });

	const resolve = opts._resolveModel ?? resolveModel;
	const complete = opts._complete ?? completeSimple;

	const envOverride = process.env[ENV_SLUG_MODEL]?.trim();
	let picked: {
		model: Model<Api>;
		apiKey?: string;
		headers?: Record<string, string>;
	} | null;
	try {
		picked = await resolve(ctx, {
			name: "develop",
			tier: "fast",
			explicit: envOverride || undefined,
			requireApiKey: true,
		});
	} catch {
		return fallback();
	}
	if (!picked?.apiKey) return fallback();

	try {
		const response = await complete(
			picked.model,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: buildSlugPrompt(description),
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: picked.apiKey,
				headers: picked.headers,
				maxTokens: 32,
				reasoning: "minimal",
				signal: ctx.signal,
			},
		);
		const raw = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const slug = sanitizeSlug(raw, { maxTokens, maxLength });
		return slug || fallback();
	} catch {
		return fallback();
	}
}

/** `feat/add-payment-webhooks` style branch name. Empty slug → empty string. */
export function deriveBranchName(description: string): string {
	const slug = slugify(description);
	if (!slug) return "";
	return `${derivePrefix(description)}${slug}`;
}

/**
 * Async branch name: model-driven slug + deterministic verb-based prefix.
 * The prefix logic stays sync (it's a stable keyword match); only the slug
 * benefits from the LLM. Empty slug → empty string, same contract as
 * `deriveBranchName`.
 */
export async function deriveBranchNameWithModel(
	ctx: ExtensionContext,
	description: string,
	opts: SlugifyWithModelOptions = {},
): Promise<string> {
	const slug = await slugifyWithModel(ctx, description, opts);
	if (!slug) return "";
	return `${derivePrefix(description)}${slug}`;
}

/**
 * Cheap heuristic: does this raw description warrant an intake conversation?
 * Empty / one-token / all-punctuation inputs do; 5+ alphanumeric tokens are
 * substantive enough to skip intake and go straight to plan mode.
 */
export function needsIntake(description: string): boolean {
	const tokens = description.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return tokens.length < 5;
}

/**
 * Follow-up message that puts the agent in *intake* mode: read-only tools,
 * a `develop_ready` tool to signal when it's gathered enough context, and
 * an instruction to ask focused questions before proceeding.
 */
export function buildIntakePrompt(rawDescription: string): string {
	const trimmed = rawDescription.trim();
	const hasInput = trimmed.length > 0;
	return [
		"You are now in /develop INTAKE mode. The extension has restricted your",
		"tools to read/grep/find/ls and a read-only subset of bash, plus the",
		"`develop_ready` tool. No edits or writes will run until intake is over.",
		"",
		"Goal: produce a single-paragraph firmed-up description of what the",
		"user wants to change and why, then call `develop_ready` with it.",
		"",
		"Process:",
		"  1. Read just enough of the repo (root README, CLAUDE.md, the area",
		"     the user gestured at) to ask focused questions.",
		"  2. Ask the user one tight batch of questions at a time, max ~3",
		'     turns total. Stay specific — no "what\'s your goal in life".',
		"  3. When you understand the intent well enough to plan, call",
		'     `develop_ready` with `{ description: "…" }`. Pi will then',
		"     transition into plan mode automatically.",
		"  4. If the user's input below is already specific enough, skip the",
		"     questions and call `develop_ready` immediately.",
		"",
		"---",
		"",
		hasInput
			? `User request (possibly thin — clarify as needed): ${trimmed}`
			: "User request: (none — they invoked /develop with no arguments; ask what they want to build).",
	].join("\n");
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
