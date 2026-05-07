/**
 * Branch naming, issue title derivation, and secret scanning for /modes.
 * Mirrors the relevant parts of develop/helpers.ts; kept as a local copy
 * so modes does not depend on the develop package (which will be removed).
 */

import type { Api, Model } from "@mariozechner/pi-ai";

// completeSimple is imported dynamically inside slugifyWithModel so a missing
// @mariozechner/pi-ai at load time doesn’t crash the extension.
type PiAiModule = typeof import("@mariozechner/pi-ai");
export type CompleteSimpleFn = PiAiModule["completeSimple"];

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";

export type BranchPrefix = "feat/" | "fix/" | "refactor/" | "docs/" | "chore/";

interface PrefixRule {
	prefix: BranchPrefix;
	keywords: readonly string[];
}

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

export function derivePrefix(description: string): BranchPrefix {
	const text = description.toLowerCase();
	for (const rule of PREFIX_RULES) {
		for (const kw of rule.keywords) {
			const re = new RegExp(`\\b${kw}\\b`);
			if (re.test(text)) return rule.prefix;
		}
	}
	return "feat/";
}

export function slugify(
	description: string,
	opts: { maxTokens?: number; maxLength?: number } = {},
): string {
	const maxTokens = opts.maxTokens ?? 5;
	const maxLength = opts.maxLength ?? 50;
	const tokens = description.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return tokens.slice(0, maxTokens).join("-").slice(0, maxLength);
}

export function sanitizeSlug(
	raw: string,
	opts: { maxTokens?: number; maxLength?: number } = {},
): string {
	const maxTokens = opts.maxTokens ?? 5;
	const maxLength = opts.maxLength ?? 50;
	let s = raw.trim();
	if (s.startsWith("```") && s.endsWith("```") && s.length >= 6) {
		s = s.slice(3, -3);
		const nl = s.indexOf("\n");
		if (nl >= 0 && /^[a-z0-9-]*$/i.test(s.slice(0, nl))) {
			s = s.slice(nl + 1);
		}
		s = s.trim();
	}
	s = s.replace(/^["'`\u201C\u2018]+/, "").replace(/["'`\u201D\u2019]+$/, "");
	const nl = s.indexOf("\n");
	if (nl >= 0) s = s.slice(0, nl);
	const tokens = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	return tokens.slice(0, maxTokens).join("-").slice(0, maxLength);
}

function buildSlugPrompt(description: string): string {
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

const ENV_SLUG_MODEL = "PI_MODES_SLUG_MODEL";

export interface SlugifyWithModelOptions {
	maxTokens?: number;
	maxLength?: number;
	/**
	 * Test seam — override the LLM completion function in tests without
	 * standing up a real provider. Not intended for production use.
	 */
	_complete?: CompleteSimpleFn;
	/**
	 * Test seam — override the model resolver in tests.
	 * Not intended for production use.
	 */
	_resolveModel?: typeof resolveModel;
}

export async function slugifyWithModel(
	ctx: ExtensionContext,
	description: string,
	opts: SlugifyWithModelOptions = {},
): Promise<string> {
	const maxTokens = opts.maxTokens ?? 5;
	const maxLength = opts.maxLength ?? 50;
	const fallback = () => slugify(description, { maxTokens, maxLength });

	const resolve = opts._resolveModel ?? resolveModel;
	const complete =
		opts._complete ??
		(await import("@mariozechner/pi-ai")
			.then((m) => m.completeSimple)
			.catch(() => null));
	if (!complete) return fallback();

	const envOverride = process.env[ENV_SLUG_MODEL]?.trim();
	let picked: {
		model: Model<Api>;
		apiKey?: string;
		headers?: Record<string, string>;
	} | null;
	try {
		picked = await resolve(ctx, {
			name: "modes",
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
							{ type: "text" as const, text: buildSlugPrompt(description) },
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

export function deriveBranchName(description: string): string {
	const slug = slugify(description);
	if (!slug) return "";
	return `${derivePrefix(description)}${slug}`;
}

export async function deriveBranchNameWithModel(
	ctx: ExtensionContext,
	description: string,
	opts: SlugifyWithModelOptions = {},
): Promise<string> {
	const slug = await slugifyWithModel(ctx, description, opts);
	if (!slug) return "";
	return `${derivePrefix(description)}${slug}`;
}

export interface SecretScanResult {
	hasSecret: boolean;
	reason?: string;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	// Named-prefix credentials: GitHub PATs/Actions/App tokens, GitLab tokens,
	// OpenAI/Anthropic keys, Slack tokens, AWS access keys, npm tokens,
	// JWTs (eyJ…), PEM blocks.
	/\b(?:ghp_|gho_|ghs_|ghx_|glpat-|sk-|sk-proj-|xox[bpras]-|AKIA|npm_|eyJ)[A-Za-z0-9_-]{12,}/i,
	/-----BEGIN\s+[A-Z ]+-----/,
];

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

export function deriveIssueTitle(
	planText: string,
	fallback: string,
	maxLength = 72,
): string {
	const candidate = planText.trim().split("\n")[0]?.trim() ?? "";
	const source = candidate || fallback.trim();
	return source.length > maxLength
		? `${source.slice(0, maxLength - 1)}\u2026`
		: source;
}

/**
 * Derive a description from the last assistant message in the session,
 * for use when /implement is called without an explicit argument.
 * Returns null when nothing useful is found.
 */
export function descriptionFromLastAssistant(
	ctx: ExtensionContext,
): string | null {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const msg = (e as { message?: { role?: string; content?: unknown } })
			.message;
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (typeof content === "string" && content.trim().length > 10)
			return content.trim().slice(0, 500);
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const block of content) {
				if (
					block &&
					typeof block === "object" &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					parts.push((block as { text: string }).text);
				}
			}
			const joined = parts.join(" ").trim();
			if (joined.length > 10) return joined.slice(0, 500);
		}
	}
	return null;
}
