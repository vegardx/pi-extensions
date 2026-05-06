/**
 * Pure plan/execution helpers for /develop.
 *
 * Ported from pi's `examples/extensions/plan-mode/utils.ts` (MIT) so /develop
 * can reuse the same plan-extraction and progress-tracking patterns. Kept as
 * a small standalone module so the pi upstream can evolve its example without
 * breaking us; if the upstream publishes a reusable package later, we can
 * swap to it.
 */

/** A single numbered step parsed from a `Plan:` section. */
export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

// ---- Bash safety classifier --------------------------------------------
//
// During plan phase the agent should be read-only. We swap the active
// toolset to exclude `edit`/`write`, but we still allow `bash` — some useful
// exploration (`rg`, `jq`, `git log`, `git diff`) is read-only but lives in
// bash. The `tool_call` handler uses `isSafeCommand` to block the
// destructive majority while letting the read-only exploration through.

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	// Output redirection — blocks writes to any file.
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	// Git write operations — plan phase must not mutate the repo.
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS: readonly RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/**
 * `true` iff `command` matches at least one safe pattern AND no destructive
 * pattern. When in doubt, blocks. Callers should surface the block to the
 * user with the offending command so they can hand-type it if they really
 * need it.
 */
export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	if (isDestructive) return false;
	return SAFE_PATTERNS.some((p) => p.test(command));
}

// ---- Plan extraction ---------------------------------------------------

/**
 * Tidy a raw step string into a short, readable label for the todo widget.
 * Strips markdown emphasis / inline code, trims leading verbs, caps length.
 */
export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // bold / italic
		.replace(/`([^`]+)`/g, "$1") // inline code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 60) cleaned = `${cleaned.slice(0, 57)}...`;
	return cleaned;
}

/**
 * Parse numbered steps under a `Plan:` header. Accepts `Plan:`, `**Plan:**`,
 * or `## Plan:` with any surrounding whitespace. Returns `[]` when no such
 * header exists.
 *
 * Each step must:
 * - Be a line starting with `<digits>.` or `<digits>)` (optionally bolded).
 * - Produce a cleaned text at least 4 chars long.
 * - Not start with `` ` ``, `/`, or `-` — those look like code / paths /
 *   bullets and are almost never actual todo items.
 */
export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/(^|\n)#{0,6}\s*\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(
		message.indexOf(headerMatch[0]) + headerMatch[0].length,
	);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;
	for (const match of planSection.matchAll(numberedPattern)) {
		const raw = (match[2] ?? "")
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (
			raw.length > 5 &&
			!raw.startsWith("`") &&
			!raw.startsWith("/") &&
			!raw.startsWith("-")
		) {
			const cleaned = cleanStepText(raw);
			if (cleaned.length > 3) {
				items.push({
					step: items.length + 1,
					text: cleaned,
					completed: false,
				});
			}
		}
	}
	return items;
}

// ---- Progress tracking --------------------------------------------------

/** All `[DONE:n]` step numbers referenced in `message`. Dedupes. */
export function extractDoneSteps(message: string): number[] {
	const steps = new Set<number>();
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step) && step >= 1) steps.add(step);
	}
	return [...steps].sort((a, b) => a - b);
}

/**
 * Apply `[DONE:n]` markers in `text` to `items` in place. Returns the number
 * of items newly marked complete (items already complete don't count, so the
 * caller can skip a widget update when nothing changed).
 */
export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	let newly = 0;
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			newly++;
		}
	}
	return newly;
}

// ---- Post-execution picker options ----------------------------------

/**
 * Gate the post-execution follow-up picker on which target extensions
 * are actually installed. Returns the picker option labels in display
 * order. `Stay here` is always present.
 */
export function buildPostLoopPickerOptions(opts: {
	installedCommands: ReadonlySet<string>;
}): string[] {
	const options: string[] = [];
	if (opts.installedCommands.has("review")) {
		options.push("Run /review");
	}
	if (opts.installedCommands.has("commit")) {
		options.push("Run /commit");
	}
	options.push("Stay here — I'll handle it");
	return options;
}

// ---- Auto-review state transitions ------------------------------------
//
// `/develop` runs a focused cross-model review after execution
// completes, before the post-execution picker. Two pure helpers below
// cover the state-machine decisions; the extension owns the side effects.

/**
 * Decide what /develop should do once `runAutoReview` returns. Two
 * outcomes:
 *   - `apply-fixes` — at least one cross-model consensus finding was
 *     queued for the host agent. Transition to
 *     `awaiting-auto-review-fix` and wait for the next `agent_end`
 *     to fire the post-execution picker.
 *   - `skip-to-picker` — no consensus findings (or the pass aborted
 *     before fan-out). Run the picker directly.
 */
export type AutoReviewNextAction = "apply-fixes" | "skip-to-picker";
export function decideAutoReviewNextAction(opts: {
	ran: boolean;
	appliedCount: number;
}): AutoReviewNextAction {
	if (!opts.ran) return "skip-to-picker";
	if (opts.appliedCount <= 0) return "skip-to-picker";
	return "apply-fixes";
}
