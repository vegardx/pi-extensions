/**
 * Pure decision logic for the plan picker.
 *
 * The picker pops at the end of a plan-mode agent turn to ask the user
 * what to do with the freshly-built/refined plan: implement, park as a
 * GitHub issue, or keep discussing. Two gates suppress the pop:
 *
 *   1. **Actionability** — at least one phase must be in `planned`,
 *      `active`, or `needs-attention`. Plans whose every phase is
 *      shipped/abandoned have nothing left to implement, so the picker
 *      adds noise rather than choices.
 *
 *   2. **Plan changed this turn** — the plan structure must differ from
 *      the snapshot taken at the start of the turn. If the user just
 *      switched back to plan mode to discuss/realign and the agent
 *      didn't mutate the plan, no decision is owed.
 *
 * The snapshot lifecycle (managed in index.ts):
 *
 *   - Taken in `before_agent_start` only when null. This preserves the
 *     snapshot across `ask`-tool question rounds: round 1 mutates and
 *     defers (questions queued), round 2 mutates more and defers,
 *     round N finalises. The picker fires once on round N with the
 *     cumulative diff visible.
 *   - Reset to null when the picker actually fires.
 *   - Reset to null when leaving plan mode and when the active plan
 *     slug changes — both invalidate any prior snapshot.
 */

import type { Phase, PhaseStatus, Plan } from "./schema.js";

/**
 * Status set the picker considers "actionable" — the user can still
 * make a decision about implementing, parking, or discussing them.
 */
const ACTIONABLE_STATUSES: readonly PhaseStatus[] = [
	"planned",
	"active",
	"needs-attention",
] as const;

/**
 * Snapshot a plan's structural identity. Body content (task bodies,
 * phase goals) is intentionally excluded so iterative body refinements
 * inside an unchanged phase shape don't re-pop the picker — the
 * picker's question is "is this plan ready to ship?", which depends on
 * shape, not prose.
 *
 * Returns a stable JSON string for cheap equality comparison.
 */
export function snapshotPlanStructure(plan: Plan | null): string {
	if (!plan) return "null";
	return JSON.stringify({
		phases: plan.phases.map((p) => ({
			id: p.id,
			status: p.status,
			taskIds: p.tasks.map((t) => t.id),
		})),
	});
}

export interface PickerGateInput {
	mode: "plan" | "auto" | "hack" | null | undefined;
	stage: string | null | undefined;
	plan: Plan | null;
	/** Snapshot taken at the start of the current turn (or null). */
	snapshot: string | null;
	hasUI: boolean;
}

/**
 * Should `agent_end` pop the picker?
 *
 * All of:
 *   - mode === "plan" && stage === "planning"
 *   - hasUI
 *   - plan has at least one actionable phase
 *   - snapshot exists and differs from the current plan structure
 *
 * If `snapshot` is null we must assume nothing was captured for this
 * turn (e.g. handler missed before_agent_start) and decline rather
 * than fabricate a diff.
 */
export function shouldFirePicker(input: PickerGateInput): boolean {
	if (input.mode !== "plan") return false;
	if (input.stage !== "planning") return false;
	if (!input.hasUI) return false;
	const actionable =
		input.plan?.phases.some((p) => ACTIONABLE_STATUSES.includes(p.status)) ??
		false;
	if (!actionable) return false;
	if (input.snapshot === null) return false;
	return input.snapshot !== snapshotPlanStructure(input.plan);
}

/**
 * Should the Shift+Tab `plan → auto` path pop the picker?
 *
 * This path is user-initiated, so the "changed this turn" gate does
 * not apply — the user explicitly asked to commit to a choice. Only
 * gate on actionability so a fully-shipped plan flips silently to
 * auto rather than offering "Implement" with nothing to implement.
 */
export function shouldOfferShiftTabPicker(
	plan: Plan | null,
	hasUI: boolean,
): boolean {
	if (!hasUI) return false;
	return (
		plan?.phases.some((p) => ACTIONABLE_STATUSES.includes(p.status)) ?? false
	);
}

export type PickerCopyKind = "in-flight" | "fresh" | "none";

export interface PickerCopy {
	kind: PickerCopyKind;
	title: string;
	implementLabel: string;
}

/**
 * Build the picker's title and implement-option label based on plan
 * state.
 *
 *   - `in-flight`: a phase is `active` or `needs-attention`. The user
 *     is resuming work on an existing branch; copy reflects that.
 *   - `fresh`: at least one `planned` phase, no in-flight work. The
 *     user is starting from scratch on this phase.
 *   - `none`: no actionable phase. The picker shouldn't have been
 *     opened; copy is defensive only and the caller should bail.
 */
export function buildPickerCopy(
	plan: Plan | null,
	currentBranch: string | null,
): PickerCopy {
	const inFlight = plan?.phases.find(
		(p) => p.status === "active" || p.status === "needs-attention",
	);
	if (inFlight) {
		return {
			kind: "in-flight",
			title: `modes: plan updated — phase \`${inFlight.id}\` in flight on \`${inFlight.branch}\``,
			implementLabel: `Resume implementation — continue on \`${inFlight.branch}\` with the updated plan`,
		};
	}
	const planned = plan?.phases.find((p) => p.status === "planned");
	if (planned) {
		return {
			kind: "fresh",
			title: `modes: plan ready${currentBranch ? ` (${currentBranch})` : ""} — what next?`,
			implementLabel: "Implement — create branch and execute",
		};
	}
	return {
		kind: "none",
		title: "modes: plan has no actionable phase",
		implementLabel: "Implement — create branch and execute",
	};
}

/**
 * High-level view the picker handler dispatches on. Splits the picker
 * into two outcomes:
 *
 *   - `bail`: nothing actionable to ask about; the handler should
 *     notify and reset stage without opening a UI dialog.
 *   - `show`: open `ctx.ui.select` with the supplied title + 3 options.
 *
 * Lifting this out of `runPicker` keeps the handler a thin dispatcher
 * and makes the bail wiring (which is reachable via Shift+Tab and
 * `/plan resume` paths) directly testable without spinning up a fake
 * extension host.
 */
export type PickerView =
	| { action: "bail"; notice: string }
	| {
			action: "show";
			title: string;
			options: [string, string, string];
	  };

export function planPickerView(
	plan: Plan | null,
	currentBranch: string | null,
): PickerView {
	const copy = buildPickerCopy(plan, currentBranch);
	if (copy.kind === "none") {
		return {
			action: "bail",
			notice: "plan has no actionable phase — staying in plan mode",
		};
	}
	return {
		action: "show",
		title: copy.title,
		options: [
			copy.implementLabel,
			"Park — create GitHub tracking issue",
			"Continue discussing — stay in plan mode",
		],
	};
}

/**
 * What `/implement` should do given the current plan state. Splitting
 * this out of `doImplement` makes the three-way decision (no plan,
 * all terminal, has actionable phase) directly testable, so a
 * regression that re-routed the all-terminal case back to the legacy
 * description-derived branch fallback would surface in unit tests.
 *
 *   - `no-plan`: no current plan at all. Legacy supported path —
 *     /implement creates a description-derived feature branch.
 *   - `refuse-no-actionable`: a plan exists but every phase is
 *     terminal (shipped/abandoned). Refuse rather than silently
 *     branching off-plan.
 *   - `use-phase`: a plan and an actionable phase exist; that's the
 *     phase /implement should bind to. Active/needs-attention
 *     resumes; planned activates.
 */
export type ImplementContext =
	| { kind: "no-plan" }
	| { kind: "refuse-no-actionable" }
	| { kind: "use-phase"; phase: Phase };

export function classifyImplementContext(plan: Plan | null): ImplementContext {
	if (!plan) return { kind: "no-plan" };
	const inFlight = plan.phases.find(
		(p) => p.status === "active" || p.status === "needs-attention",
	);
	if (inFlight) return { kind: "use-phase", phase: inFlight };
	const planned = plan.phases.find((p) => p.status === "planned");
	if (planned) return { kind: "use-phase", phase: planned };
	return { kind: "refuse-no-actionable" };
}
