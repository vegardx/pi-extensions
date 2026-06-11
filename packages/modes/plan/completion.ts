/**
 * Plan-completion prompt logic.
 *
 * When `/ship` lands the last actionable deliverable of a plan, we offer the
 * user a small picker: stay in the planning context, start a fresh
 * plan, or archive the current plan. Pure decision-building lives here
 * so it's unit-testable without instantiating the modes extension.
 *
 * The actual `ctx.ui.select` call and side-effects (start fresh plan,
 * call `doPlanArchive`, etc.) live in index.ts.
 */

import type { Plan } from "./schema.js";
import { deliverables, isGrouping, TERMINAL_STATUSES } from "./schema.js";
import { subtreeComplete } from "./tree.js";

export type CompletionDecision =
	| { action: "stay" }
	| { action: "newPlan" }
	| { action: "archive" };

export interface CompletionPrompt {
	title: string;
	options: string[];
}

const OPT_STAY = "Stay in this session";
const OPT_NEW_PLAN = "Start a new plan (new planning session)";
const OPT_ARCHIVE = "Archive this plan and stay";

/**
 * Pure check: is the plan "done as far as the user's hands go"?
 *
 * True when every deliverable is in `shipped`, `abandoned`, or `in-review` (or, for groupings, its subtree is complete).
 * `in-review` counts because /ship sets that status when the PR is
 * opened — the work has left the user's hands and is at review. The
 * later "shipped" transition happens passively when `syncPlanOnStart`
 * sees the PR merged, but by then the completion prompt has already
 * served its purpose. Without including `in-review` here, the prompt
 * (and the PR sweep it gates) never fires on the auto path.
 */
export function isPlanComplete(plan: Pick<Plan, "nodes">): boolean {
	const flat = deliverables(plan);
	if (flat.length === 0) return false;
	return flat.every(
		(d) =>
			TERMINAL_STATUSES.includes(d.status) ||
			d.status === "in-review" ||
			// Groupings don't ship PRs themselves; they count as complete
			// when their whole subtree has left the user's hands.
			(isGrouping(d) && subtreeComplete(d)),
	);
}

/**
 * True when every deliverable is in a strictly terminal state
 * (`shipped`/`abandoned`). Used by surfaces that need to distinguish
 * "merged" from "in flight at review" — e.g. the prompt title.
 */
function allDeliverablesTerminal(plan: Pick<Plan, "nodes">): boolean {
	return deliverables(plan).every((d) => TERMINAL_STATUSES.includes(d.status));
}

/**
 * Build the prompt shown when a plan completes. Returns null when no
 * prompt should fire (plan still has actionable deliverables, or the caller
 * is headless and shouldn't prompt).
 */
export function buildCompletionPrompt(
	plan: Pick<Plan, "title" | "nodes">,
	hasUI: boolean,
): CompletionPrompt | null {
	if (!hasUI) return null;
	if (!isPlanComplete(plan)) return null;
	const title = allDeliverablesTerminal(plan)
		? `Plan "${plan.title}" is complete. Everything is shipped or abandoned. What next?`
		: `Plan "${plan.title}" is complete. Everything is shipped, abandoned, or in review. What next?`;
	return {
		title,
		options: [OPT_STAY, OPT_NEW_PLAN, OPT_ARCHIVE],
	};
}

/**
 * Decode a user's pick into a structured decision. Tolerant of
 * undefined (dialog cancelled or headless) and unknown strings — both
 * fall back to `stay`.
 */
export function decideFromCompletionChoice(
	choice: string | undefined,
): CompletionDecision {
	if (!choice) return { action: "stay" };
	if (choice === OPT_NEW_PLAN) return { action: "newPlan" };
	if (choice === OPT_ARCHIVE) return { action: "archive" };
	return { action: "stay" };
}

/**
 * Side effect to run for the `newPlan` choice. Forking a fresh session
 * needs `ctx.newSession`, which only exists on `ExtensionCommandContext`
 * — manual `/ship` has it, but the auto loop's `agent_end` ctx does not.
 * On the non-command path we degrade to a notify telling the user to
 * start the next session by hand.
 */
export type NewPlanSideEffect =
	| { kind: "fork-session" }
	| { kind: "notify-stale"; message: string };

export const NEW_PLAN_STALE_MESSAGE =
	"plan complete — start a new session (Ctrl-N or /new) to begin the next plan";

export function newPlanSideEffect(
	hasSessionControl: boolean,
): NewPlanSideEffect {
	return hasSessionControl
		? { kind: "fork-session" }
		: { kind: "notify-stale", message: NEW_PLAN_STALE_MESSAGE };
}
