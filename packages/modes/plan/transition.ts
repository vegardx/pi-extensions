/**
 * Mode-transition prompt logic.
 *
 * When the user Shift+Tabs from auto/hack back into plan mode, we may
 * be carrying a heavy execution context that they don't want to drag
 * into a fresh planning session. This module produces the dialog
 * options and decodes the user's choice into a structured decision.
 *
 * The actual `ctx.ui.select` call and side-effects (lossy compaction,
 * new session) live in index.ts. This module is pure so it can be unit
 * tested without instantiating the extension factory.
 */

export type TransitionMode = "plan" | "ask" | "auto" | "hack";

export type TransitionDecision =
	| { action: "flip" }
	| { action: "compact"; phaseId: string }
	| { action: "newSession" };

export interface TransitionInput {
	hasUI: boolean;
	prev: TransitionMode;
	next: TransitionMode;
	activePhaseId: string | null;
}

export interface TransitionPrompt {
	title: string;
	options: string[];
}

const OPT_KEEP = "Keep current context";
const OPT_NEW_SESSION = "New session";
const OPT_COMPACT_PREFIX = "Lossy-compact phase";

/**
 * Decide whether to prompt and what options to show.
 *
 * Returns null when no prompt is needed:
 *   - next mode isn't plan
 *   - prev mode wasn't auto/hack (transitions like ask→plan don't carry
 *     heavy context)
 *   - headless (!hasUI) — silently keep the existing context
 */
export function buildTransitionOptions(
	input: TransitionInput,
): TransitionPrompt | null {
	if (input.next !== "plan") return null;
	if (input.prev !== "auto" && input.prev !== "hack") return null;
	if (!input.hasUI) return null;

	const opts: string[] = [OPT_KEEP];
	if (input.activePhaseId) {
		opts.push(`${OPT_COMPACT_PREFIX} \`${input.activePhaseId}\` first`);
	}
	opts.push(OPT_NEW_SESSION);

	return {
		title: `Switching to plan mode from ${input.prev}. Heavy context — what should we do with it?`,
		options: opts,
	};
}

/**
 * Map a user's pick (from ctx.ui.select) into a structured decision.
 * Tolerant of undefined (dialog cancelled) and unknown strings — both
 * fall back to `flip` (preserve context, just change mode).
 */
export function decideFromChoice(
	choice: string | undefined,
	activePhaseId: string | null,
): TransitionDecision {
	if (!choice) return { action: "flip" };
	if (choice === OPT_KEEP) return { action: "flip" };
	if (choice === OPT_NEW_SESSION) return { action: "newSession" };
	if (choice.startsWith(OPT_COMPACT_PREFIX) && activePhaseId) {
		return { action: "compact", phaseId: activePhaseId };
	}
	return { action: "flip" };
}
