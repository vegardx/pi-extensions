/**
 * Pure rendering for `/plan list`.
 *
 * The handler in index.ts loads each plan from disk, hands them here
 * with the current session id + cwd, and `notify`s the result. Keeping
 * the formatter here means the layout is unit testable without booting
 * the extension closure.
 *
 * Output structure:
 *
 *   plans:
 *
 *   This session:
 *     ● <slug> — <title>  (this repo) · 2h ago
 *     ⊘ <slug> — <title>  stuck — open a PR or /plan archive
 *
 *   Other sessions:
 *     ● <slug> — <title>  by abc12345 (work) · 3d ago
 *
 *   Legacy (no owner):
 *     ○ <slug> — <title>  3w ago
 *
 * Empty groups are omitted entirely.
 */

import { deliverables, isPlanStuck, type Plan } from "./schema.js";

export interface PlanListInput {
	plans: Plan[];
	currentSessionId: string;
	currentCwd: string;
	/** Reference time for "X ago" formatting. Defaults to Date.now(). */
	now?: number;
}

/** Markers describe ownership independent of activity status. */
type Bucket = "this-session" | "other-session" | "legacy";

const BUCKET_HEADINGS: Record<Bucket, string> = {
	"this-session": "This session:",
	"other-session": "Other sessions:",
	legacy: "Legacy (no owner):",
};

const BUCKET_ORDER: readonly Bucket[] = [
	"this-session",
	"other-session",
	"legacy",
] as const;

function classify(plan: Plan, currentSessionId: string): Bucket {
	if (!plan.createdBy) return "legacy";
	if (
		plan.createdBy.sessionId === currentSessionId ||
		plan.seenIn?.includes(currentSessionId)
	) {
		return "this-session";
	}
	return "other-session";
}

/**
 * Compact "X ago" formatter. Returns "just now" under a minute,
 * "Nm/h/d/w ago" otherwise. We don't need months/years here — `/plan
 * list` is for navigating recent work; older plans should be archived.
 */
export function formatRelativeTime(thenIso: string, now: number): string {
	const then = Date.parse(thenIso);
	if (!Number.isFinite(then)) return "?";
	const delta = Math.max(0, now - then);
	const sec = Math.floor(delta / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d ago`;
	const week = Math.floor(day / 7);
	return `${week}w ago`;
}

/**
 * "<short-uuid> (<name>)" or just "<short-uuid>" when no display name
 * was captured. Truncates the session id to 8 chars — enough to
 * disambiguate for human eyes without dumping a full UUID into the
 * footer.
 */
function ownerLabel(plan: Plan): string {
	const owner = plan.createdBy;
	if (!owner) return "(no owner)";
	const short = owner.sessionId.slice(0, 8);
	const name = owner.sessionName?.trim();
	return name ? `${short} (${name})` : short;
}

function activityGlyph(plan: Plan): string {
	if (isPlanStuck(plan)) return "⊘";
	const flat = deliverables(plan);
	const anyActive = flat.some(
		(p) => p.status !== "shipped" && p.status !== "abandoned",
	);
	return anyActive || flat.length === 0 ? "●" : "○";
}

function renderPlanLine(
	plan: Plan,
	bucket: Bucket,
	currentCwd: string,
	now: number,
): string {
	const glyph = activityGlyph(plan);
	const here = plan.repo.path === currentCwd ? " (this repo)" : "";
	const stuck = isPlanStuck(plan) ? "  stuck — open a PR or /plan archive" : "";
	const owner = bucket === "other-session" ? `  by ${ownerLabel(plan)}` : "";
	const age = ` · ${formatRelativeTime(plan.updatedAt, now)}`;
	return `  ${glyph} ${plan.slug} — ${plan.title}${here}${owner}${age}${stuck}`;
}

/**
 * Render the full multi-line view. Caller `notify`s the joined string.
 */
export function renderPlanListView(input: PlanListInput): string[] {
	const { plans, currentSessionId, currentCwd } = input;
	const now = input.now ?? Date.now();

	if (plans.length === 0) return ["no plans yet"];

	const buckets: Record<Bucket, Plan[]> = {
		"this-session": [],
		"other-session": [],
		legacy: [],
	};
	for (const plan of plans)
		buckets[classify(plan, currentSessionId)].push(plan);

	// Newest first within each bucket.
	for (const list of Object.values(buckets)) {
		list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	}

	const lines: string[] = ["plans:"];
	let firstSection = true;
	for (const bucket of BUCKET_ORDER) {
		const list = buckets[bucket];
		if (list.length === 0) continue;
		if (firstSection) {
			lines.push("");
			firstSection = false;
		} else {
			lines.push("");
		}
		lines.push(BUCKET_HEADINGS[bucket]);
		for (const plan of list) {
			lines.push(renderPlanLine(plan, bucket, currentCwd, now));
		}
	}
	return lines;
}
