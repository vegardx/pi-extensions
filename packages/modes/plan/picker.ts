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

import type {
	Deliverable as Phase,
	DeliverableStatus as PhaseStatus,
	Plan,
} from "./schema.js";
import {
	blockedReason,
	deliverables,
	ownWorkItems,
	pendingLifecycle,
	readyDeliverables,
} from "./schema.js";

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
		nodes: deliverables(plan).map((p) => ({
			id: p.id,
			status: p.status,
			taskIds: ownWorkItems(p).map((t) => t.id),
		})),
	});
}

export interface PickerGateInput {
	mode: "plan" | "auto" | "ask" | "hack" | null | undefined;
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
	const actionable = input.plan
		? deliverables(input.plan).some(
				(p) => !p.lifecycle && ACTIONABLE_STATUSES.includes(p.status),
			)
		: false;
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
	if (!plan) return false;
	return deliverables(plan).some(
		(p) => !p.lifecycle && ACTIONABLE_STATUSES.includes(p.status),
	);
}

export type PickerCopyKind = "in-flight" | "fresh" | "blocked" | "none";

export interface PickerCopy {
	kind: PickerCopyKind;
	title: string;
	implementAutoLabel: string;
	implementAskLabel: string;
}

/**
 * Build the picker's title and implement-option labels based on plan
 * state.
 *
 *   - `in-flight`: a phase is `active` or `needs-attention`. The user
 *     is resuming work on an existing branch; copy reflects that.
 *   - `fresh`: at least one `planned` phase, no in-flight work. The
 *     user is starting from scratch on this phase.
 *   - `none`: no actionable phase. The picker shouldn't have been
 *     opened; copy is defensive only and the caller should bail.
 *
 * Two implement labels are emitted (auto + ask). The caller decides
 * which one to surface first via `planPickerView`'s
 * `implementDefault` argument.
 */
export function buildPickerCopy(
	plan: Plan | null,
	currentBranch: string | null,
): PickerCopy {
	const inFlight = (plan ? deliverables(plan) : []).find(
		(p) =>
			!p.lifecycle && (p.status === "active" || p.status === "needs-attention"),
	);
	if (inFlight) {
		return {
			kind: "in-flight",
			title: `modes: plan updated — Phase \`${inFlight.id}\` in flight on \`${inFlight.branch}\``,
			implementAutoLabel: `Resume (auto) — continue on \`${inFlight.branch}\`, no pauses`,
			implementAskLabel: `Resume (ask) — continue on \`${inFlight.branch}\`, pause at commit/ship`,
		};
	}
	const planned = plan ? readyDeliverables(plan)[0] : undefined;
	if (planned) {
		return {
			kind: "fresh",
			title: `modes: plan ready${currentBranch ? ` (${currentBranch})` : ""} — what next?`,
			implementAutoLabel:
				"Implement (auto) — chug through commit/ship/next phase, no prompts",
			implementAskLabel:
				"Implement (ask) — execute each phase, pause at commit/ship",
		};
	}
	// No ready phases but a planned one exists — it's blocked on deps
	// (parent abandoned, missing, or not yet started). Surface the
	// reason so the user knows why the picker isn't offering Implement.
	const blocked = (plan ? deliverables(plan) : []).find(
		(p) => !p.lifecycle && p.status === "planned",
	);
	if (blocked && plan) {
		const reason = blockedReason(plan, blocked) ?? "blocked";
		return {
			kind: "blocked",
			title: `modes: \`${blocked.id}\` ${reason}`,
			implementAutoLabel: "Implement (auto)",
			implementAskLabel: "Implement (ask)",
		};
	}
	return {
		kind: "none",
		title: "modes: plan has no actionable phase",
		implementAutoLabel: "Implement (auto)",
		implementAskLabel: "Implement (ask)",
	};
}

/**
 * High-level view the picker handler dispatches on. Splits the picker
 * into two outcomes:
 *
 *   - `bail`: nothing actionable to ask about; the handler should
 *     notify and reset stage without opening a UI dialog.
 *   - `show`: open `ctx.ui.select` with the supplied title + 4 options
 *     (Implement-auto, Implement-ask, Park, Continue). The order of
 *     auto vs. ask flips with `implementDefault` so the user's preferred
 *     mode is the highlighted Enter-to-select option.
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
			options: [string, string, string, string, string];
			/**
			 * The exact label string used for the ask option in `options`.
			 * Returned alongside so the caller can dispatch by identity
			 * (`choice === askLabel`) instead of substring-matching, which
			 * was brittle when option labels embedded branch names.
			 */
			askLabel: string;
			/** Companion to {@link askLabel} for the auto option. */
			autoLabel: string;
			/** Companion for the on-demand scrutinize option. */
			scrutinizeLabel: string;
	  };

/**
 * Label for the on-demand "scrutinize this plan" picker option. Stable so
 * `runPicker` can dispatch by identity. Replaces the old always-on
 * `scrutinize.enable` gate: scrutiny now runs only when the user picks it.
 */
const SCRUTINIZE_LABEL = "🔍 Scrutinize plan — find gaps & risks";

export function planPickerView(
	plan: Plan | null,
	currentBranch: string | null,
	implementDefault: "auto" | "ask" = "auto",
): PickerView {
	const copy = buildPickerCopy(plan, currentBranch);
	if (copy.kind === "none") {
		return {
			action: "bail",
			notice: "plan has no actionable phase — staying in plan mode",
		};
	}
	const implementOptions: [string, string] =
		implementDefault === "ask"
			? [copy.implementAskLabel, copy.implementAutoLabel]
			: [copy.implementAutoLabel, copy.implementAskLabel];
	return {
		action: "show",
		title: copy.title,
		options: [
			implementOptions[0],
			implementOptions[1],
			SCRUTINIZE_LABEL,
			"Park — create GitHub tracking issue",
			"Continue discussing — stay in plan mode",
		],
		askLabel: copy.implementAskLabel,
		autoLabel: copy.implementAutoLabel,
		scrutinizeLabel: SCRUTINIZE_LABEL,
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
 *   - `blocked-on-deps`: every planned phase is blocked by an
 *     in-flight, abandoned, or unknown parent in `dependsOn`.
 *     /implement refuses with a reason; the user must edit the
 *     blocking dependency or wait for the predecessor to ship.
 */
export type ImplementContext =
	| { kind: "no-plan" }
	| { kind: "refuse-no-actionable" }
	| { kind: "blocked-on-pre"; phase: Phase }
	| { kind: "post-handover"; phase: Phase }
	| { kind: "blocked-on-deps"; phase: Phase }
	| { kind: "use-phase"; phase: Phase };

export function classifyImplementContext(plan: Plan | null): ImplementContext {
	if (!plan) return { kind: "no-plan" };
	// Pre-phase gate runs before everything else: even an in-flight
	// regular phase doesn't override the preflight requirement, since
	// the user may have hand-edited a phase to active without finishing
	// the manual prereqs.
	const pendingPre = pendingLifecycle(plan, "pre");
	if (pendingPre) return { kind: "blocked-on-pre", phase: pendingPre };
	const inFlight = deliverables(plan).find(
		(p) =>
			!p.lifecycle && (p.status === "active" || p.status === "needs-attention"),
	);
	if (inFlight) return { kind: "use-phase", phase: inFlight };
	const ready = readyDeliverables(plan)[0];
	if (ready) return { kind: "use-phase", phase: ready };
	// No ready/in-flight regular phase. If there's a post-phase with
	// remaining handover items and every regular phase is terminal,
	// surface that explicitly so the auto-mode driver can pop the
	// handover dialog instead of falsely reporting "all done".
	const pendingPost = pendingLifecycle(plan, "post");
	if (
		pendingPost &&
		deliverables(plan).every(
			(p) =>
				p.lifecycle !== undefined ||
				p.status === "shipped" ||
				p.status === "abandoned",
		)
	) {
		return { kind: "post-handover", phase: pendingPost };
	}
	// Planned phases exist but every one is blocked on an in-flight /
	// abandoned / unknown parent. Surface a different refusal so the
	// caller can explain *what* is blocking, rather than the generic
	// "all shipped/abandoned" message.
	const blocked = deliverables(plan).find(
		(p) => !p.lifecycle && p.status === "planned",
	);
	if (blocked) return { kind: "blocked-on-deps", phase: blocked };
	return { kind: "refuse-no-actionable" };
}
