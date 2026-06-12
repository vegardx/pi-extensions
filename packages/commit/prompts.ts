/**
 * Prompt builders for the commit extension.
 *
 * Each function returns a system/user prompt string for a specific
 * stage of the commit workflow. Exported for unit testing.
 */

import type { PrMetadata } from "./gh.js";

/**
 * Build the planning prompt that instructs the agent to analyze the
 * working tree and propose a conventional-commit plan.
 */
export function buildPlanPrompt(
	guidance: string | undefined,
	diffSummary: string,
	mode?: string,
): string {
	const finishLine =
		mode === "auto"
			? "Yield back to the extension; it will confirm the plan and sequence /ship and the next phase."
			: "Finish the turn after writing the plan.";
	return [
		"You are in the `/commit` flow. Analyze the current working tree and",
		"propose a commit plan. Read `skills/gh/SKILL.md` if you need any",
		"GitHub conventions; otherwise just look at the diff.",
		"",
		"Gather context yourself — the diff is NOT included here so you can",
		"use read-only bash freely:",
		"",
		"```bash",
		"git status --short",
		"git diff --stat",
		"git diff",
		"git diff --cached",
		"```",
		"",
		diffSummary,
		"",
		"Produce a plan with either:",
		"",
		"- **One commit** when all changes serve the same purpose. Conventional",
		"  commit format: `type(scope): short subject`. Subject ≤ 72 chars.",
		"  Include a body only when the change needs explanation.",
		"- **Multiple commits** when changes span unrelated concerns. Order them",
		"  meaningfully. For each: which files go in, the commit message, and",
		"  the staging commands (`git add <explicit paths>` — never `git add -A`",
		"  or `git add .` because that would stage everything, including .env).",
		"",
		"Valid types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`,",
		"`style`, `perf`, `ci`, `build`.",
		"",
		guidance
			? `User guidance: ${guidance} (use as the starting point, adjust for conventional format if needed).`
			: "The user didn't provide guidance — derive everything from the diff.",
		"",
		"Output the plan as readable markdown. Do NOT commit anything yet —",
		"the extension will ask for explicit confirmation before anything is",
		`staged or committed. ${finishLine}`,
	].join("\n");
}

/**
 * Build the execution prompt that instructs the agent to carry out
 * the commit plan it proposed (or the user-edited version).
 */
export function buildExecutePrompt(
	overrideInstructions: string | null,
	mode?: string,
): string {
	const afterCommitLine =
		mode === "auto"
			? "Yield back to the extension; it will sequence /ship and the next phase."
			: "Stop after the last commit — do not push.";
	if (overrideInstructions) {
		return [
			"User edited the commit plan. Execute the plan below exactly as",
			"written — run `git add <explicit paths>` and `git commit -m '...'`",
			"for each commit in order. Do not make additional commits beyond",
			"what's specified.",
			"",
			"---",
			"",
			overrideInstructions,
		].join("\n");
	}
	return [
		"Execute the commit plan you just proposed. For each commit in order:",
		"",
		"1. `git add <explicit paths>` (never `git add -A`, `git add -u`, or",
		"   `git add .` — they can stage .env and other excluded files).",
		"2. `git commit -m '<subject>'` with the conventional-commit message",
		"   from your plan. Multi-line bodies: pass additional `-m` args or",
		"   write the message to a temp file and use `-F`.",
		"",
		"After every commit, run `git log -1 --oneline` so the user can",
		`verify. ${afterCommitLine}`,
	].join("\n");
}

/**
 * Build the prompt for PR title/body generation.
 */
export function buildPrPrompt(
	branch: string,
	trackingIssue: string | null,
	existing: PrMetadata | null,
): string {
	const parts = [
		"Write the pull-request title and body for this branch. Gather the",
		"context yourself:",
		"",
		"```bash",
		`git log --reverse --no-merges origin/${"$default"}..HEAD --format='%s%n%b%n---'`,
		"git diff --stat origin/" + "$default" + "..HEAD",
		"```",
		"",
		"Replace `$default` with the default branch name (usually `main` or",
		"`master`; check `git symbolic-ref refs/remotes/origin/HEAD`).",
		"",
		"## PR writing rules",
		"",
		"- Describe what the diff does now — not alternatives, prior",
		"  iterations, or discarded approaches.",
		"- Plain factual language. No filler words like *critical*, *crucial*,",
		"  *essential*, *significant*, *comprehensive*, *robust*, *elegant*.",
		"- Title follows conventional-commit style matching the commit(s).",
		"- Body: brief summary paragraph, then optional bullet list of",
		"  concrete changes. Keep it short.",
	];
	if (trackingIssue) {
		parts.push(
			"",
			`- **Tracking issue**: this branch has \`branch.${branch}.tracking-issue\` set`,
			`  to #${trackingIssue}. End the body with \`Closes #${trackingIssue}\` on its`,
			"  own line so GitHub auto-closes the issue when the PR merges.",
		);
	}
	if (existing) {
		parts.push(
			"",
			`**Existing PR**: #${existing.number} — "${existing.title}".`,
			"Regenerate the title and body from scratch based on the current",
			"commits on the branch; the user will decide whether to overwrite",
			"the existing metadata.",
		);
	}
	parts.push(
		"",
		"## Output format",
		"",
		"Wrap your output in these exact sentinels so the extension can",
		"parse it. No other content between them:",
		"",
		"```",
		"---TITLE---",
		"short one-line title",
		"---BODY---",
		"multi-line markdown body",
		"---END---",
		"```",
		"",
		"Free-form commentary around the sentinels is fine; the extension",
		"only reads what's between them. Finish the turn after emitting them.",
	);
	return parts.join("\n");
}
