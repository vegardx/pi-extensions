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

// ---- Auto-verify loop helpers ------------------------------------------
//
// Pure decision logic for /develop's ralph-style verify loop. Lives here
// so it's testable without booting the extension. Index.ts owns the
// side effects (state mutation, dispatch, picker); this module owns the
// "given these inputs, what should happen" math.

/**
 * Minimum shape of a verifier verdict that the loop reasons about.
 * Mirrors the public `VerifierVerdict` type from /verify but kept loose
 * so /develop never cross-imports the verify package.
 */
export interface VerifyVerdictLike {
	step: number;
	status: "done" | "partial" | "missing" | "unverifiable";
}

/**
 * "Concerns" = steps that came back partial or missing. `unverifiable` is
 * not a concern — it means the verifier *can't* tell from the working
 * tree (e.g. "open a PR"), which is fine to exit on. Errors (verifier
 * crashes, JSON parse failures) are tracked separately because they
 * can't be diagnosed by the host agent the same way concerns can.
 */
export function aggregateConcerns(verdicts: readonly VerifyVerdictLike[]): {
	concernSteps: number[];
	isClean: boolean;
} {
	const concernSteps = verdicts
		.filter((v) => v.status === "partial" || v.status === "missing")
		.map((v) => v.step);
	return { concernSteps, isClean: concernSteps.length === 0 };
}

/**
 * No-progress = at least one step that was a concern in the previous
 * iteration is *still* a concern in the current iteration. Other steps
 * shifting around (one heals, another newly breaks) counts as progress
 * — the cap covers eternal regressions.
 *
 * Returns `false` if there's no previous iteration to compare against.
 */
export function detectNoProgress(
	prev: readonly VerifyVerdictLike[] | undefined,
	curr: readonly VerifyVerdictLike[],
): boolean {
	if (!prev || prev.length === 0) return false;
	const prevConcerns = new Set(
		prev
			.filter((v) => v.status === "partial" || v.status === "missing")
			.map((v) => v.step),
	);
	if (prevConcerns.size === 0) return false;
	for (const v of curr) {
		if (
			(v.status === "partial" || v.status === "missing") &&
			prevConcerns.has(v.step)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Decision the loop driver should take after a /verify run completes.
 *
 * - `exit-clean` — nothing flagged. Pop the post-loop picker.
 * - `bail-cap` — hit the iteration cap with concerns still on the table.
 *               Pop the post-loop picker, annotated.
 * - `bail-no-progress` — same step stuck two runs in a row.
 *                       Pop the post-loop picker, annotated.
 * - `retry` — send findings back to the host agent, wait for fix,
 *             re-verify on the next iteration.
 */
export type LoopDecision =
	| { kind: "exit-clean" }
	| {
			kind: "bail-cap";
			concernCount: number;
			errorCount: number;
			iteration: number;
	  }
	| {
			kind: "bail-no-progress";
			concernCount: number;
			errorCount: number;
			iteration: number;
	  }
	| {
			kind: "retry";
			concernSteps: number[];
			nextIteration: number;
	  };

/**
 * Decide the next loop step from the inputs the driver has on hand:
 * how many iterations have run, the cap, last and current verdict
 * snapshots, and the verify-side error count.
 *
 * Errors block clean exit but don't, on their own, force a bail —
 * a transient JSON parse failure on iteration 1 shouldn't kill the
 * loop. They count toward bail messaging when one fires, though, so
 * the picker can warn the user.
 */
export function decideLoopAction(opts: {
	iteration: number;
	cap: number;
	prevVerdicts: readonly VerifyVerdictLike[] | undefined;
	currVerdicts: readonly VerifyVerdictLike[];
	errorCount: number;
}): LoopDecision {
	const { concernSteps, isClean } = aggregateConcerns(opts.currVerdicts);
	if (isClean && opts.errorCount === 0) {
		return { kind: "exit-clean" };
	}
	if (opts.iteration >= opts.cap) {
		return {
			kind: "bail-cap",
			concernCount: concernSteps.length,
			errorCount: opts.errorCount,
			iteration: opts.iteration,
		};
	}
	if (detectNoProgress(opts.prevVerdicts, opts.currVerdicts)) {
		return {
			kind: "bail-no-progress",
			concernCount: concernSteps.length,
			errorCount: opts.errorCount,
			iteration: opts.iteration,
		};
	}
	return {
		kind: "retry",
		concernSteps,
		nextIteration: opts.iteration + 1,
	};
}

/**
 * Snapshot we persist on `DevelopState.verifyLoop.previousVerdicts` for
 * the next iteration's no-progress comparison. Just step+status; the
 * full verdict (reason, suggestion) lives in the verify-result session
 * entry.
 */
export function toVerdictSnapshot(
	verdicts: readonly VerifyVerdictLike[],
): VerifyVerdictLike[] {
	return verdicts.map((v) => ({ step: v.step, status: v.status }));
}

/**
 * Gate the post-loop follow-up picker on which target extensions are
 * actually installed. Returns the picker option labels in display
 * order. `Stay here` is always present.
 *
 * `loopBailed` toggles the annotation suffix on Run /commit so the
 * user doesn't blindly commit work with unresolved verifier concerns.
 */
export function buildPostLoopPickerOptions(opts: {
	installedCommands: ReadonlySet<string>;
	loopBailed: boolean;
	unresolvedConcerns: number;
}): string[] {
	const options: string[] = [];
	if (opts.installedCommands.has("review")) {
		options.push("Run /review");
	}
	if (opts.installedCommands.has("commit")) {
		const suffix =
			opts.loopBailed && opts.unresolvedConcerns > 0
				? ` (with ${opts.unresolvedConcerns} unresolved concern${
						opts.unresolvedConcerns === 1 ? "" : "s"
					})`
				: "";
		options.push(`Run /commit${suffix}`);
	}
	options.push("Stay here — I'll handle it");
	return options;
}

// ---- Auto-review state transitions ------------------------------------
//
// `/develop` runs a focused cross-model review (only `code-reviewer`
// and `code-simplifier`, against `primary.heavy` + `secondary.heavy`)
// after the auto-verify loop settles, before the post-loop picker.
// Two pure helpers below cover the state-machine decisions; the
// extension owns the side effects.

/**
 * Decide what /develop should do once `runAutoReview` returns. Two
 * outcomes:
 *   - `apply-fixes` — at least one cross-model consensus finding was
 *     queued for the host agent. Transition to
 *     `awaiting-auto-review-fix` and wait for the next `agent_end`
 *     to fire the post-loop picker.
 *   - `skip-to-picker` — no consensus findings (or the pass aborted
 *     before fan-out). Restore the loop phase and run the picker
 *     directly.
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

/**
 * Pure helper: given whether the auto-verify loop bailed, decide which
 * phase to restore when the auto-review pass exits without queueing
 * fixes (or errors out). Returning `loop-bailed` keeps the post-loop
 * picker's `/commit` annotation honest.
 */
export function restoreLoopPhaseFromAutoReview(opts: {
	loopBailed: boolean;
}): "loop-bailed" | "loop-complete" {
	return opts.loopBailed ? "loop-bailed" : "loop-complete";
}
