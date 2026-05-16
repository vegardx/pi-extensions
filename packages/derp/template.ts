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
import type { CrashReportSummary } from "./crash-reports.js";

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
 * Render the crash-report tail. Each report is already redacted at
 * write time, so we copy verbatim. We render the high-signal fields
 * (origin, error, state) inline and the recent-entry tail inside a
 * fenced block, plus the source path so the user can recover the
 * raw JSON. Returns null when there are no reports.
 */
function renderCrashReports(
	reports: readonly CrashReportSummary[],
): string | null {
	if (reports.length === 0) return null;
	const blocks: string[] = [];
	for (const r of reports) {
		const rows: string[] = [];
		rows.push(`- **When:** ${r.timestamp}`);
		rows.push(`- **Origin:** \`${r.origin}\``);
		rows.push(
			`- **Error:** ${r.error.name ? `\`${r.error.name}\` — ` : ""}${r.error.message}`,
		);
		if (r.state.mode || r.state.stage) {
			rows.push(
				`- **Mode/stage:** ${r.state.mode ?? "?"} / ${r.state.stage ?? "?"}`,
			);
		}
		if (r.state.branch) rows.push(`- **Branch:** \`${r.state.branch}\``);
		if (r.state.planSlug) {
			rows.push(
				`- **Plan / phase:** \`${r.state.planSlug}\`${
					r.state.activePhaseId ? ` / \`${r.state.activePhaseId}\`` : ""
				}`,
			);
		}
		if (r.redactionHits.length > 0) {
			rows.push(
				`- **Redaction hits:** ${r.redactionHits.map((k) => `\`${k}\``).join(", ")}`,
			);
		}
		rows.push(`- **Source:** \`${r.sourcePath}\``);

		let block = rows.join("\n");
		if (r.error.stack) {
			block += `\n\n<details><summary>Stack</summary>\n\n\`\`\`\n${r.error.stack}\n\`\`\`\n</details>`;
		}
		blocks.push(block);
	}
	return blocks.join("\n\n---\n\n");
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
	const crashBlock = renderCrashReports(ctx.crashReports);
	if (crashBlock) {
		lines.push("## Crash reports");
		lines.push("");
		lines.push(
			"The session emitted one or more uncaught errors during /implement. Each block below is captured verbatim from disk and is already redacted. Copy them into the issue body verbatim — do not paraphrase or omit fields.",
		);
		lines.push("");
		lines.push(crashBlock);
		lines.push("");
	}
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
	const crashBlock = renderCrashReports(ctx.crashReports);
	if (crashBlock) {
		sections.push("## Crash reports");
		sections.push("");
		sections.push(crashBlock);
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
