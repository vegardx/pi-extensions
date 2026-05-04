/**
 * Finding types + dedupe logic for /review. Pure — no pi, no subprocess, no
 * I/O. Tests live in `__tests__/findings.test.ts`.
 */

export type Severity = "CRITICAL" | "IMPORTANT" | "NOTE";

export type ReviewerRole =
	| "architect"
	| "code-reviewer"
	| "scope-analyst"
	| "security-analyst"
	| "code-simplifier"
	| "doc-reviewer"
	| "dependency-checker";

/**
 * Shape each reviewer emits (as JSON). Kept permissive: `line` is optional
 * (some findings are about a file as a whole), `suggestedAction` is optional
 * for pure NOTE observations.
 */
export interface RawFinding {
	severity: Severity;
	file: string;
	line?: number;
	title: string;
	description: string;
	suggestedAction?: string;
}

/** Finding after dedupe — notes which reviewer(s) raised it. */
export interface Finding extends RawFinding {
	flaggedBy: ReviewerRole[];
	/** True if at least two reviewers raised the same issue. */
	consensus: boolean;
}

/**
 * Parse a reviewer's stdout into a list of RawFindings. Accepts either:
 *   - A bare JSON array: `[{...}, {...}]`
 *   - JSON wrapped in a ```json fence (the reviewer ignored the "no fence"
 *     rule, but we recover)
 *   - An object with a top-level `findings` array
 *
 * Returns an empty array for anything that parses to "no findings" and
 * `null` for output that is not recoverable as JSON — callers can then
 * surface a reviewer-failed warning.
 */
export function parseReviewerOutput(raw: string): RawFinding[] | null {
	if (!raw || raw.trim().length === 0) return [];
	// Strip a leading code fence if present.
	const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	const payload = (fence ? fence[1] : raw).trim();
	if (payload.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	const arr: unknown = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" &&
				parsed !== null &&
				Array.isArray((parsed as { findings?: unknown }).findings)
			? (parsed as { findings: unknown[] }).findings
			: null;
	if (!Array.isArray(arr)) return null;

	const out: RawFinding[] = [];
	for (const item of arr) {
		const normalized = normalizeFinding(item);
		if (normalized) out.push(normalized);
	}
	return out;
}

function normalizeFinding(raw: unknown): RawFinding | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const severity = normalizeSeverity(obj.severity);
	const file = typeof obj.file === "string" ? obj.file : null;
	const title = typeof obj.title === "string" ? obj.title : null;
	const description =
		typeof obj.description === "string" ? obj.description : "";
	if (!severity || !file || !title) return null;
	const line =
		typeof obj.line === "number" && Number.isFinite(obj.line)
			? Math.floor(obj.line)
			: undefined;
	const suggestedAction =
		typeof obj.suggestedAction === "string" &&
		obj.suggestedAction.trim().length > 0
			? obj.suggestedAction
			: undefined;
	return { severity, file, line, title, description, suggestedAction };
}

function normalizeSeverity(raw: unknown): Severity | null {
	if (typeof raw !== "string") return null;
	const s = raw.trim().toUpperCase();
	if (s === "CRITICAL" || s === "IMPORTANT" || s === "NOTE") return s;
	// Map a few common synonyms so we don't lose findings on wording drift.
	if (s === "HIGH" || s === "SEVERE" || s === "BLOCKER") return "CRITICAL";
	if (s === "MEDIUM" || s === "MAJOR" || s === "WARN" || s === "WARNING") {
		return "IMPORTANT";
	}
	if (s === "LOW" || s === "INFO" || s === "MINOR" || s === "SUGGESTION") {
		return "NOTE";
	}
	return null;
}

const SEVERITY_RANK: Record<Severity, number> = {
	CRITICAL: 0,
	IMPORTANT: 1,
	NOTE: 2,
};

/**
 * Merge raw findings from every reviewer into a deduped, severity-sorted
 * list. Dedupe key is `${file}:${line ?? "0"}:${title.lower()}` — when two
 * reviewers flag the same issue with the same title, we collapse them.
 *
 * Severity promotion: when one reviewer rates an issue CRITICAL and another
 * NOTE, the merged finding takes the highest severity. Consensus (2+
 * reviewers on the same dedupe key) is tracked separately for the report.
 */
export function dedupeFindings(
	bundles: ReadonlyArray<{
		role: ReviewerRole;
		findings: readonly RawFinding[];
	}>,
): Finding[] {
	const merged = new Map<string, Finding>();
	for (const { role, findings } of bundles) {
		for (const f of findings) {
			const key = `${f.file}:${f.line ?? 0}:${f.title.toLowerCase().trim()}`;
			const existing = merged.get(key);
			if (!existing) {
				merged.set(key, { ...f, flaggedBy: [role], consensus: false });
				continue;
			}
			if (!existing.flaggedBy.includes(role)) existing.flaggedBy.push(role);
			existing.consensus = existing.flaggedBy.length >= 2;
			// Promote severity to the highest seen. Prefer the more specific
			// description if the incoming one is longer; same for suggestedAction.
			if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
				existing.severity = f.severity;
			}
			if (f.description.length > existing.description.length) {
				existing.description = f.description;
			}
			if (
				f.suggestedAction &&
				(!existing.suggestedAction ||
					f.suggestedAction.length > existing.suggestedAction.length)
			) {
				existing.suggestedAction = f.suggestedAction;
			}
		}
	}
	return [...merged.values()].sort((a, b) => {
		const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
		if (bySeverity !== 0) return bySeverity;
		// Within a severity, list consensus findings first — they're higher
		// confidence.
		if (a.consensus !== b.consensus) return a.consensus ? -1 : 1;
		if (a.file !== b.file) return a.file < b.file ? -1 : 1;
		return (a.line ?? 0) - (b.line ?? 0);
	});
}

export interface SeverityCounts {
	CRITICAL: number;
	IMPORTANT: number;
	NOTE: number;
}

export function countBySeverity(findings: readonly Finding[]): SeverityCounts {
	const counts: SeverityCounts = { CRITICAL: 0, IMPORTANT: 0, NOTE: 0 };
	for (const f of findings) counts[f.severity]++;
	return counts;
}

// ---- Confidence-based recommendation ------------------------------------

/**
 * Options the walk-through can nudge the user toward. `null` means no
 * nudge — the user sees Accept / Skip / Explain equally.
 */
export type RecommendedAction = "accept" | "explain";

export interface Recommendation {
	action: RecommendedAction;
	/** Human-readable bullets explaining why we're confident. */
	reasons: string[];
}

/**
 * Decide whether the walk-through should mark one option as
 * “(Recommended)”. Only returns a non-null value when we have *high*
 * confidence in the finding itself — we deliberately never recommend Skip,
 * because being confidently wrong about dismissing a real issue is worse
 * than leaving the user neutral.
 *
 * High-confidence signals (either triggers the recommendation):
 *   - Severity is CRITICAL — high stakes, worth being opinionated.
 *   - Consensus — 2+ reviewers independently flagged the same thing.
 *
 * Which action to recommend once we're high-confidence:
 *   - If the finding has a concrete `suggestedAction` → recommend Accept.
 *     We trust the fix.
 *   - If not → recommend Explain. We believe it's real but need context
 *     before committing to a fix.
 *
 * Everything else — single-reviewer IMPORTANT/NOTE findings, or any
 * low-signal case — returns null.
 */
export function recommendationFor(finding: Finding): Recommendation | null {
	const reasons: string[] = [];
	if (finding.severity === "CRITICAL") {
		reasons.push("CRITICAL severity");
	}
	if (finding.consensus) {
		reasons.push(`${finding.flaggedBy.length} reviewers agree`);
	}
	if (reasons.length === 0) return null;

	const hasFix = Boolean(finding.suggestedAction?.trim());
	if (hasFix) {
		return {
			action: "accept",
			reasons: [...reasons, "concrete fix available"],
		};
	}
	return {
		action: "explain",
		reasons: [...reasons, "no concrete fix yet"],
	};
}
