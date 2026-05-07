/**
 * Pure prompt builder for /wrap-up.
 *
 * No I/O, no imports from pi — takes a WrapUpContext and returns the
 * instruction string to send to the agent.
 */

import type { WrapUpContext } from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fence(lang: string, content: string): string {
	if (!content.trim()) return "(none)";
	return `\`\`\`${lang}\n${content.trim()}\n\`\`\``;
}

/** Parse `gh pr view --json` output into a one-liner, best-effort. */
function formatPr(prJson: string): string {
	try {
		const pr = JSON.parse(prJson) as {
			number?: number;
			title?: string;
			url?: string;
			state?: string;
			isDraft?: boolean;
		};
		const parts: string[] = [];
		if (pr.url) parts.push(pr.url);
		if (pr.title) parts.push(`"${pr.title}"`);
		if (pr.state) parts.push(`[${pr.isDraft ? "DRAFT " : ""}${pr.state}]`);
		return parts.join(" — ");
	} catch {
		return prJson;
	}
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the full /wrap-up prompt. Pure function — given the same context
 * it always returns the same string.
 */
export function buildWrapUpPrompt(ctx: WrapUpContext): string {
	const lines: string[] = [];

	lines.push(
		"You are running the `/wrap-up` flow. Your job is to produce a detailed",
		"handover document so that a future session — whether it starts fresh or",
		"from a compacted context — can pick up exactly where this one left off.",
		"",
		"## Step 1 — Read the session history",
		"",
		"Scan all messages in this conversation. Extract:",
		"- The original goal or task the user was working toward",
		"- Every concrete change made (files edited, commands run, decisions taken)",
		"- What is in progress but not yet finished",
		"- Any dead ends or approaches that were tried and abandoned",
		"- Unresolved questions or blockers",
		"",
		"## Step 2 — Review the git snapshot below",
		"",
		"The following context was captured when `/wrap-up` was invoked:",
		"",
	);

	// --- Git snapshot ---
	const snapshotParts: string[] = [];

	if (ctx.branch) {
		snapshotParts.push(`Branch: ${ctx.branch}`);
	}
	if (ctx.upstream) {
		snapshotParts.push(`Upstream: ${ctx.upstream}`);
	}
	if (ctx.remoteUrl) {
		snapshotParts.push(`Remote: ${ctx.remoteUrl}`);
	}
	if (ctx.prInfo) {
		snapshotParts.push(`PR: ${formatPr(ctx.prInfo)}`);
	}

	if (snapshotParts.length > 0) {
		lines.push("**Repository state**");
		lines.push("```");
		lines.push(snapshotParts.join("\n"));
		lines.push("```");
		lines.push("");
	}

	if (ctx.recentLog) {
		lines.push("**Recent commits (git log --oneline -15)**");
		lines.push(fence("", ctx.recentLog));
		lines.push("");
	}

	const hasChanges = ctx.statusShort || ctx.diffStat || ctx.stagedDiffStat;
	if (hasChanges) {
		lines.push("**Working tree**");
		lines.push(fence("", ctx.statusShort || "(clean)"));
		lines.push("");
		if (ctx.stagedDiffStat) {
			lines.push("**Staged changes (git diff --cached --stat)**");
			lines.push(fence("", ctx.stagedDiffStat));
			lines.push("");
		}
		if (ctx.diffStat) {
			lines.push("**Unstaged changes (git diff --stat)**");
			lines.push(fence("", ctx.diffStat));
			lines.push("");
		}
	}

	lines.push(
		"## Step 3 — Write the handover document",
		"",
		"Produce a handover document in the following structure. Be specific and",
		"verbose — assume the next session has no memory of this one.",
		"",
		"```",
		`## Session Wrap-Up — ${ctx.date}`,
		"",
		"### Goal",
		"What the session set out to accomplish.",
		"",
		"### Done",
		"Concrete list of what was completed. Include file paths, PR links, commit",
		"SHAs, and decisions made. More detail is better.",
		"",
		"### In progress",
		"What was started but not finished. State clearly (e.g. '60% done —",
		"the scaffold is in place but tests are missing').",
		"",
		"### How to resume",
		"Exact, numbered steps to get back to this point from a clean terminal:",
		"  1. git checkout <branch>",
		"  2. ...",
		"Include any env vars to set, services to start, or commands to run.",
		"",
		"### Next steps",
		"Ordered list of what to do next, with enough context to act immediately.",
		"",
		"### Blockers / open questions",
		"Anything waiting on external input, an unanswered question, or a known",
		"issue that could block the next session.",
		"```",
		"",
	);

	// --- Resource cleanup section ---
	if (ctx.resources.length > 0) {
		lines.push(
			"## Step 4 — Resource cleanup",
			"",
			"The following infrastructure or CI/CD signals were detected in this",
			"project. For each one, ask the user whether anything is currently",
			"running or deployed that might incur cost while they're away, and",
			"whether it should be stopped or torn down before they sign off.",
			"",
			"Detected signals:",
		);
		for (const r of ctx.resources) {
			lines.push(`- **${r.label}** (detected via \`${r.path}\`)`);
		}
		lines.push(
			"",
			"Ask specifically and concisely — one question per resource type.",
			"If the user says something is running, offer to help stop or clean it up.",
			"",
		);
	}

	// --- Save to file offer ---
	lines.push(
		"## Step 5 — Offer to save",
		"",
		`Offer to write the handover document to \`.pi/handover-${ctx.date}.md\`.`,
		"Ask: 'Should I save this to `.pi/handover-" +
			ctx.date +
			".md` for next session?'",
		"If yes, write the file. If the `.pi/` directory doesn't exist, create it.",
		"",
		"## Rules",
		"",
		"- Write the handover document first, then ask about resources, then offer",
		"  to save. Do not ask permission before writing the document.",
		"- Keep the document factual and actionable. No filler.",
		"- If you are uncertain about something (e.g. what the original goal was),",
		"  say so explicitly in the document rather than guessing.",
		"- Finish the turn after all questions are answered or the user says done.",
	);

	return lines.join("\n");
}
