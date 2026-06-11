/**
 * Finding types + dedupe logic for /review. Pure — no pi, no subprocess, no
 * I/O. Tests live in `__tests__/findings.test.ts`.
 */
import { candidateJsonPayloads } from "@vegardx/pi-extensions-shared/json-extraction.js";

export type Severity = "CRITICAL" | "IMPORTANT" | "NOTE";

/**
 * The four review lenses. `generic` sweeps structure, scope, docs and
 * dependencies in one pass; the other three are deep lenses. Defined
 * here (the pure findings module) so finding types don't reach into
 * settings-aware modules; `models.ts` re-exports it alongside the
 * model-resolution table.
 */
export type LensId = "generic" | "code-review" | "security" | "simplification";

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
	flaggedBy: LensId[];
	/** True if at least two reviewers raised the same issue. */
	consensus: boolean;
	/**
	 * Which background-model tiers contributed this finding. Populated
	 * only when the caller passes tier-tagged bundles to
	 * `dedupeFindings` (currently the auto-review pass in `modes` —
	 * primary.heavy + secondary.heavy). Empty / unset when tiers are
	 * irrelevant (the standard interactive `/review` fan-out).
	 */
	flaggedByTier?: BackgroundTier[];
	/**
	 * True iff this finding was flagged by at least one reviewer in
	 * BOTH the primary and secondary tier. Set only when tier-tagged
	 * bundles are provided. The auto-review pass uses this as the
	 * gate for auto-applying a fix without user confirmation.
	 */
	crossModelConsensus?: boolean;
	/**
	 * True iff this finding reached cross-model consensus via the
	 * challenge phase (the non-detecting tier was explicitly asked and
	 * agreed), rather than both tiers independently flagging it.
	 * Only meaningful when `crossModelConsensus` is true.
	 */
	challengedConsensus?: boolean;
}

/**
 * Background-model tier label used to attribute tier-tagged review
 * bundles. Mirrors the `BackgroundSet` type from
 * `_shared/extension-settings.ts` but kept local so this pure module
 * doesn't pull in pi types just for an enum literal.
 */
export type BackgroundTier = "primary" | "secondary";

// ---- Orchestrator output types -----------------------------------------

export type OrchestratorConfidence = "high" | "medium" | "low";

/**
 * A finding as emitted by the orchestrator agent. The orchestrator
 * synthesises raw findings from all role-agents × all model tiers,
 * deduplicates, cross-validates, and assigns a confidence level.
 *
 * Downstream split:
 *   - "high" + suggestedAction  → auto-apply
 *   - "high" / "medium"         → surface for discussion
 *   - "low" + CRITICAL          → surface with caveat (never dropped)
 *   - "low" + IMPORTANT/NOTE    → drop
 */
export interface OrchestratedFinding extends RawFinding {
	confidence: OrchestratorConfidence;
	/** Model tiers that contributed to this finding. */
	confirmedByTiers: BackgroundTier[];
	/** Reviewer roles that contributed to this finding. */
	confirmedByRoles: LensId[];
	/** Non-null when the finding originated from a static analysis tool. */
	staticToolSource: string | null;
	/** Set when confidence is low or investigation found something notable. */
	orchestratorNote?: string;
}

/** Parse the JSON array emitted by the orchestrator agent. */
export function parseOrchestratorOutput(
	raw: string,
): OrchestratedFinding[] | null {
	if (!raw || raw.trim().length === 0) return [];
	for (const candidate of candidateJsonPayloads(raw)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;
		const out: OrchestratedFinding[] = [];
		for (const item of parsed) {
			const f = normalizeOrchestratedFinding(item);
			if (f) out.push(f);
		}
		return out;
	}
	return null;
}

function normalizeOrchestratedFinding(
	raw: unknown,
): OrchestratedFinding | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const base = normalizeFinding(obj);
	if (!base) return null;
	const confidence = normalizeConfidence(obj.confidence);
	const confirmedByTiers = _asStringArray(obj.confirmedByTiers).filter(
		(t): t is BackgroundTier => t === "primary" || t === "secondary",
	);
	const confirmedByRoles = _asStringArray(obj.confirmedByRoles) as LensId[];
	const staticToolSource =
		typeof obj.staticToolSource === "string" && obj.staticToolSource
			? obj.staticToolSource
			: null;
	// The curator prompt emits `curatorNote`; the older orchestrator
	// prompt emitted `orchestratorNote`. Accept both.
	const noteRaw = obj.curatorNote ?? obj.orchestratorNote;
	const orchestratorNote =
		typeof noteRaw === "string" && noteRaw ? noteRaw : undefined;
	return {
		...base,
		confidence,
		confirmedByTiers,
		confirmedByRoles,
		staticToolSource,
		...(orchestratorNote ? { orchestratorNote } : {}),
	};
}

function normalizeConfidence(raw: unknown): OrchestratorConfidence {
	if (raw === "high" || raw === "medium" || raw === "low") return raw;
	// Default to medium — don't silently drop uncertain findings.
	return "medium";
}

function _asStringArray(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((v): v is string => typeof v === "string");
}

export function parseReviewerOutput(raw: string): RawFinding[] | null {
	if (!raw || raw.trim().length === 0) return [];
	for (const candidate of candidateJsonPayloads(raw)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		const arr: unknown = Array.isArray(parsed)
			? parsed
			: typeof parsed === "object" &&
					parsed !== null &&
					Array.isArray((parsed as { findings?: unknown }).findings)
				? (parsed as { findings: unknown[] }).findings
				: null;
		if (!Array.isArray(arr)) continue;
		const out: RawFinding[] = [];
		for (const item of arr) {
			const normalized = normalizeFinding(item);
			if (normalized) out.push(normalized);
		}
		return out;
	}
	return null;
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
 * Bundle of raw findings from one reviewer run. The optional `tier`
 * field is set by tier-tagged callers (the auto-review pass in
 * `modes`); standard `/review` callers omit it. When set, dedupe
 * tracks tier provenance and computes `crossModelConsensus` per
 * merged finding.
 */
export interface FindingsBundle {
	role: LensId;
	findings: readonly RawFinding[];
	tier?: BackgroundTier;
}

/**
 * Merge raw findings from every reviewer into a deduped, severity-sorted
 * list. Dedupe key is `${file}:${line ?? "0"}:${title.lower()}` — when two
 * reviewers flag the same issue with the same title, we collapse them.
 *
 * Severity promotion: when one reviewer rates an issue CRITICAL and another
 * NOTE, the merged finding takes the highest severity. Consensus (2+
 * reviewers on the same dedupe key) is tracked separately for the report.
 *
 * When bundles carry a `tier`, the merged finding additionally records
 * `flaggedByTier` and `crossModelConsensus`. `crossModelConsensus` is
 * `true` iff the finding was flagged by at least one reviewer in BOTH
 * the `primary` and `secondary` tiers — the gate the auto-review pass
 * in `modes` uses to decide whether to apply a fix without user
 * confirmation. Bundles without `tier` leave both fields unset.
 */
export function dedupeFindings(
	bundles: ReadonlyArray<FindingsBundle>,
): Finding[] {
	const merged = new Map<string, Finding>();
	for (const { role, findings, tier } of bundles) {
		for (const f of findings) {
			const key = `${f.file}:${f.line ?? 0}:${f.title.toLowerCase().trim()}`;
			const existing = merged.get(key);
			if (!existing) {
				const seed: Finding = {
					...f,
					flaggedBy: [role],
					consensus: false,
				};
				if (tier) {
					seed.flaggedByTier = [tier];
					seed.crossModelConsensus = false;
				}
				merged.set(key, seed);
				continue;
			}
			if (!existing.flaggedBy.includes(role)) existing.flaggedBy.push(role);
			existing.consensus = existing.flaggedBy.length >= 2;
			if (tier) {
				if (!existing.flaggedByTier) existing.flaggedByTier = [];
				if (!existing.flaggedByTier.includes(tier)) {
					existing.flaggedByTier.push(tier);
				}
				existing.crossModelConsensus =
					existing.flaggedByTier.includes("primary") &&
					existing.flaggedByTier.includes("secondary");
			}
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

/**
 * Filter a deduped finding list down to those flagged by both the
 * primary and secondary tier — the cross-model consensus the auto-
 * review pass in `modes` requires before auto-applying a fix.
 * Findings without tier metadata are excluded (caller didn't pass
 * tier-tagged bundles, so cross-model consensus is undefined).
 */
export function crossModelConsensus(findings: readonly Finding[]): Finding[] {
	return findings.filter((f) => f.crossModelConsensus === true);
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
