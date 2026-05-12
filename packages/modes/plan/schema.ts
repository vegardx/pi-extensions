/**
 * Phase / Task plan schema.
 *
 * A Plan is a structured replacement for the flat `plan_step` list. It
 * groups Tasks under Phases. Each Phase ships as one PR / one issue.
 *
 * Status flow:
 *
 *   planned ─► active ─► in-review ─► ready-to-ship ─► shipped
 *                            │
 *                            ▼
 *                       needs-attention ─► ready-to-ship
 *
 * Plus a terminal `abandoned` reachable from any non-terminal state.
 *
 * Worktree lifecycle is bound to active work: a worktree exists only while
 * a phase is in `active` or `needs-attention`. Branches are kept forever.
 */

import { basename, resolve } from "node:path";

export const PHASE_STATUSES = [
	"planned",
	"active",
	"in-review",
	"needs-attention",
	"ready-to-ship",
	"shipped",
	"abandoned",
] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/** Statuses that require a worktree (active editing). */
export const WORKTREE_STATUSES: readonly PhaseStatus[] = [
	"active",
	"needs-attention",
] as const;

/** Terminal statuses — phase will not transition again. */
export const TERMINAL_STATUSES: readonly PhaseStatus[] = [
	"shipped",
	"abandoned",
] as const;

/**
 * Pure transform behind `/plan archive`: returns a new plan whose
 * non-terminal phases have been flipped to `abandoned`, alongside the
 * list of phases that were touched. Caller is responsible for saving
 * the returned plan and reconciling worktrees afterwards.
 *
 * Kept in schema.ts (not index.ts) so the archive policy is unit
 * testable without booting the extension closure.
 */
export function abandonNonTerminalPhases(
	plan: Plan,
	now: string,
): { plan: Plan; archived: Phase[] } {
	const archived: Phase[] = [];
	const phases = plan.phases.map((phase): Phase => {
		if (TERMINAL_STATUSES.includes(phase.status)) return phase;
		const next: Phase = { ...phase, status: "abandoned", updatedAt: now };
		archived.push(next);
		return next;
	});
	return {
		plan: {
			...plan,
			phases,
			updatedAt: archived.length > 0 ? now : plan.updatedAt,
		},
		archived,
	};
}

/**
 * A phase that is non-terminal but cannot progress without external
 * action we can't drive from session_start: `in-review` without a
 * `prNumber`. The PR is the only signal `syncPlanFromRemote` can use
 * to advance the phase to shipped/abandoned, so a phase in this state
 * is effectively waiting on the user to either open a PR or archive
 * the plan.
 */
export function isStuckPhase(
	phase: Pick<Phase, "status" | "prNumber">,
): boolean {
	return phase.status === "in-review" && phase.prNumber === undefined;
}

/**
 * A plan is "stuck" iff it has at least one non-terminal phase AND
 * every non-terminal phase is stuck (no phase the user can advance via
 * /implement, /ship, or PR-merge sync). Used by /plan list to flag
 * plans that need user attention vs. plans still in normal flight.
 */
export function isPlanStuck(plan: Pick<Plan, "phases">): boolean {
	const nonTerminal = plan.phases.filter(
		(p) => !TERMINAL_STATUSES.includes(p.status),
	);
	if (nonTerminal.length === 0) return false;
	return nonTerminal.every(isStuckPhase);
}

/**
 * Kinds of work captured by a Task.
 *
 *   - `deliverable` — agent-actionable acceptance criterion. Gates
 *     phase completion: a phase isn't done until every deliverable
 *     task is checked.
 *   - `followUp` — informational note carried alongside the phase
 *     (or at plan level). Doesn't block ship; surfaced in PR/issue
 *     bodies for the human reviewer.
 *   - `question` — open design question for a side-conversation;
 *     never blocks ship.
 *   - `manual` — manual / human-only step (e.g. "smoke on staging");
 *     surfaces as a reviewer checklist on the PR, never blocks ship.
 *
 * The agent should set `kind` explicitly when adding a task; missing
 * `kind` is read as `deliverable` for back-compat with v1 plans.
 */
export const TASK_KINDS = [
	"deliverable",
	"followUp",
	"question",
	"manual",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export interface Task {
	id: string;
	/** Short, scannable. No length cap — but agent should keep it concise. */
	title: string;
	/** Detailed: context, acceptance criteria, files, test notes. */
	body: string;
	done: boolean;
	/**
	 * Optional for back-compat with v1 plans. Read via
	 * {@link effectiveTaskKind} which defaults to `deliverable`.
	 */
	kind?: TaskKind;
	createdAt: string;
	updatedAt: string;
}

/** Read a task's kind, defaulting to `deliverable` for v1 plans. */
export function effectiveTaskKind(task: Pick<Task, "kind">): TaskKind {
	return task.kind ?? "deliverable";
}

export interface Phase {
	id: string;
	title: string;
	/** One-line: what ships when this merges. */
	goal: string;
	status: PhaseStatus;
	/** Git branch — typically `feat/<phase-id>`. */
	branch: string;
	/**
	 * Phase ids this phase depends on. Authoritative dependency edge —
	 * the `phases[]` array order is purely cosmetic from v2 onwards.
	 *
	 * Constraint enforced at write time (in `plan_phase`): at most one
	 * parent. Multi-parent (diamond) DAGs are rejected because the
	 * compaction-summary carry-forward only flows along a chain; phases
	 * that would share a child must instead be chained.
	 *
	 * Optional for back-compat with v1 plans, which encoded the
	 * dependency implicitly via array order. Read via
	 * {@link effectiveDependsOn}.
	 */
	dependsOn?: string[];
	/**
	 * Absolute path to the worktree where this phase's branch is currently
	 * checked out. Undefined while no worktree exists. May point at the
	 * main repo dir when the branch was checked out there directly
	 * (e.g. by /implement). Set when status enters WORKTREE_STATUSES,
	 * cleared when it leaves.
	 */
	worktreePath?: string;
	/**
	 * Absolute path to the pi session file backing this phase's auto
	 * session. Set on first `/implement` (when `ctx.newSession` creates
	 * the session); reused by subsequent `/implement` invocations on the
	 * same phase to resume via `ctx.switchSession`. Never cleared —
	 * the session file is kept on disk as a historical record even
	 * after the phase ships.
	 *
	 * Optional for back-compat with phases created before per-phase
	 * sessions landed; missing-on-resume falls back to creating a fresh
	 * session.
	 */
	sessionPath?: string;
	/** GitHub issue number after /park; undefined before. */
	issueNumber?: number;
	tasks: Task[];
	/** PR number once /ship has opened it. */
	prNumber?: number;
	/**
	 * Distilled outcome of this phase, written at /ship time. Capped at
	 * ~`compaction.phaseTokens` (default 10k tokens). Carried forward
	 * into future phases' seed via `seedPlanDoc` so phase N learns from
	 * phase N-1's discoveries without ingesting the raw auto-session.
	 *
	 * Idempotent: once set, /ship retries do not regenerate. Manual
	 * edits survive.
	 */
	summary?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PlanRepo {
	path: string;
}

/**
 * Identity of the session that first saved a plan. Captured at /plan
 * creation time. Optional on the schema for back-compat with plans
 * created before session-ownership tracking landed — those load with
 * `createdBy` undefined and are treated as legacy/orphan plans.
 */
export interface PlanOwnership {
	/** Session UUID from `SessionManager.getSessionId()`. */
	sessionId: string;
	/** Display name at creation time, if set. Cosmetic only. */
	sessionName?: string;
	/** Path to the session JSONL at creation time. Undefined for ephemeral sessions. */
	sessionFile?: string;
}

export interface Plan {
	slug: string;
	title: string;
	repo: PlanRepo;
	/**
	 * On-disk schema version. Absent / 1 = legacy (linear array order is
	 * the implicit dependency edge, no Task.kind, no plan.followUps).
	 * 2 adds Phase.dependsOn + Task.kind + Plan.followUps. Migration runs
	 * lazily on `loadPlan`.
	 */
	schemaVersion?: number;
	/**
	 * Plan-level standalone tasks. Used for follow-ups that aren't tied
	 * to a specific phase (e.g. "after release: tell support", "open
	 * design question to revisit"). Surfaced on the parent /park issue
	 * and in plan_view; never blocks any /ship.
	 *
	 * Optional for back-compat with v1 plans.
	 */
	followUps?: Task[];
	/** GitHub plan-tracking issue (parent of phase sub-issues) after /park. */
	parentIssueNumber?: number;
	phases: Phase[];
	/**
	 * Absolute path to the pi session file backing this plan's planning
	 * session. Set on first `/plan` (recorded from the active session);
	 * `switchSession`'d to on `/plan resume <slug>` and on auto→plan
	 * transitions. Optional for back-compat with plans from before
	 * per-plan sessions landed; missing-on-resume keeps the current
	 * session.
	 */
	planSessionPath?: string;
	/** Last successful PR-state sync via gh. */
	lastSyncedAt?: string;
	/**
	 * Session that first created this plan. Optional for back-compat —
	 * plans on disk from before this field existed load as legacy
	 * (no owner). Legacy plans never auto-adopt at session_start; the
	 * user can claim one via /plan resume.
	 */
	createdBy?: PlanOwnership;
	/**
	 * Distinct session ids that have ever bound this plan (via /plan or
	 * /plan resume). Drives /plan list grouping. Optional/empty for
	 * legacy plans.
	 */
	seenIn?: string[];
	createdAt: string;
	updatedAt: string;
}

/**
 * State-machine transitions. Maps current → allowed next states.
 * Used both for validation and for UI hints.
 */
export const PHASE_TRANSITIONS: Record<PhaseStatus, readonly PhaseStatus[]> = {
	planned: ["active", "abandoned"],
	active: ["in-review", "abandoned"],
	"in-review": ["ready-to-ship", "needs-attention", "abandoned"],
	"needs-attention": ["ready-to-ship", "abandoned"],
	"ready-to-ship": ["shipped", "abandoned"],
	shipped: [],
	abandoned: [],
};

export function canTransition(from: PhaseStatus, to: PhaseStatus): boolean {
	return PHASE_TRANSITIONS[from].includes(to);
}

/** Slug-ifies a free-text title into a kebab id suitable for ids/branches. */
export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
}

/**
 * Generate a phase id from a title.
 *
 * Returns a plain slug — the `p-` prefix that earlier versions of
 * modes baked in is gone. Human-rendered surfaces add a `Phase:` /
 * `Phase \`<id>\`` annotation in surrounding prose so the kind is
 * still readable at a glance; ids themselves stay clean (so do the
 * derived branch names: `feat/<id>` rather than `feat/p-<id>`).
 *
 * Stripping a leading `p-` keeps idempotence on legacy inputs and
 * lets callers pass already-prefixed ids during migration without
 * ending up with an `id !== id` lookup mismatch.
 */
export function phaseId(title: string): string {
	return slugify(title).replace(/^p-/, "");
}

/**
 * Generate a task id from a title. Same prefix-stripping policy as
 * {@link phaseId}: returns a plain slug, drops legacy `t-` prefixes
 * from the input.
 */
export function taskId(title: string): string {
	return slugify(title).replace(/^t-/, "");
}

/**
 * Compare two phase ids ignoring a legacy `p-` prefix on either side.
 * Plans created before the prefix-drop have `id: "p-add-webhook"` on
 * disk; new plans have `id: "add-webhook"`. Tool callers and CLI
 * arguments may legitimately pass either form. Normalising on every
 * comparison lets the two coexist during the migration window.
 */
export function matchPhaseId(stored: string, query: string): boolean {
	return stored.replace(/^p-/, "") === query.replace(/^p-/, "");
}

/** Companion to {@link matchPhaseId} for task ids and the legacy `t-` prefix. */
export function matchTaskId(stored: string, query: string): boolean {
	return stored.replace(/^t-/, "") === query.replace(/^t-/, "");
}

/** Default branch name derived from a phase id. */
export function defaultBranchForPhase(phase: Pick<Phase, "id">): string {
	return `feat/${phase.id}`;
}

/**
 * Read a phase's `dependsOn`, defaulting to a single-parent fallback
 * derived from the array order for v1 plans that don't yet have the
 * field set on disk.
 *
 * Fallback rule: parent = nearest preceding non-abandoned phase. If
 * the phase is the first in the array (or every preceding phase is
 * abandoned), the fallback is `[]`.
 *
 * Plans persisted under v2 always have `dependsOn` populated by
 * `migratePlan`, so this fallback only matters for in-memory plan
 * objects that bypass storage (e.g. fixtures, ad-hoc test plans).
 */
export function effectiveDependsOn(
	plan: Pick<Plan, "phases">,
	phase: Pick<Phase, "id" | "dependsOn">,
): string[] {
	if (phase.dependsOn !== undefined) return phase.dependsOn;
	const idx = plan.phases.findIndex((p) => p.id === phase.id);
	if (idx <= 0) return [];
	for (let i = idx - 1; i >= 0; i--) {
		const prev = plan.phases[i];
		if (prev && prev.status !== "abandoned") return [prev.id];
	}
	return [];
}

/** Repo-name derivation — the basename used for worktree path scoping. */
export function repoNameFromPath(path: string): string {
	// Use node:path so Windows backslashes and mixed separators are
	// handled correctly. resolve() normalises before basename() picks the
	// last segment.
	const name = basename(resolve(path));
	return name === "" ? "repo" : name;
}

/**
 * Statuses where the phase's branch holds work that hasn't reached the
 * default branch yet. A successor phase activated while a predecessor
 * is in one of these states must fork from the predecessor's branch,
 * not from main — otherwise the new branch loses access to the
 * predecessor's changes until that PR merges.
 */
const PARENT_BRANCH_STATUSES: readonly PhaseStatus[] = [
	"active",
	"in-review",
	"ready-to-ship",
	"needs-attention",
] as const;

/**
 * Pick the base branch a freshly-activated phase should fork from.
 *
 * The plan/phase model supports phase N+1 starting while N is still
 * `in-review` (the worktree lifecycle explicitly allows it). When that
 * happens, N's PR isn't merged yet — N's changes live on N's branch,
 * not on main. A successor that forks from main loses access to those
 * changes until N merges, which can introduce silent conflicts or
 * "why is this code missing?" confusion.
 *
 * Algorithm: walk the predecessors backwards from `activatingPhaseId`.
 *   - On the first non-skippable predecessor:
 *     - shipped → main has its commits, fork from defaultBranch.
 *     - active / in-review / ready-to-ship / needs-attention →
 *       fork from that predecessor's branch.
 *   - Skip `abandoned` (its branch is dead-end work) and `planned`
 *     (shouldn't be a predecessor in practice, but treat as not-yet-
 *     started so we look further back).
 *
 * Returns `defaultBranch` when the phase has no predecessors, when
 * every predecessor is abandoned/planned, or when `activatingPhaseId`
 * isn't found in the plan (defensive fallback).
 */
export function pickBaseBranch(
	plan: Pick<Plan, "phases">,
	activatingPhaseId: string,
	defaultBranch: string,
): string {
	const idx = plan.phases.findIndex((p) => p.id === activatingPhaseId);
	if (idx < 0) return defaultBranch;
	for (let i = idx - 1; i >= 0; i--) {
		const prev = plan.phases[i];
		if (!prev) continue;
		if (prev.status === "shipped") return defaultBranch;
		if (PARENT_BRANCH_STATUSES.includes(prev.status)) return prev.branch;
		// abandoned / planned: skip, look further back.
	}
	return defaultBranch;
}

/**
 * Decision for how `/implement` should set up a phase's branch.
 *
 *   - `create`: phase is `planned` (first-time activation). Create the
 *     branch from the picked base (`baseBranch`).
 *   - `resume`: phase is already in flight (`active` / `needs-attention`)
 *     and its branch exists locally. Plain checkout, no reset — the
 *     phase's commits must be preserved.
 *   - `abort`: phase is in flight but its branch is missing locally
 *     (manually deleted, lost worktree, etc.). Refuse to proceed; a
 *     destructive `-B` re-create would silently lose any phase work
 *     still on a remote / reflog.
 */
export type ImplementBranchPlan =
	| { kind: "create"; branch: string; baseBranch: string }
	| { kind: "resume"; branch: string }
	| { kind: "abort"; reason: string };

/**
 * Decide what `/implement` should do to set up the phase branch.
 *
 * Splitting this out from doImplement gives unit-testable coverage of
 * the destructive-reset bug: previously /implement always ran
 * `git checkout -B <branch>`, which silently reset an in-flight phase
 * branch to HEAD when re-invoked. Going from auto → plan → auto via
 * /implement would erase all of the phase's commits.
 */
export function planImplementBranch(
	plan: Pick<Plan, "phases">,
	phase: Pick<Phase, "id" | "branch" | "status">,
	defaultBranch: string,
	branchExists: boolean,
): ImplementBranchPlan {
	if (phase.status === "planned") {
		return {
			kind: "create",
			branch: phase.branch,
			baseBranch: pickBaseBranch(plan, phase.id, defaultBranch),
		};
	}
	if (!branchExists) {
		return {
			kind: "abort",
			reason:
				`phase branch \`${phase.branch}\` is missing locally. ` +
				"Was it deleted? Refusing to recreate — that would silently " +
				"reset the phase to the default branch and lose any commits. " +
				"Investigate (e.g. `git reflog`, `git branch -a`) and restore " +
				"the branch before re-running /implement.",
		};
	}
	return { kind: "resume", branch: phase.branch };
}
