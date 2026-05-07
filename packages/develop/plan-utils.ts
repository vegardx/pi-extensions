/**
 * Pure plan/execution helpers for /develop.
 *
 * Ported from pi's `examples/extensions/plan-mode/utils.ts` (MIT) so /develop
 * can reuse the same plan-extraction and progress-tracking patterns. Kept as
 * a small standalone module so the pi upstream can evolve its example without
 * breaking us; if the upstream publishes a reusable package later, we can
 * swap to it.
 */

// isSafeCommand lives in _shared so the `modes` extension can use it too.
export { isSafeCommand } from "@vegardx/pi-extensions-shared/plan-utils.js";

/** A single numbered step parsed from a `Plan:` section. */
export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
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
	surfacedCount: number;
}): AutoReviewNextAction {
	if (!opts.ran) return "skip-to-picker";
	if (opts.appliedCount <= 0 && opts.surfacedCount <= 0)
		return "skip-to-picker";
	return "apply-fixes";
}
