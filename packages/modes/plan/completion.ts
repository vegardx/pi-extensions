/**
 * Plan-completion prompt logic.
 *
 * When `/ship` lands the last actionable phase of a plan, we offer the
 * user a small picker: stay in the planning context, start a fresh
 * plan, or archive the current plan. Pure decision-building lives here
 * so it's unit-testable without instantiating the modes extension.
 *
 * The actual `ctx.ui.select` call and side-effects (start fresh plan,
 * call `doPlanArchive`, etc.) live in index.ts.
 */

import type { Plan } from "./schema.js";
import { TERMINAL_STATUSES } from "./schema.js";

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
 * Pure check: are all phases on this plan terminal (`shipped` or
 * `abandoned`)? If yes, the plan is complete and the prompt should
 * fire on /ship.
 */
export function isPlanComplete(plan: Pick<Plan, "phases">): boolean {
	if (plan.phases.length === 0) return false;
	return plan.phases.every((p) => TERMINAL_STATUSES.includes(p.status));
}

/**
 * Build the prompt shown when a plan completes. Returns null when no
 * prompt should fire (plan still has actionable phases, or the caller
 * is headless and shouldn't prompt).
 */
export function buildCompletionPrompt(
	plan: Pick<Plan, "title" | "phases">,
	hasUI: boolean,
): CompletionPrompt | null {
	if (!hasUI) return null;
	if (!isPlanComplete(plan)) return null;
	return {
		title: `Plan "${plan.title}" is complete. All phases are shipped or abandoned. What next?`,
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
