/**
 * Plan storage at `~/.pi/plans/`.
 *
 * Layout:
 *
 *   ~/.pi/plans/
 *   ├── index.json                      # { plans: [{ slug, title, repoPath, ... }] }
 *   └── <plan-slug>/
 *       └── plan.json                   # full Plan object
 *
 * Plans are global (not per-repo) — the user can list all their plans
 * across projects and resume any of them. Each Plan carries `repo.path`
 * so we can route operations back to the right working tree.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Phase, Plan, Task } from "./schema.js";
import { TERMINAL_STATUSES } from "./schema.js";

let plansRoot = join(homedir(), ".pi", "plans");

/**
 * Allowed slug pattern: lowercase alphanumerics and hyphens only. This
 * forbids path separators, dot-segments, and any character that could
 * traverse outside `plansRoot`.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;

function assertValidSlug(slug: string): void {
	if (!SLUG_RE.test(slug)) {
		throw new Error(
			`invalid plan slug: ${JSON.stringify(slug)} — must match ${SLUG_RE}`,
		);
	}
}

/**
 * Defence-in-depth: after resolving any plan path, verify it stays
 * inside `plansRoot`. Catches edge cases the regex might miss (e.g.
 * symlink shenanigans on platforms that normalise differently).
 *
 * Uses `path.relative` to be platform-correct — hard-coded "/" would
 * miss Windows backslash separators and could be tricked by mixed
 * normalisations. Reject when the resolved path differs from the root
 * AND the relative form either escapes (`..`) or is absolute.
 */
function assertInsideRoot(path: string): void {
	const rootResolved = resolve(plansRoot);
	const pathResolved = resolve(path);
	if (pathResolved === rootResolved) return;
	const rel = relative(rootResolved, pathResolved);
	if (rel === "" || rel === ".") return;
	if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
		throw new Error(
			`refusing to operate on plan path outside ${rootResolved}: ${pathResolved}`,
		);
	}
}

function indexFile(): string {
	return join(plansRoot, "index.json");
}

function ensurePlansRoot(): void {
	if (!existsSync(plansRoot)) {
		mkdirSync(plansRoot, { recursive: true });
	}
}

function planDir(slug: string): string {
	assertValidSlug(slug);
	const path = join(plansRoot, slug);
	assertInsideRoot(path);
	return path;
}

function planFile(slug: string): string {
	return join(planDir(slug), "plan.json");
}

/** True if a plan with this slug exists on disk. */
export function planExists(slug: string): boolean {
	if (!SLUG_RE.test(slug)) return false;
	return existsSync(planFile(slug));
}

/** Load a plan by slug. Returns null if the slug is invalid, missing, or malformed. */
export function loadPlan(slug: string): Plan | null {
	if (!SLUG_RE.test(slug)) return null;
	const path = planFile(slug);
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Plan;
		if (typeof parsed.slug !== "string") return null;
		return migratePlan(parsed);
	} catch {
		return null;
	}
}

/**
 * Lazy on-load migration to the current schema version. Pure: takes
 * a parsed plan, returns a normalised plan. Idempotent — running
 * twice produces the same shape.
 *
 * v1 → v2 changes:
 *   - Phase.dependsOn back-filled from array order (nearest non-
 *     abandoned predecessor, or [] for the first phase).
 *   - Task.kind defaulted to "deliverable" on every existing task.
 *   - Plan.followUps initialised to [].
 *   - schemaVersion stamped to 2.
 *
 * The migrated plan is returned in-memory; the next savePlan persists
 * the new shape. Callers don't need to know the version — they always
 * see v2-shaped plans.
 */
export function migratePlan(input: Plan): Plan {
	if ((input.schemaVersion ?? 1) >= CURRENT_SCHEMA_VERSION) {
		// Already current. Still normalise tasks/followUps in case the
		// on-disk file was hand-edited and dropped a field.
		return normaliseV2(input);
	}
	const phases: Phase[] = input.phases.map((phase, idx) => {
		const dependsOn =
			phase.dependsOn ?? deriveLegacyDependsOn(input.phases, idx);
		return {
			...phase,
			dependsOn,
			tasks: phase.tasks.map(normaliseTask),
		};
	});
	return {
		...input,
		schemaVersion: CURRENT_SCHEMA_VERSION,
		phases,
		followUps: (input.followUps ?? []).map(normaliseTask),
	};
}

function normaliseV2(plan: Plan): Plan {
	let mutated = false;
	const phases = plan.phases.map((phase) => {
		let phaseMutated = false;
		let tasks = phase.tasks;
		if (phase.tasks.some((t) => t.kind === undefined)) {
			tasks = phase.tasks.map(normaliseTask);
			phaseMutated = true;
		}
		if (phase.dependsOn === undefined) {
			phaseMutated = true;
			return { ...phase, tasks, dependsOn: [] };
		}
		if (phaseMutated) {
			mutated = true;
			return { ...phase, tasks };
		}
		return phase;
	});
	const followUps = plan.followUps ?? [];
	const followUpsNormalised = followUps.map(normaliseTask);
	if (
		plan.followUps === undefined ||
		followUps.some((t) => t.kind === undefined)
	) {
		mutated = true;
	}
	if (!mutated) return plan;
	return { ...plan, phases, followUps: followUpsNormalised };
}

function normaliseTask(task: Task): Task {
	if (task.kind !== undefined) return task;
	return { ...task, kind: "deliverable" };
}

function deriveLegacyDependsOn(phases: Phase[], idx: number): string[] {
	for (let i = idx - 1; i >= 0; i--) {
		const prev = phases[i];
		if (prev && prev.status !== "abandoned") return [prev.id];
	}
	return [];
}

const CURRENT_SCHEMA_VERSION = 2;

/** Persist a plan and refresh the index. Caller is responsible for `updatedAt`. */
export function savePlan(plan: Plan): void {
	ensurePlansRoot();
	const dir = planDir(plan.slug);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(planFile(plan.slug), JSON.stringify(plan, null, 2), "utf8");
	rebuildIndex();
}

/** Delete a plan from disk. Refreshes the index. */
export function deletePlan(slug: string): void {
	const dir = planDir(slug);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
	rebuildIndex();
}

/** All plans on disk, newest first. */
export function listPlans(): PlanIndexEntry[] {
	if (!existsSync(indexFile())) {
		rebuildIndex();
	}
	try {
		const raw = readFileSync(indexFile(), "utf8");
		const parsed = JSON.parse(raw) as PlanIndex;
		return parsed.plans ?? [];
	} catch {
		return [];
	}
}

/** Plans associated with a repo path (exact match). */
export function plansForRepo(repoPath: string): PlanIndexEntry[] {
	return listPlans().filter((p) => p.repoPath === repoPath);
}

/**
 * Plans this session has touched — either created (`createdBy` matches)
 * or bound at least once (`seenIn` contains the id). Used by /plan list
 * to group plans into "this session" / "other sessions" / "legacy"
 * buckets and by future tooling that wants a session-scoped view.
 */
export function plansForSession(sessionId: string): PlanIndexEntry[] {
	return listPlans().filter(
		(p) => p.createdBy === sessionId || p.seenIn.includes(sessionId),
	);
}

/**
 * Find the active plan for a repo, if any. "Active" means at least one
 * phase isn't terminal (shipped/abandoned). When multiple plans match,
 * picks the most recently updated.
 */
export function activePlanForRepo(repoPath: string): PlanIndexEntry | null {
	const matches = plansForRepo(repoPath).filter((p) => p.active);
	if (matches.length === 0) return null;
	matches.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	return matches[0];
}

export interface PlanIndexEntry {
	slug: string;
	title: string;
	repoPath: string;
	updatedAt: string;
	/** True if any phase is still working (not all phases shipped/abandoned). */
	active: boolean;
	/**
	 * Session UUID that originally created this plan. Undefined for
	 * legacy plans created before session-ownership tracking landed.
	 */
	createdBy?: string;
	/**
	 * Distinct sessions that have ever bound this plan via /plan or
	 * /plan resume. Always an array — empty for legacy plans that
	 * have not yet been touched by any tracked session.
	 */
	seenIn: string[];
}

export interface PlanIndex {
	plans: PlanIndexEntry[];
}

/** Rebuild the index from on-disk plan dirs. */
export function rebuildIndex(): void {
	ensurePlansRoot();
	const entries: PlanIndexEntry[] = [];
	for (const name of readdirSync(plansRoot)) {
		if (name === "index.json") continue;
		// Skip any directory whose name isn't a valid slug — a defence in
		// depth against attacker-planted directories under plansRoot.
		if (!SLUG_RE.test(name)) continue;
		const path = planFile(name);
		if (!existsSync(path)) continue;
		try {
			const plan = JSON.parse(readFileSync(path, "utf8")) as Plan;
			// A plan is "active" (reusable for /plan in this repo) if it has
			// no phases yet OR at least one phase is still working. Otherwise
			// every phase is shipped/abandoned and the plan is done.
			const active =
				plan.phases.length === 0 ||
				plan.phases.some((ph) => !TERMINAL_STATUSES.includes(ph.status));
			entries.push({
				slug: plan.slug,
				title: plan.title,
				repoPath: plan.repo.path,
				updatedAt: plan.updatedAt,
				active,
				...(plan.createdBy?.sessionId
					? { createdBy: plan.createdBy.sessionId }
					: {}),
				seenIn: plan.seenIn ?? [],
			});
		} catch {
			// skip malformed entries
		}
	}
	entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	writeFileSync(
		indexFile(),
		JSON.stringify({ plans: entries }, null, 2),
		"utf8",
	);
}

/** Path to the plan dir — exposed for tests / debug. */
export function planDirPath(slug: string): string {
	return planDir(slug);
}

/** Override the plans root for tests. */
export function _setPlansRootForTests(root: string): void {
	plansRoot = root;
}
