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
import { join, resolve } from "node:path";
import type { Plan } from "./schema.js";
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
 */
function assertInsideRoot(path: string): void {
	const rootResolved = resolve(plansRoot);
	const pathResolved = resolve(path);
	if (
		pathResolved !== rootResolved &&
		!pathResolved.startsWith(`${rootResolved}/`)
	) {
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
		return parsed;
	} catch {
		return null;
	}
}

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
