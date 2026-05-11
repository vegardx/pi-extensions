/**
 * Title + body construction for /derp.
 *
 * Two paths land here:
 *
 *   1. Successful polish — the subagent returned `{ title, body }`.
 *      We just sanitize/prefix the title and use the body verbatim.
 *   2. Polish failed (timeout, malformed JSON, no model) — we build
 *      the same shape from `DerpContext` deterministically so the
 *      issue still gets filed with reasonable content.
 *
 * `buildPolishTask` produces the markdown payload sent to the
 * subagent. `buildFallbackIssue` produces the deterministic title +
 * body. Keeping both here means the report shape stays consistent
 * regardless of which path runs.
 */

import type { DerpContext, RecentEntry } from "./context.js";

export interface IssueDraft {
	title: string;
	body: string;
}

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
 * tail produces `"_(no recent session entries)_"` so the issue body
 * stays grammatical.
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
 * are always safe to publish — no cwd, origin, or branch paths that
 * could leak internal hostnames.
 */
function renderEnvironment(ctx: DerpContext): string {
	const rows: string[] = [];
	rows.push("- **Filed against:** `github.com/vegardx/pi-extensions`");
	if (ctx.piVersion) rows.push(`- **pi version:** \`${ctx.piVersion}\``);
	rows.push(`- **Date:** ${ctx.date}`);
	return rows.join("\n");
}

function renderSessionRef(ctx: DerpContext): string {
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
export function buildPolishTask(ctx: DerpContext): string {
	const lines: string[] = [];
	lines.push("# /derp report — polish into a GitHub issue");
	lines.push("");
	lines.push(
		"You are turning a developer's quick bug report into a clean GitHub issue.",
	);
	lines.push("");
	lines.push("## User-supplied report text");
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
		"Title: factual, ≤80 chars, no leading prefix (the caller adds one).",
	);
	lines.push(
		"Body: include sections — Summary, What I was doing, Observed behaviour, Environment, Session reference. Verbatim-copy the Environment and Session-reference blocks above; do not invent values.",
	);
	return lines.join("\n");
}

/**
 * Deterministic fallback used when polish fails. Title is the user's
 * text (first line, clamped); body is a templated assembly of the
 * context fields.
 */
export function buildFallbackIssue(
	ctx: DerpContext,
	titlePrefix: string,
): IssueDraft {
	const firstLine = ctx.userText.split(/\r?\n/, 1)[0] ?? ctx.userText;
	const title = applyTitlePrefix(firstLine, titlePrefix);

	const sections: string[] = [];
	sections.push("## Summary");
	sections.push("");
	sections.push("_Filed via `/derp` — polish step skipped, raw report below._");
	sections.push("");
	sections.push("## Report");
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

// ---------------------------------------------------------------------------
// Polish-output parsing
// ---------------------------------------------------------------------------

/**
 * Validate that a parsed JSON value has the `{ title, body }` shape
 * the polish subagent is supposed to emit. Returns the typed draft
 * or `null` for anything malformed.
 */
export function validatePolishOutput(value: unknown): IssueDraft | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const title = typeof v.title === "string" ? v.title.trim() : "";
	const body = typeof v.body === "string" ? v.body : "";
	if (!title || !body) return null;
	return { title, body };
}
