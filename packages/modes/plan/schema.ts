/**
 * Deliverable / WorkItem plan schema (v3).
 *
 * A Plan is a forest of nodes. A node is either a **Deliverable**
 * (something that ships — one PR / one issue — or a grouping of child
 * deliverables) or a **WorkItem** (a checklist line: task, question,
 * followup, manual step). Deliverables nest: a deliverable either has
 * its own gating work-items (a leaf that ships a PR) XOR child
 * deliverables (a grouping that completes when its subtree ships) —
 * never both.
 *
 * Status flow (per deliverable):
 *
 *   planned ─► active ─► in-review ─► ready-to-ship ─► shipped
 *                            │
 *                            ▼
 *                       needs-attention ─► ready-to-ship
 *
 * Plus a terminal `abandoned` reachable from any non-terminal state.
 *
 * Worktree lifecycle is bound to active work: a worktree exists only
 * while a deliverable is in `active` or `needs-attention`. Branches
 * are kept forever.
 */

import { basename, resolve } from "node:path";

export const DELIVERABLE_STATUSES = [
	"planned",
	"active",
	"in-review",
	"needs-attention",
	"ready-to-ship",
	"shipped",
	"abandoned",
] as const;

export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** Statuses that require a worktree (active editing). */
export const WORKTREE_STATUSES: readonly DeliverableStatus[] = [
	"active",
	"needs-attention",
] as const;

/** Terminal statuses — the deliverable will not transition again. */
export const TERMINAL_STATUSES: readonly DeliverableStatus[] = [
	"shipped",
	"abandoned",
] as const;

/**
 * Kinds of work captured by a WorkItem.
 *
 *   - `task` — agent-actionable acceptance criterion. Gates the parent
 *     deliverable's completion: a deliverable isn't done until every
 *     `task` item is checked. (v2 name: `deliverable`.)
 *   - `followup` — informational note carried alongside the
 *     deliverable (or at plan level). Doesn't block ship; surfaced in
 *     PR/issue bodies for the human reviewer. (v2 name: `followUp`.)
 *   - `question` — open design question for a side-conversation;
 *     never blocks ship. Can carry an `answer` once decided.
 *   - `manual` — manual / human-only step (e.g. "smoke on staging");
 *     surfaces as a reviewer checklist on the PR, never blocks ship.
 *
 * The agent should set `kind` explicitly when adding a work item;
 * missing `kind` reads as `task`.
 */
export const WORK_ITEM_KINDS = [
	"task",
	"followup",
	"question",
	"manual",
] as const;

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export interface WorkItem {
	type: "work-item";
	id: string;
	/** Short, scannable. No length cap — but agent should keep it concise. */
	title: string;
	/** Detailed: context, acceptance criteria, files, test notes. */
	body: string;
	done: boolean;
	/** Read via {@link effectiveWorkItemKind} which defaults to `task`. */
	kind?: WorkItemKind;
	/**
	 * For `question` items: the decision once made. Accepting an
	 * answer also stamps {@link decidedAt}.
	 */
	answer?: string;
	/** ISO timestamp at which `answer` was recorded. */
	decidedAt?: string;
	createdAt: string;
	updatedAt: string;
}

/** Read a work item's kind, defaulting to `task`. */
export function effectiveWorkItemKind(
	item: Pick<WorkItem, "kind">,
): WorkItemKind {
	return item.kind ?? "task";
}

/**
 * Lifecycle deliverables are manual-intervention checklists at the
 * plan boundaries — never implemented, never shipped as PRs:
 *
 *   - `pre`: preflight checklist. Manual prerequisites the user has to
 *     complete before any regular deliverable becomes implementable.
 *     At most one per plan, top-level only.
 *   - `post`: handover checklist. Manual follow-ups after the last
 *     regular deliverable ships. Same constraints as `pre`.
 *
 * Absent `lifecycle` means a regular deliverable.
 */
export type DeliverableLifecycle = "pre" | "post";

export interface Deliverable {
	type: "deliverable";
	id: string;
	title: string;
	/** What ships when this merges — context, acceptance criteria. (v2 name: `goal`.) */
	body: string;
	status: DeliverableStatus;
	/**
	 * Git branch — typically `feat/<id>`. Optional: lifecycle
	 * deliverables never claim a branch, and groupings (children are
	 * deliverables) don't use theirs — `pickBaseBranch` skips them.
	 * Leaf deliverables that ship PRs must have one; the tool layer
	 * assigns it at creation.
	 */
	branch?: string;
	/** See {@link DeliverableLifecycle}. Top-level only, ≤ 1 each. */
	lifecycle?: DeliverableLifecycle;
	/**
	 * Deliverable ids this deliverable depends on (the stacking edge).
	 * At most one parent; targets must be deliverables (cross-subtree
	 * allowed); cycles rejected at write time.
	 */
	dependsOn?: string[];
	/**
	 * Children: own gating work-items XOR child deliverables.
	 * Mixed work-items alongside child deliverables are allowed only
	 * when none of the work-items gate (question/followup/manual);
	 * gating `task` items and child deliverables are mutually
	 * exclusive (enforced at write time).
	 */
	children: PlanNode[];
	/**
	 * Absolute path to the worktree where this deliverable's branch is
	 * currently checked out. Undefined while no worktree exists. May
	 * point at the main repo dir when the branch was checked out there
	 * directly (e.g. by /implement). Set when status enters
	 * WORKTREE_STATUSES, cleared when it leaves.
	 */
	worktreePath?: string;
	/**
	 * Absolute path to the pi session file backing this deliverable's
	 * auto session. Set on first `/implement`; reused on resume. Never
	 * cleared.
	 */
	sessionPath?: string;
	/**
	 * Identity of the pi session currently driving this deliverable.
	 * Set on activation, cleared on terminal status. Used by the
	 * multi-driver adoption guard; liveness via the session file's
	 * mtime (see `evaluateClaim` in `./driver-claim.ts`).
	 */
	driverSessionId?: string;
	/** Session JSONL path captured alongside `driverSessionId`. */
	driverSessionFile?: string;
	/** ISO timestamp of the driver claim. Cosmetic; for diagnostics. */
	driverClaimedAt?: string;
	/** GitHub issue number after /park; undefined before. */
	issueNumber?: number;
	/** PR number once /ship has opened it. */
	prNumber?: number;
	/**
	 * Distilled outcome, written at /ship time. Capped at
	 * ~`compaction.phaseTokens` tokens; carried forward into future
	 * deliverables' seed. Idempotent — /ship retries don't regenerate.
	 */
	summary?: string;
	/** Per-deliverable token telemetry, populated at /ship time. */
	tokens?: DeliverableTokens;
	createdAt: string;
	updatedAt: string;
}

export type PlanNode = Deliverable | WorkItem;

export function isDeliverable(node: PlanNode): node is Deliverable {
	return node.type === "deliverable";
}

export function isWorkItem(node: PlanNode): node is WorkItem {
	return node.type === "work-item";
}

/**
 * Single LLM call's token cost. Mirrors {@link import("@mariozechner/pi-ai").Usage}
 * but flattened to the four fields we care about plus an aggregate cost
 * (USD) when the underlying call exposed one. `cost` is optional because
 * sums across heterogeneous calls drop the cost field when any
 * contributor lacked it — absence means "unknown", not zero.
 */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Aggregate cost in USD; absent when any contributor lacked cost data. */
	cost?: number;
}

/**
 * Per-deliverable telemetry written at /ship time.
 *   - `phase`     — sum of every assistant message's usage in the auto session
 *   - `summary`   — the single LLM call that wrote `summary`
 *   - `midPhase`  — one entry per mid-deliverable compaction (chronological)
 */
export interface DeliverableTokens {
	phase: TokenUsage;
	summary?: TokenUsage;
	midPhase: TokenUsage[];
}

export interface PlanRepo {
	path: string;
}

/**
 * Identity of the session that first saved a plan. Captured at /plan
 * creation time. Optional for back-compat with plans created before
 * session-ownership tracking landed.
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
	 * On-disk schema version. Absent / 1 = legacy linear (array order is
	 * the implicit dependency edge). 2 adds Phase.dependsOn + Task.kind +
	 * Plan.followUps. 3 replaces the flat phases/followUps split with the
	 * recursive node forest (`nodes`). Migration runs lazily on
	 * `loadPlan`.
	 */
	schemaVersion?: number;
	/**
	 * The node forest. Top-level deliverables are the old phases;
	 * top-level work-items ("loose leaves") are the old plan-level
	 * followUps — never gating, surfaced on the /park tracking issue.
	 */
	nodes: PlanNode[];
	/** GitHub plan-tracking issue (parent of deliverable issues) after /park. */
	parentIssueNumber?: number;
	/**
	 * Absolute path to the pi session file backing this plan's planning
	 * session. Set on first `/plan`; `switchSession`'d to on
	 * `/plan resume <slug>` and on auto→plan transitions.
	 */
	planSessionPath?: string;
	/** Last successful PR-state sync via gh. */
	lastSyncedAt?: string;
	/**
	 * Session that first created this plan. Optional for back-compat —
	 * legacy plans never auto-adopt at session_start.
	 */
	createdBy?: PlanOwnership;
	/**
	 * Distinct session ids that have ever bound this plan. Drives
	 * /plan list grouping. Optional/empty for legacy plans.
	 */
	seenIn?: string[];
	createdAt: string;
	updatedAt: string;
}

// ---- Forest traversal (minimal core; richer helpers in tree.ts) --------

/**
 * Preorder flatten of every deliverable in the forest. THE drop-in for
 * the old `plan.phases` array — selectors below all run over it.
 * Re-exported (with friends) from `tree.ts`.
 */
export function deliverables(plan: Pick<Plan, "nodes">): Deliverable[] {
	const out: Deliverable[] = [];
	const visit = (nodes: readonly PlanNode[]): void => {
		for (const node of nodes) {
			if (isDeliverable(node)) {
				out.push(node);
				visit(node.children);
			}
		}
	};
	visit(plan.nodes);
	return out;
}

/** Work-items directly on a deliverable (not in nested deliverables). */
export function ownWorkItems(d: Pick<Deliverable, "children">): WorkItem[] {
	return d.children.filter(isWorkItem);
}

/** Child deliverables directly under a deliverable. */
export function childDeliverables(
	d: Pick<Deliverable, "children">,
): Deliverable[] {
	return d.children.filter(isDeliverable);
}

/** Gating work-items: `task`-kind items directly on the deliverable. */
export function gatingTasks(d: Pick<Deliverable, "children">): WorkItem[] {
	return ownWorkItems(d).filter((t) => effectiveWorkItemKind(t) === "task");
}

/** A grouping has child deliverables (and therefore no gating tasks). */
export function isGrouping(d: Pick<Deliverable, "children">): boolean {
	return childDeliverables(d).length > 0;
}

/**
 * Does this deliverable ship as one PR? Lifecycle checklists never
 * ship; groupings complete via their subtree; a leaf ships iff it has
 * at least one gating task.
 */
export function shipsPR(
	d: Pick<Deliverable, "children" | "lifecycle">,
): boolean {
	return !d.lifecycle && !isGrouping(d) && gatingTasks(d).length >= 1;
}

/**
 * An implementable leaf: not a lifecycle checklist, not a grouping.
 * Looser than {@link shipsPR} — a freshly added leaf with no tasks yet
 * is still implementable (and /ship-able), it just doesn't gate
 * anything until tasks land.
 */
export function isImplementableLeaf(
	d: Pick<Deliverable, "children" | "lifecycle">,
): boolean {
	return !d.lifecycle && !isGrouping(d);
}

// ---- Archive ------------------------------------------------------------

/**
 * Pure transform behind `/plan archive`: returns a new plan whose
 * non-terminal deliverables (anywhere in the forest) have been flipped
 * to `abandoned`, alongside the list touched. Caller saves the plan
 * and reconciles worktrees afterwards.
 */
export function abandonNonTerminalDeliverables(
	plan: Plan,
	now: string,
): { plan: Plan; archived: Deliverable[] } {
	const archived: Deliverable[] = [];
	const visit = (nodes: readonly PlanNode[]): PlanNode[] =>
		nodes.map((node): PlanNode => {
			if (!isDeliverable(node)) return node;
			const children = visit(node.children);
			if (TERMINAL_STATUSES.includes(node.status)) {
				return children === node.children ? node : { ...node, children };
			}
			// Drop driver claim on archive: the deliverable will never run
			// again, so a stale claim would just confuse the adoption guard.
			const next: Deliverable = {
				...node,
				children,
				status: "abandoned",
				updatedAt: now,
			};
			delete next.driverSessionId;
			delete next.driverSessionFile;
			delete next.driverClaimedAt;
			archived.push(next);
			return next;
		});
	const nodes = visit(plan.nodes);
	return {
		plan: {
			...plan,
			nodes,
			updatedAt: archived.length > 0 ? now : plan.updatedAt,
		},
		archived,
	};
}

/**
 * A deliverable that is non-terminal but cannot progress without
 * external action we can't drive from session_start: `in-review`
 * without a `prNumber`. The PR is the only signal remote sync can use
 * to advance it.
 */
export function isStuckDeliverable(
	d: Pick<Deliverable, "status" | "prNumber">,
): boolean {
	return d.status === "in-review" && d.prNumber === undefined;
}

/**
 * A plan is "stuck" iff it has at least one non-terminal deliverable
 * AND every non-terminal deliverable is stuck. Used by /plan list to
 * flag plans needing user attention.
 */
export function isPlanStuck(plan: Pick<Plan, "nodes">): boolean {
	const nonTerminal = deliverables(plan).filter(
		(d) => !TERMINAL_STATUSES.includes(d.status),
	);
	if (nonTerminal.length === 0) return false;
	return nonTerminal.every(isStuckDeliverable);
}

/**
 * State-machine transitions. Maps current → allowed next states.
 * Used both for validation and for UI hints.
 */
export const DELIVERABLE_TRANSITIONS: Record<
	DeliverableStatus,
	readonly DeliverableStatus[]
> = {
	planned: ["active", "abandoned"],
	active: ["in-review", "abandoned"],
	"in-review": ["ready-to-ship", "needs-attention", "abandoned"],
	"needs-attention": ["ready-to-ship", "abandoned"],
	"ready-to-ship": ["shipped", "abandoned"],
	shipped: [],
	abandoned: [],
};

export function canTransition(
	from: DeliverableStatus,
	to: DeliverableStatus,
): boolean {
	return DELIVERABLE_TRANSITIONS[from].includes(to);
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
 * Generate a deliverable id from a title. Returns a plain slug;
 * strips the legacy `p-` prefix for idempotence on legacy inputs.
 */
export function deliverableId(title: string): string {
	return slugify(title).replace(/^p-/, "");
}

/**
 * Generate a work-item id from a title. Same prefix-stripping policy
 * as {@link deliverableId} for the legacy `t-` prefix.
 */
export function workItemId(title: string): string {
	return slugify(title).replace(/^t-/, "");
}

/**
 * Compare two deliverable ids ignoring a legacy `p-` prefix on either
 * side (plans created before the prefix-drop have `id: "p-…"` on
 * disk).
 */
export function matchDeliverableId(stored: string, query: string): boolean {
	return stored.replace(/^p-/, "") === query.replace(/^p-/, "");
}

/** Companion to {@link matchDeliverableId} for the legacy `t-` prefix. */
export function matchWorkItemId(stored: string, query: string): boolean {
	return stored.replace(/^t-/, "") === query.replace(/^t-/, "");
}

/** Default branch name derived from a deliverable id. */
export function defaultBranchForDeliverable(
	d: Pick<Deliverable, "id">,
): string {
	return `feat/${d.id}`;
}

/**
 * Find the unique top-level pre/post lifecycle deliverable, if any.
 * Schema validation enforces top-level-only and at-most-one each.
 */
export function findLifecycle(
	plan: Pick<Plan, "nodes">,
	which: DeliverableLifecycle,
): Deliverable | undefined {
	return plan.nodes.filter(isDeliverable).find((d) => d.lifecycle === which);
}

/**
 * Deliverables that hold actual code work. Excludes lifecycle
 * checklists; includes groupings (their subtrees hold the work).
 */
export function regularDeliverables(plan: Pick<Plan, "nodes">): Deliverable[] {
	return deliverables(plan).filter((d) => !d.lifecycle);
}

/**
 * Lifecycle gate. Returns the pre/post deliverable if one exists AND
 * has at least one work-item that isn't `done` — items of any kind
 * count (the checklist is itself manual). Returns `null` when absent
 * or fully ticked.
 */
export function pendingLifecycle(
	plan: Pick<Plan, "nodes">,
	which: DeliverableLifecycle,
): Deliverable | null {
	const d = findLifecycle(plan, which);
	if (!d) return null;
	const items = ownWorkItems(d);
	if (items.length === 0) return null;
	const allDone = items.every((t) => t.done);
	return allDone ? null : d;
}

/**
 * Read a deliverable's `dependsOn`, defaulting to a single-parent
 * fallback derived from the flattened order for legacy in-memory plan
 * objects that bypass storage (fixtures, ad-hoc test plans). Plans
 * persisted under v2+ always have `dependsOn` populated by migration.
 *
 * Fallback rule: parent = nearest preceding non-abandoned deliverable
 * in preorder. First in the forest (or every predecessor abandoned)
 * → `[]`.
 */
export function effectiveDependsOn(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id" | "dependsOn">,
): string[] {
	if (d.dependsOn !== undefined) return d.dependsOn;
	const flat = deliverables(plan);
	const idx = flat.findIndex((p) => p.id === d.id);
	if (idx <= 0) return [];
	for (let i = idx - 1; i >= 0; i--) {
		const prev = flat[i];
		if (prev && prev.status !== "abandoned") return [prev.id];
	}
	return [];
}

/**
 * Statuses where the deliverable's branch holds work that hasn't
 * reached the default branch yet. A successor activated while a
 * predecessor is in one of these states must fork from the
 * predecessor's branch (stacked PR) — see {@link pickBaseBranch}.
 */
const IN_FLIGHT_PARENT_STATUSES: readonly DeliverableStatus[] = [
	"active",
	"in-review",
	"ready-to-ship",
	"needs-attention",
] as const;

/**
 * Statuses where a successor can be activated. Either the parent has
 * shipped (default branch carries the change) or it's in-flight
 * (successor stacks on the parent's branch). Excludes `planned`
 * (parent has no commits yet) and `abandoned` (branch is gone).
 */
const ACTIVATABLE_PARENT_STATUSES: readonly DeliverableStatus[] = [
	...IN_FLIGHT_PARENT_STATUSES,
	"shipped",
] as const;

/**
 * A deliverable is "ready" when `/implement` can activate it: it's
 * `planned`, it's an implementable leaf (lifecycle checklists and
 * groupings never enter the activation queue — a grouping's children
 * do), AND its (single) parent in {@link effectiveDependsOn} is
 * absent, `shipped`, or in-flight (stacked-PR workflow).
 */
export function isDeliverableReady(
	plan: Pick<Plan, "nodes">,
	d: Pick<
		Deliverable,
		"id" | "status" | "dependsOn" | "lifecycle" | "children"
	>,
): boolean {
	if (d.status !== "planned") return false;
	if (!isImplementableLeaf(d)) return false;
	const deps = effectiveDependsOn(plan, d);
	if (deps.length === 0) return true;
	const parent = deliverables(plan).find((p) => p.id === deps[0]);
	if (!parent) return false;
	if (isGrouping(parent)) {
		// A grouping never carries commits itself; it gates on its
		// subtree. Treat it as activatable once its subtree has fully
		// shipped (the grouping's own status flips via /sync), else
		// blocked — children stack on each other, not on the grouping.
		return parent.status === "shipped";
	}
	return ACTIVATABLE_PARENT_STATUSES.includes(parent.status);
}

/**
 * Deliverables that can be activated right now, in preorder.
 * Used by the auto loop's next picker, concurrent driver discovery,
 * and widgets.
 */
export function readyDeliverables(plan: Pick<Plan, "nodes">): Deliverable[] {
	return deliverables(plan).filter((d) => isDeliverableReady(plan, d));
}

/**
 * Walk down the chain rooted at `d`, following the first successor in
 * preorder at each step. Skips shipped successors and non-shipping
 * nodes (lifecycle, groupings); returns the first non-shipped
 * PR-shipping successor on that path, or `null` when the path
 * dead-ends.
 *
 * Used by the auto loop after `/ship` to advance to the next
 * deliverable in the same chain.
 */
export function chainHead(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id">,
): Deliverable | null {
	const flat = deliverables(plan);
	let curId = d.id;
	// Bound the walk so a hand-edited plan with a dependency cycle
	// can't infinite-loop. Cycles are rejected at write time but
	// on-disk plans may be edited externally.
	for (let steps = 0; steps < flat.length; steps++) {
		const next = flat.find((p) => effectiveDependsOn(plan, p)[0] === curId);
		if (!next) return null;
		if (!isImplementableLeaf(next)) {
			curId = next.id;
			continue;
		}
		if (next.status === "shipped") {
			curId = next.id;
			continue;
		}
		return next;
	}
	return null;
}

/**
 * Human-readable reason `d` isn't in {@link readyDeliverables}, or
 * `null` when it IS ready.
 */
export function blockedReason(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id" | "status" | "dependsOn">,
): string | null {
	if (d.status !== "planned") {
		return `deliverable \`${d.id}\` is ${d.status}, not planned`;
	}
	const deps = effectiveDependsOn(plan, d);
	if (deps.length === 0) return null;
	const parentId = deps[0];
	const parent = deliverables(plan).find((p) => p.id === parentId);
	if (!parent) return `unknown parent \`${parentId}\``;
	if (isGrouping(parent)) {
		return parent.status === "shipped"
			? null
			: `waiting on grouping \`${parent.id}\` (completes when its children ship)`;
	}
	if (ACTIVATABLE_PARENT_STATUSES.includes(parent.status)) return null;
	if (parent.status === "abandoned") {
		return `waiting on abandoned deliverable \`${parent.id}\` — edit dependsOn to unblock`;
	}
	return `waiting on \`${parent.id}\` (${parent.status})`;
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
 * Statuses where the parent's branch holds work that hasn't reached
 * the default branch yet — the stacked-PR fork case.
 */
const PARENT_BRANCH_STATUSES: readonly DeliverableStatus[] =
	IN_FLIGHT_PARENT_STATUSES;

/**
 * Pick the base branch a freshly-activated deliverable should fork
 * from.
 *
 * Algorithm: look at the at-most-one parent from
 * {@link effectiveDependsOn}.
 *   - No parent / parent missing / shipped / abandoned / planned →
 *     fork from `defaultBranch`.
 *   - Parent is a grouping → fork from `defaultBranch` (groupings
 *     never carry commits; their children's branches stack on each
 *     other directly).
 *   - Parent in-flight with a branch → fork from the parent's branch
 *     (stacked-PR case).
 */
export function pickBaseBranch(
	plan: Pick<Plan, "nodes">,
	activatingId: string,
	defaultBranch: string,
): string {
	const flat = deliverables(plan);
	const activating = flat.find((d) => d.id === activatingId);
	if (!activating) return defaultBranch;
	const deps = effectiveDependsOn(plan, activating);
	const parentId = deps[0];
	if (!parentId) return defaultBranch;
	const parent = flat.find((d) => d.id === parentId);
	if (!parent) return defaultBranch;
	if (isGrouping(parent)) return defaultBranch;
	if (PARENT_BRANCH_STATUSES.includes(parent.status) && parent.branch) {
		return parent.branch;
	}
	return defaultBranch;
}

/**
 * Decision for how `/implement` should set up a deliverable's branch.
 *
 *   - `create`: first-time activation (status `planned`). Create the
 *     branch from the picked base.
 *   - `resume`: already in flight and its branch exists locally.
 *     Plain checkout, no reset — commits must be preserved.
 *   - `abort`: in flight but the branch is missing locally. Refuse —
 *     a destructive `-B` re-create would silently lose work.
 */
export type ImplementBranchPlan =
	| { kind: "create"; branch: string; baseBranch: string }
	| { kind: "resume"; branch: string }
	| { kind: "abort"; reason: string };

/**
 * Decide what `/implement` should do to set up the deliverable's
 * branch. Unit-testable coverage of the destructive-reset bug:
 * re-invoking /implement must never reset an in-flight branch.
 */
export function planImplementBranch(
	plan: Pick<Plan, "nodes">,
	d: Pick<Deliverable, "id" | "branch" | "status">,
	defaultBranch: string,
	branchExists: boolean,
): ImplementBranchPlan {
	const branch = d.branch ?? defaultBranchForDeliverable(d);
	if (d.status === "planned") {
		return {
			kind: "create",
			branch,
			baseBranch: pickBaseBranch(plan, d.id, defaultBranch),
		};
	}
	if (!branchExists) {
		return {
			kind: "abort",
			reason:
				`deliverable branch \`${branch}\` is missing locally. ` +
				"Was it deleted? Refusing to recreate — that would silently " +
				"reset the deliverable to the default branch and lose any " +
				"commits. Investigate (e.g. `git reflog`, `git branch -a`) " +
				"and restore the branch before re-running /implement.",
		};
	}
	return { kind: "resume", branch };
}

// ---- Write-time validation ----------------------------------------------

/**
 * Structural invariants enforced at write time (the tool layer calls
 * this before saving). Returns human-readable problems; empty array
 * means the plan shape is valid.
 *
 *   - gating XOR: a deliverable cannot have both gating `task` items
 *     and child deliverables.
 *   - dependsOn: ≤ 1 entry; targets must be deliverable ids that
 *     exist; no cycles.
 *   - lifecycle: top-level only, at most one `pre` and one `post`,
 *     and lifecycle deliverables cannot nest child deliverables.
 */
export function validatePlanShape(plan: Pick<Plan, "nodes">): string[] {
	const problems: string[] = [];
	const flat = deliverables(plan);
	const ids = new Set(flat.map((d) => d.id));

	for (const d of flat) {
		if (gatingTasks(d).length > 0 && childDeliverables(d).length > 0) {
			problems.push(
				`deliverable \`${d.id}\` has both gating tasks and child deliverables — split the tasks into a child deliverable or remove the nesting`,
			);
		}
		const deps = d.dependsOn ?? [];
		if (deps.length > 1) {
			problems.push(
				`deliverable \`${d.id}\` has ${deps.length} dependsOn entries — at most one parent is allowed`,
			);
		}
		for (const dep of deps) {
			if (!ids.has(dep)) {
				problems.push(
					`deliverable \`${d.id}\` depends on unknown deliverable \`${dep}\``,
				);
			}
		}
		if (d.lifecycle && childDeliverables(d).length > 0) {
			problems.push(
				`lifecycle deliverable \`${d.id}\` cannot contain child deliverables`,
			);
		}
	}

	// Lifecycle: top-level only, ≤1 each.
	const nested = flat.filter((d) => d.lifecycle && !plan.nodes.includes(d));
	for (const d of nested) {
		problems.push(
			`lifecycle deliverable \`${d.id}\` must be top-level, not nested`,
		);
	}
	for (const which of ["pre", "post"] as const) {
		const count = flat.filter((d) => d.lifecycle === which).length;
		if (count > 1) {
			problems.push(
				`plan has ${count} \`${which}\` deliverables — at most one is allowed`,
			);
		}
	}

	// Cycle check over dependsOn edges.
	const colour = new Map<string, "visiting" | "done">();
	const byId = new Map(flat.map((d) => [d.id, d]));
	const visit = (id: string, trail: string[]): void => {
		const state = colour.get(id);
		if (state === "done") return;
		if (state === "visiting") {
			problems.push(`dependsOn cycle: ${[...trail, id].join(" → ")}`);
			return;
		}
		colour.set(id, "visiting");
		const node = byId.get(id);
		for (const dep of node?.dependsOn ?? []) {
			if (byId.has(dep)) visit(dep, [...trail, id]);
		}
		colour.set(id, "done");
	};
	for (const d of flat) visit(d.id, []);

	return problems;
}
