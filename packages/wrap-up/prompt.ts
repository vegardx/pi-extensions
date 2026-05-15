/**
 * Pure prompt builders for /pause and /continue.
 *
 * No I/O, no imports from pi — takes a WrapUpContext and returns the
 * instruction string to send to the agent.
 */

import type { HandoverConfig, WrapUpContext } from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fence(lang: string, content: string): string {
	if (!content.trim()) return "(none)";
	return `\`\`\`${lang}\n${content.trim()}\n\`\`\``;
}

/**
 * Sanitize a value for YAML frontmatter emitted in double-quoted scalars.
 * In YAML double-quoted strings, backslashes introduce escape sequences
 * (e.g. `\n`, `\UHHHHHHHH`), so raw backslashes must be escaped as `\\`.
 * Double-quotes and newlines are stripped entirely to avoid breaking the
 * scalar framing.
 */
function fmSafe(value: string): string {
	// Escape backslashes first (must come before the quote/newline strip so
	// we don't double-escape), then remove chars that would break the YAML
	// double-quoted scalar.
	return value.replace(/\\/g, "\\\\").replace(/["\n\r]/g, "");
}

/**
 * Strip embedded credentials from a git remote URL.
 * e.g. https://x-access-token:ghp_xxx@github.com/o/r.git → https://github.com/o/r.git
 */
function stripCredentials(url: string): string {
	return url.replace(/\/\/[^@]+@/, "//");
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
 * Build the full /pause prompt. Pure function — given the same context
 * it always returns the same string.
 */
export function buildPausePrompt(
	ctx: WrapUpContext,
	handover: HandoverConfig,
): string {
	const lines: string[] = [];

	lines.push(
		"You are running the `/pause` flow. Your job is to produce a detailed",
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

	// Session metadata
	if (ctx.sessionName) {
		snapshotParts.push(`Session name: ${ctx.sessionName}`);
	}
	snapshotParts.push(`Session ID:   ${ctx.sessionId}`);
	if (ctx.sessionFile) {
		snapshotParts.push(`Session file: ${ctx.sessionFile}`);
	}

	if (ctx.branch) {
		snapshotParts.push(`Branch:       ${ctx.branch}`);
	}
	if (ctx.upstream) {
		snapshotParts.push(`Upstream:     ${ctx.upstream}`);
	}
	if (ctx.remoteUrl) {
		// CWE-532: strip embedded credentials consistently — same guard
		// already applied to the frontmatter repo field below.
		snapshotParts.push(`Remote:       ${stripCredentials(ctx.remoteUrl)}`);
	}
	if (ctx.prInfo) {
		snapshotParts.push(`PR:           ${formatPr(ctx.prInfo)}`);
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

	// Build the YAML frontmatter values the agent must emit.
	const fmLines: string[] = [];
	fmLines.push(`date: "${fmSafe(ctx.date)}"`);
	fmLines.push(`session_id: "${fmSafe(ctx.sessionId.slice(0, 8))}"`);
	if (ctx.remoteUrl)
		fmLines.push(`repo: "${fmSafe(stripCredentials(ctx.remoteUrl))}"`);
	if (ctx.branch) fmLines.push(`branch: "${fmSafe(ctx.branch)}"`);
	fmLines.push(`cwd: "${fmSafe(ctx.sessionCwd)}"`);

	lines.push(
		"## Step 3 — Write the handover document",
		"",
		"The file MUST start with a YAML frontmatter block (fenced by `---`).",
		"Use exactly these values:",
		"",
		"```yaml",
		"---",
		...fmLines,
		"---",
		"```",
		"",
		"Then produce the body in the following structure. Be specific and",
		"verbose — assume the next session has no memory of this one.",
		"",
		"```",
		`## Session Handover — ${ctx.date}`,
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
		ctx.sessionFile
			? `  Or resume the session directly: pi --resume (select session ${ctx.sessionId.slice(0, 8)})`
			: "",
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

	// --- Save to file ---
	const stepNum = ctx.resources.length > 0 ? 5 : 4;
	lines.push(`## Step ${stepNum} — Save handover document`, "");

	if (handover.autoSave) {
		lines.push(
			`Write the handover document above to \`${handover.fullPath}\` immediately.`,
			"Create the directory if it does not exist. Do not ask for confirmation.",
			"After writing, tell the user the file was saved and show the path.",
			"",
		);
	} else {
		lines.push(
			`Ask: "Should I save this handover to \`${handover.fullPath}\`?"`,
			"If yes, write the file, creating the directory if needed, then confirm the path.",
			"",
		);
	}

	lines.push(
		"## Rules",
		"",
		"- NEVER run any git command (git add, git commit, git push, etc.).",
		"  The handover document is NOT part of the repository and must NOT be committed.",
		`- Write the handover ONLY to \`${handover.fullPath}\`. Do NOT write`,
		"  SESSION_NOTES.md or any other file to the project working directory.",
		"- The YAML frontmatter MUST be the very first thing in the file, exactly",
		"  as shown above. Do not change the keys or values.",
		"- Write the handover document first, then ask about resources, then save.",
		"  Do not ask permission before writing the document itself.",
		"- Keep the document factual and actionable. No filler.",
		"- If you are uncertain about something (e.g. what the original goal was),",
		"  say so explicitly in the document rather than guessing.",
		"- Finish the turn after all questions are answered or the user says done.",
	);

	return lines.join("\n");
}

/**
 * Build the /continue prompt. Injects the handover body and asks the
 * agent to summarize it and ask the user how to proceed.
 */
export function buildContinuePrompt(handoverBody: string): string {
	const lines: string[] = [];

	lines.push(
		"You are running the `/continue` flow. A previous session's handover",
		"document has been loaded. Your job is to orient the user and ask what",
		"they want to do next.",
		"",
		"## Handover document",
		"",
		handoverBody,
		"",
		"## Instructions",
		"",
		"1. Read the handover above carefully.",
		"2. Present a concise summary to the user:",
		"   - What was the goal",
		"   - What's done vs. still in progress",
		"   - Key blockers or open questions",
		"3. Then ask the user how they'd like to proceed. Offer concrete options",
		"   based on what's in the handover, for example:",
		'   - "Pick up the next steps?"',
		'   - "Re-plan the remaining work?"',
		'   - "Review what was done first?"',
		'   - "Something else?"',
		"4. Wait for the user to respond before taking any action.",
		"",
		"## Rules",
		"",
		"- Be concise. The user wrote the handover — they don't need it read back",
		"  verbatim. Summarize the key state in a few lines.",
		"- Do NOT start editing files or running commands until the user tells you",
		"  what to do.",
		"- Do NOT enter any mode (plan/auto) automatically.",
	);

	return lines.join("\n");
}
