/**
 * Phase / Task plan schema.
 *
 * A Plan is a structured replacement for the flat `plan_step` list. It
 * groups Tasks under Phases. Each Phase ships as one PR / one issue.
 *
 * Status flow:
 *
 *   planned ─► active ─► in-review ─► ready-to-ship ─► shipped
 *                ▲           │
 *                │           ▼
 *                └── needs-attention
 *
 * Plus a terminal `abandoned` reachable from any non-terminal state.
 *
 * Worktree lifecycle is bound to active work: a worktree exists only while
 * a phase is in `active` or `needs-attention`. Branches are kept forever.
 */

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

export interface Task {
	id: string;
	/** Short, scannable. No length cap — but agent should keep it concise. */
	title: string;
	/** Detailed: context, acceptance criteria, files, test notes. */
	body: string;
	done: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Phase {
	id: string;
	title: string;
	/** One-line: what ships when this merges. */
	goal: string;
	status: PhaseStatus;
	/** Git branch — typically `feat/<phase-id>`. */
	branch: string;
	/** GitHub issue number after /park; undefined before. */
	issueNumber?: number;
	tasks: Task[];
	/** PR number once /ship has opened it. */
	prNumber?: number;
	/** Findings count from the once-only review. Undefined until reviewed. */
	reviewFindingsCount?: number;
	/** True after the once-only review has run. Prevents re-runs. */
	reviewRun?: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PlanRepo {
	path: string;
	remote?: string;
}

export interface Plan {
	slug: string;
	title: string;
	repo: PlanRepo;
	/** GitHub plan-tracking issue (parent of phase sub-issues) after /park. */
	parentIssueNumber?: number;
	phases: Phase[];
	shipPolicy: "auto" | "prompt";
	/** Last successful PR-state sync via gh. */
	lastSyncedAt?: string;
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

/** Generate a phase id from a title, with `p-` prefix. */
export function phaseId(title: string): string {
	const slug = slugify(title);
	return slug.startsWith("p-") ? slug : `p-${slug}`;
}

/** Generate a task id from a title, with `t-` prefix. */
export function taskId(title: string): string {
	const slug = slugify(title);
	return slug.startsWith("t-") ? slug : `t-${slug}`;
}

/** Default branch name derived from a phase id. */
export function defaultBranchForPhase(phase: Pick<Phase, "id">): string {
	return `feat/${phase.id}`;
}

/** Repo-name derivation — the basename used for worktree path scoping. */
export function repoNameFromPath(path: string): string {
	const last = path.split("/").filter(Boolean).pop();
	return last ?? "repo";
}
