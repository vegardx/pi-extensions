/**
 * Title + body construction for /idea.
 *
 * Two paths land here:
 *
 *   1. Successful polish — the subagent returned `{ title, body }`.
 *      We sanitize/prefix the title and use the body verbatim.
 *   2. Polish failed (timeout, malformed JSON, no model) — we build
 *      the same shape from `IdeaContext` deterministically so the
 *      issue still gets filed with reasonable content.
 *
 * Mirrors `derp/template.ts` but framed as "feature idea /
 * improvement suggestion" rather than "bug report".
 */

import type { IdeaContext, RecentEntry } from "./context.js";

export type { IssueDraft } from "@vegardx/pi-extensions-shared/gh-issue.js";

import type { IssueDraft } from "@vegardx/pi-extensions-shared/gh-issue.js";

const TITLE_MAX = 80;

/**
 * Apply the configured prefix and clamp to TITLE_MAX. The prefix is
 * counted against the limit so the resulting title still fits in
 * GitHub's UI without truncation.
 */
export function applyTitlePrefix(title: string, prefix: string): string {
	const clean = title.trim().replace(/\s+/g, " ");
	const withPrefix =
		prefix && !clean.startsWith(prefix.trim()) ? `${prefix}${clean}` : clean;
	if (withPrefix.length <= TITLE_MAX) return withPrefix;
	return `${withPrefix.slice(0, TITLE_MAX - 1)}…`;
}

/**
 * Render the recent-entries tail as a fenced markdown block. Empty
 * tail produces `"_(no recent session entries)_"` so the body stays
 * grammatical.
 */
function renderRecentEntries(entries: readonly RecentEntry[]): string {
	if (entries.length === 0) return "_(no recent session entries)_";
	const blocks: string[] = [];
	for (const e of entries) {
		blocks.push(`**${e.role}:**\n\n\`\`\`\n${e.text}\n\`\`\``);
	}
	return blocks.join("\n\n");
}

/**
 * Render an "Environment" key/value list. Only includes fields that
 * are always safe to publish.
 */
function renderEnvironment(ctx: IdeaContext): string {
	const rows: string[] = [];
	rows.push(`- **Filed against:** \`${ctx.origin.slug}\``);
	if (ctx.piVersion) rows.push(`- **pi version:** \`${ctx.piVersion}\``);
	rows.push(`- **Date:** ${ctx.date}`);
	return rows.join("\n");
}

function renderSessionRef(ctx: IdeaContext): string {
	const rows: string[] = [];
	rows.push(`- **Session id:** \`${ctx.sessionId}\``);
	if (ctx.sessionName) rows.push(`- **Session name:** ${ctx.sessionName}`);
	return rows.join("\n");
}

/**
 * The markdown payload sent to the polish subagent. The system
 * prompt at `system-prompt.md` instructs the subagent to return
 * `{ "title": "...", "body": "..." }` JSON only.
 */
export function buildPolishTask(ctx: IdeaContext): string {
	const lines: string[] = [];
	lines.push("# /idea — polish into a GitHub issue");
	lines.push("");
	lines.push(
		"You are turning a developer's quick idea/improvement note into a clean GitHub issue.",
	);
	lines.push("");
	lines.push("## User-supplied idea text");
	lines.push("");
	lines.push("```");
	lines.push(ctx.userText);
	lines.push("```");
	lines.push("");
	lines.push("## Environment");
	lines.push("");
	lines.push(renderEnvironment(ctx));
	lines.push("");

	lines.push("## Recent session activity");
	lines.push("");
	lines.push(renderRecentEntries(ctx.recentEntries));
	lines.push("");
	lines.push("## Session reference");
	lines.push("");
	lines.push(renderSessionRef(ctx));
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push('Return JSON only — `{ "title": "…", "body": "…" }`.');
	lines.push(
		"Title: factual, ≤80 chars, no leading prefix (the caller adds one). Frame as a proposal/improvement.",
	);
	lines.push(
		"Body: include sections — Summary, Motivation, Proposed change, Open questions, Environment, Session reference. Verbatim-copy the Environment and Session-reference blocks above; do not invent values.",
	);
	return lines.join("\n");
}

/**
 * Deterministic fallback used when polish fails. Title is the
 * user's text (first line, clamped); body is a templated assembly
 * of the context fields.
 */
export function buildFallbackIssue(
	ctx: IdeaContext,
	titlePrefix: string,
): IssueDraft {
	const firstLine = ctx.userText.split(/\r?\n/, 1)[0] ?? ctx.userText;
	const title = applyTitlePrefix(firstLine, titlePrefix);

	const sections: string[] = [];
	sections.push("## Summary");
	sections.push("");
	sections.push("_Filed via `/idea` — polish step skipped, raw note below._");
	sections.push("");
	sections.push("## Idea");
	sections.push("");
	sections.push("```");
	sections.push(ctx.userText);
	sections.push("```");
	sections.push("");
	sections.push("## Environment");
	sections.push("");
	sections.push(renderEnvironment(ctx));
	sections.push("");

	if (ctx.recentEntries.length > 0) {
		sections.push("## Recent session activity");
		sections.push("");
		sections.push(renderRecentEntries(ctx.recentEntries));
		sections.push("");
	}
	sections.push("## Session reference");
	sections.push("");
	sections.push(renderSessionRef(ctx));

	return { title, body: sections.join("\n") };
}
