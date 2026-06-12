/**
 * Plan storage under the resolved agent dir: `<agent-dir>/plans/`.
 *
 * `<agent-dir>` is `getAgentDir()` (honours PI_CODING_AGENT_DIR / XDG),
 * e.g. `~/.config/pi/agent/plans/` — not a hardcoded `~/.pi`.
 *
 * Layout:
 *
 *   <agent-dir>/plans/
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
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { lock as lockAsync, lockSync } from "proper-lockfile";
import type {
	Deliverable,
	DeliverableStatus,
	DeliverableTokens,
	Plan,
	PlanNode,
	WorkItem,
	WorkItemKind,
} from "./schema.js";
import { deliverables, TERMINAL_STATUSES } from "./schema.js";

// Plans live under the resolved agent dir (honours PI_CODING_AGENT_DIR /
// XDG), not a hardcoded ~/.pi. The previous hardcode ignored the env
// override and wrote to the wrong directory on configs that relocate the
// agent dir (e.g. ~/.config/pi/agent).
let plansRoot = join(getAgentDir(), "plans");

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

// ---- Legacy (v1/v2) on-disk shapes, used only by migration ---------------

type LegacyTaskKind = "deliverable" | "followUp" | "question" | "manual";

interface LegacyTask {
	id: string;
	title: string;
	body: string;
	done: boolean;
	kind?: LegacyTaskKind;
	createdAt: string;
	updatedAt: string;
}

interface LegacyPhase {
	id: string;
	title: string;
	goal: string;
	status: DeliverableStatus;
	branch: string;
	kind?: "pre" | "regular" | "post";
	dependsOn?: string[];
	worktreePath?: string;
	sessionPath?: string;
	driverSessionId?: string;
	driverSessionFile?: string;
	driverClaimedAt?: string;
	issueNumber?: number;
	tasks: LegacyTask[];
	prNumber?: number;
	summary?: string;
	tokens?: DeliverableTokens;
	createdAt: string;
	updatedAt: string;
}

/** v1/v2 plan as parsed straight off disk. */
interface LegacyPlan extends Omit<Plan, "nodes"> {
	phases?: LegacyPhase[];
	followUps?: LegacyTask[];
	nodes?: PlanNode[];
}

const LEGACY_KIND_REMAP: Record<LegacyTaskKind, WorkItemKind> = {
	deliverable: "task",
	followUp: "followup",
	question: "question",
	manual: "manual",
};

function migrateLegacyTask(task: LegacyTask): WorkItem {
	const { kind, ...rest } = task;
	return {
		type: "work-item",
		...rest,
		kind: LEGACY_KIND_REMAP[kind ?? "deliverable"],
	};
}

function migrateLegacyPhase(phase: LegacyPhase): Deliverable {
	const { goal, kind, tasks, branch, ...rest } = phase;
	const lifecycle = kind === "pre" || kind === "post" ? kind : undefined;
	return {
		type: "deliverable",
		...rest,
		body: goal,
		// Pre/post phases carried `branch: ""` — drop it; regular phases
		// keep theirs.
		...(branch ? { branch } : {}),
		...(lifecycle ? { lifecycle } : {}),
		children: tasks.map(migrateLegacyTask),
	};
}

function deriveLegacyDependsOn(phases: LegacyPhase[], idx: number): string[] {
	for (let i = idx - 1; i >= 0; i--) {
		const prev = phases[i];
		if (prev && prev.status !== "abandoned") return [prev.id];
	}
	return [];
}

/**
 * v2 → v3: phases become top-level deliverable nodes (goal→body,
 * kind→lifecycle, tasks→children, empty branch dropped), plan-level
 * followUps become top-level loose work-items, and legacy task kinds
 * remap (`deliverable`→`task`, `followUp`→`followup`).
 */
function migrateV2toV3(input: LegacyPlan): Plan {
	const { phases, followUps, ...rest } = input;
	const nodes: PlanNode[] = [
		...(phases ?? []).map(migrateLegacyPhase),
		...(followUps ?? []).map(migrateLegacyTask),
	];
	return { ...rest, schemaVersion: CURRENT_SCHEMA_VERSION, nodes };
}

/**
 * Lazy on-load migration to the current schema version. Pure: takes
 * a parsed plan (any version), returns a normalised v3 plan.
 * Idempotent — running twice produces the same shape.
 *
 * Chain: v1 → v2 (back-fill dependsOn from array order, default task
 * kinds, init followUps) → v3 (node forest, see {@link migrateV2toV3}).
 *
 * The migrated plan is returned in-memory; the next savePlan persists
 * the new shape. Callers always see v3-shaped plans.
 */
export function migratePlan(input: Plan): Plan {
	const legacy = input as unknown as LegacyPlan;
	const version = legacy.schemaVersion ?? 1;
	if (version >= CURRENT_SCHEMA_VERSION) {
		return normaliseV3(input);
	}
	// Defensive: a plan that already carries `nodes` (and no legacy
	// `phases`) IS v3-shaped regardless of its version stamp — running
	// the legacy migration would wipe the forest. Covers in-memory
	// fixtures and hand-edited files that dropped the stamp.
	if (Array.isArray(legacy.nodes) && legacy.phases === undefined) {
		return normaliseV3({
			...input,
			schemaVersion: CURRENT_SCHEMA_VERSION,
		});
	}
	let v2: LegacyPlan = legacy;
	if (version < 2) {
		const phases = (legacy.phases ?? []).map((phase, idx) => ({
			...phase,
			dependsOn:
				phase.dependsOn ?? deriveLegacyDependsOn(legacy.phases ?? [], idx),
		}));
		v2 = {
			...legacy,
			schemaVersion: 2,
			phases,
			followUps: legacy.followUps ?? [],
		};
	}
	return migrateV2toV3(v2);
}

/**
 * Normalise a v3+ plan in case the on-disk file was hand-edited:
 * ensure `nodes` exists and every node carries its `type`
 * discriminant (inferred from the presence of `status`).
 */
function normaliseV3(plan: Plan): Plan {
	const raw = plan as Plan & { nodes?: PlanNode[] };
	if (!Array.isArray(raw.nodes)) {
		return { ...plan, nodes: [] };
	}
	let mutated = false;
	const fix = (nodes: PlanNode[]): PlanNode[] =>
		nodes.map((node) => {
			const anyNode = node as unknown as Record<string, unknown>;
			let next = node;
			if (next.type !== "deliverable" && next.type !== "work-item") {
				mutated = true;
				next = {
					...anyNode,
					type: anyNode.status !== undefined ? "deliverable" : "work-item",
				} as PlanNode;
			}
			if (next.type === "deliverable") {
				const children = Array.isArray(next.children) ? next.children : [];
				const fixed = fix(children);
				if (fixed !== next.children || !Array.isArray(next.children)) {
					mutated = true;
					next = { ...next, children: fixed };
				}
			}
			return next;
		});
	const nodes = fix(raw.nodes);
	if (!mutated) return plan;
	return { ...plan, nodes };
}

export const CURRENT_SCHEMA_VERSION = 3;

/**
 * Thrown by the write path (`savePlan` / `withPlanLock`) when the
 * on-disk plan was written by a NEWER schema than this code
 * understands. Loading is allowed (read-only inspection is fine);
 * writing would silently downgrade/corrupt fields the newer code
 * relies on. Mixed-version fleets must not span a schema upgrade.
 */
export class SchemaTooNewError extends Error {
	constructor(
		public readonly slug: string,
		public readonly fileVersion: number,
	) {
		super(
			`plan ${slug} has schemaVersion ${fileVersion}, newer than this code (${CURRENT_SCHEMA_VERSION}) — update the extension before writing`,
		);
		this.name = "SchemaTooNewError";
	}
}

function assertWritableVersion(plan: Plan): void {
	const version = plan.schemaVersion ?? 1;
	if (version > CURRENT_SCHEMA_VERSION) {
		throw new SchemaTooNewError(plan.slug, version);
	}
}

/**
 * Lockfile retry config used by both sync and async lock helpers.
 * Tuned for short tool-layer mutations: 5 retries with 50–250ms
 * backoff covers common contention without making concurrent
 * writers feel laggy.
 */
const LOCK_RETRIES = { retries: 5, minTimeout: 50, maxTimeout: 250 };

/**
 * Stale lock TTL. proper-lockfile updates the lockfile mtime
 * periodically while held; if it's older than this we consider the
 * holder dead and break the lock. 30s covers the longest plausible
 * intra-tool mutation (huge plan, slow disk) without leaving
 * abandoned locks blocking other sessions for ages.
 */
const LOCK_STALE_MS = 30_000;

/**
 * Manual retry loop for `lockSync`. proper-lockfile's sync API
 * doesn't accept a retries config (only the async API does), so we
 * spin briefly with `Atomics.wait` for cross-process contention.
 * Same parameters as `LOCK_RETRIES`.
 */
/**
 * proper-lockfile signals contention with `code: "ELOCKED"`. Other
 * errors (permission denied, ENOENT, …) shouldn't be retried — they
 * mean the call won't succeed under any timeout.
 */
function isContentionError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ELOCKED"
	);
}

function lockSyncWithRetry(path: string): () => void {
	const { retries, minTimeout, maxTimeout } = LOCK_RETRIES;
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return lockSync(path, { stale: LOCK_STALE_MS });
		} catch (err) {
			lastErr = err;
			if (!isContentionError(err)) throw err;
			if (attempt === retries) break;
			const backoff = Math.min(maxTimeout, minTimeout * 2 ** attempt);
			const sab = new SharedArrayBuffer(4);
			Atomics.wait(new Int32Array(sab), 0, 0, backoff);
		}
	}
	throw lastErr;
}

/**
 * Ensure the plan dir exists so proper-lockfile can create the
 * lockfile next to plan.json. proper-lockfile rejects if the parent
 * directory is missing; for first-time saves we create it eagerly.
 */
function ensurePlanDir(slug: string): void {
	ensurePlansRoot();
	const dir = planDir(slug);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Thrown by `withPlanLock` when the requested plan slug doesn't
 * resolve to a loadable plan on disk. Distinct from a generic Error
 * so callers can branch on "plan unusable" without parsing messages.
 *
 * Note: `loadPlan` returns `null` for both missing files and files
 * that fail to parse as v1/v2 plan JSON. This error therefore covers
 * both cases ("missing or unloadable"). If a caller needs to
 * distinguish, check `existsSync(planFile(slug))` separately before
 * entering `withPlanLock`.
 */
export class PlanNotFoundError extends Error {
	constructor(public readonly slug: string) {
		super(`plan ${slug} not found`);
		this.name = "PlanNotFoundError";
	}
}

/**
 * Thrown by `assertPlanUnchanged` when an optimistic CAS check fails
 * — i.e. another writer advanced `plan.updatedAt` between the time
 * the caller read the plan and the time it tried to write it back.
 *
 * Use this for read-modify-write paths that span an LLM call (where
 * holding the file lock for minutes would block every other
 * session). The caller catches and re-loads + retries.
 */
export class PlanStaleError extends Error {
	constructor(
		public readonly slug: string,
		public readonly expected: string,
		public readonly actual: string,
	) {
		super(
			`plan ${slug} changed on disk: expected updatedAt=${expected}, found ${actual}`,
		);
		this.name = "PlanStaleError";
	}
}

/**
 * Run `mutator` with exclusive access to the plan file. Loads the
 * plan inside the lock (post-migration), passes it to the mutator,
 * persists the in-place mutated plan, releases the lock — even on
 * throw.
 *
 * Mutator contract:
 *   - Receives the loaded plan. Free to mutate in place.
 *   - Should bump `plan.updatedAt` itself when the change is
 *     meaningful; this helper does NOT auto-bump (callers may want
 *     to skip a bump for read-only paths or compute their own
 *     timestamp).
 *   - Returns the value to be returned to the caller. Returning a
 *     replacement plan object is NOT supported — the helper writes
 *     back the loaded `plan` reference. Mutate in place.
 *   - May be async.
 *   - When `mutator` returns explicitly with `save: false`, the lock
 *     is released without writing. Useful for branches that decide
 *     mid-mutation that no save is needed.
 *   - When `mutator` returns explicitly with `save: false`, the lock
 *     is released without writing. Useful for branches that decide
 *     mid-mutation that no save is needed.
 *
 * The mutator MUST NOT call `savePlan` itself — the helper handles
 * the save and a nested `savePlan` would deadlock waiting on the
 * lock it already holds.
 *
 * Cross-process safety: yes (lockfile is on disk, OS-arbitrated).
 * Same-process re-entry: NO — do not nest withPlanLock calls on the
 * same slug from the same process.
 */
export async function withPlanLock<T>(
	slug: string,
	mutator: (
		plan: Plan,
	) => Promise<T | { result: T; save: false }> | T | { result: T; save: false },
): Promise<T> {
	assertValidSlug(slug);
	ensurePlanDir(slug);
	const path = planFile(slug);
	// Track whether we created the placeholder so we can clean it up if
	// loadPlan fails below — leaving an empty file would make planExists()
	// report true while loadPlan() keeps returning null.
	const createdPlaceholder = !existsSync(path);
	if (createdPlaceholder) {
		// Touch an empty placeholder so proper-lockfile has something to
		// lock. Deleted on the failure path if the load doesn't succeed.
		writeFileSync(path, "", "utf8");
	}
	let release: () => Promise<void>;
	try {
		release = await lockAsync(path, {
			retries: LOCK_RETRIES,
			stale: LOCK_STALE_MS,
		});
	} catch (err) {
		if (createdPlaceholder && existsSync(path)) {
			try {
				unlinkSync(path);
			} catch {
				// Best effort — if we can't unlink, leak the empty file rather
				// than mask the original lock-acquisition error.
			}
		}
		throw err;
	}
	let loadedOk = false;
	try {
		const plan = loadPlan(slug);
		if (!plan) throw new PlanNotFoundError(slug);
		loadedOk = true;
		// Refuse to mutate a plan written by newer code — the save below
		// would silently strip fields this version doesn't know about.
		assertWritableVersion(plan);
		const out = await mutator(plan);
		if (
			out &&
			typeof out === "object" &&
			"save" in (out as object) &&
			(out as { save?: unknown }).save === false
		) {
			return (out as { result: T }).result;
		}
		writeFileSync(path, JSON.stringify(plan, null, 2), "utf8");
		rebuildIndex();
		return out as T;
	} finally {
		await release();
		if (!loadedOk && createdPlaceholder && existsSync(path)) {
			try {
				unlinkSync(path);
			} catch {
				// Best effort.
			}
		}
	}
}

/**
 * Optimistic concurrency check for read-modify-write paths that
 * can't hold the file lock for the full duration (e.g. ones that
 * span an LLM call). Compare the `updatedAt` you observed when you
 * read the plan against what's on disk now; throws `PlanStaleError`
 * if another writer raced you.
 *
 * Typical use:
 *
 *     const plan = loadPlan(slug);
 *     const stamp = plan.updatedAt;
 *     // ... long async work ...
 *     await withPlanLock(slug, (fresh) => {
 *       assertPlanUnchanged(fresh, stamp);
 *       // safe to mutate `fresh` based on the work above
 *     });
 */
export function assertPlanUnchanged(
	plan: Plan,
	expectedUpdatedAt: string,
): void {
	if (plan.updatedAt !== expectedUpdatedAt) {
		throw new PlanStaleError(plan.slug, expectedUpdatedAt, plan.updatedAt);
	}
}

/**
 * Persist a plan and refresh the index.
 *
 * Acquires a short-lived lockfile around the write so concurrent
 * writers from different processes don't tear the JSON. Caller is
 * responsible for setting `plan.updatedAt`.
 *
 * For read-modify-write — load, mutate, save — prefer
 * `withPlanLock(slug, mutator)`, which holds the lock for the entire
 * sequence. Calling `savePlan` from inside a `withPlanLock` mutator
 * deadlocks waiting on the lock that mutator already owns.
 */
export function savePlan(plan: Plan): void {
	assertWritableVersion(plan);
	ensurePlansRoot();
	const dir = planDir(plan.slug);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const path = planFile(plan.slug);
	// Lockfile sits next to plan.json. Touching the data file when
	// missing lets proper-lockfile open it for the duration of the
	// lock; first-time saves are common (new plans).
	if (!existsSync(path)) writeFileSync(path, "", "utf8");
	const release = lockSyncWithRetry(path);
	try {
		writeFileSync(path, JSON.stringify(plan, null, 2), "utf8");
	} finally {
		release();
	}
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
			// Migrate before inspecting — index rebuilds must understand
			// v1/v2 files that haven't been re-saved as v3 yet.
			const plan = migratePlan(JSON.parse(readFileSync(path, "utf8")) as Plan);
			// A plan is "active" (reusable for /plan in this repo) if it has
			// no deliverables yet OR at least one is still working. Otherwise
			// everything is shipped/abandoned and the plan is done.
			const flat = deliverables(plan);
			const active =
				flat.length === 0 ||
				flat.some((d) => !TERMINAL_STATUSES.includes(d.status));
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

/** Override the plans root for tests. */
export function _setPlansRootForTests(root: string): void {
	plansRoot = root;
}
