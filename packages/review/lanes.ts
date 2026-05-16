/**
 * Per-lane model configuration for /review.
 *
 * Each reviewer lane (architect, code-reviewer, …) and the indexer +
 * orchestrator can be independently configured to use a specific
 * `{set, tier}` from `backgroundModels`. The legacy "fan out across
 * primary AND secondary" path is replaced by a secondary-first single
 * pass; primary is reachable per-lane via override or via the
 * `consult_primary_model` tool when the orchestrator is uncertain.
 *
 * Resolution order for a given lane id:
 *   1. `extensionConfig.review.lanes.<id>` — explicit per-lane override.
 *   2. `extensionConfig.review.defaultLane` — repo-level default.
 *   3. Built-in defaults from `BUILTIN_LANE_DEFAULTS` (this module).
 *
 * Pure module: takes pre-read settings, returns resolved config. No
 * I/O, no model registry interaction. The model resolver itself
 * (which can fail) lives in `auto-review.ts` next to the call site.
 */

import type {
	BackgroundSet,
	RelevantSettings,
	Tier,
} from "@vegardx/pi-extensions-shared/extension-settings.js";

/**
 * Lane identifiers covered by per-lane configuration. Includes the
 * seven reviewer roles, the indexer that runs first, and the
 * orchestrator that synthesises findings at the end.
 */
export type LaneId =
	| "index"
	| "architect"
	| "code-reviewer"
	| "scope-analyst"
	| "security-analyst"
	| "code-simplifier"
	| "doc-reviewer"
	| "dependency-checker"
	| "orchestrator";

export interface LaneSpec {
	set: BackgroundSet;
	tier: Tier;
}

/**
 * Built-in defaults per lane. Reviewer fan-out + indexer default to
 * `secondary/normal` (cheap, fast, broad signal). Security analyst
 * upgrades to `secondary/heavy` because it's the lane most likely to
 * uncover non-obvious issues that benefit from deeper reasoning.
 * Orchestrator runs on `secondary/heavy` — synthesis is the most
 * cognitively demanding step.
 */
export const BUILTIN_LANE_DEFAULTS: Readonly<Record<LaneId, LaneSpec>> = {
	index: { set: "secondary", tier: "normal" },
	architect: { set: "secondary", tier: "normal" },
	"code-reviewer": { set: "secondary", tier: "normal" },
	"scope-analyst": { set: "secondary", tier: "normal" },
	"security-analyst": { set: "secondary", tier: "heavy" },
	"code-simplifier": { set: "secondary", tier: "normal" },
	"doc-reviewer": { set: "secondary", tier: "normal" },
	"dependency-checker": { set: "secondary", tier: "normal" },
	orchestrator: { set: "secondary", tier: "heavy" },
} as const;

const VALID_SETS: readonly BackgroundSet[] = ["primary", "secondary"];
const VALID_TIERS: readonly Tier[] = ["fast", "normal", "heavy"];

function isLaneSpec(raw: unknown): raw is LaneSpec {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const o = raw as Record<string, unknown>;
	return (
		typeof o.set === "string" &&
		(VALID_SETS as readonly string[]).includes(o.set) &&
		typeof o.tier === "string" &&
		(VALID_TIERS as readonly string[]).includes(o.tier)
	);
}

/**
 * Resolve a single lane's `{set, tier}` from settings, falling through
 * `lanes.<id>` → `defaultLane` → built-in default. Invalid entries at
 * any layer are skipped (fail-closed); they do not leak past
 * validation.
 */
export function resolveLaneSpec(
	settings: RelevantSettings,
	laneId: LaneId,
): LaneSpec {
	const reviewCfg = settings.extensionConfig?.review;
	if (reviewCfg && typeof reviewCfg === "object" && !Array.isArray(reviewCfg)) {
		const r = reviewCfg as Record<string, unknown>;
		const lanes = r.lanes;
		if (lanes && typeof lanes === "object" && !Array.isArray(lanes)) {
			const laneRaw = (lanes as Record<string, unknown>)[laneId];
			if (isLaneSpec(laneRaw)) return { set: laneRaw.set, tier: laneRaw.tier };
		}
		const defaultRaw = r.defaultLane;
		if (isLaneSpec(defaultRaw))
			return { set: defaultRaw.set, tier: defaultRaw.tier };
	}
	return BUILTIN_LANE_DEFAULTS[laneId];
}

/**
 * Resolve every lane in one pass. Returns a Record keyed by `LaneId`
 * with the fully-resolved `{set, tier}` per lane. Convenience for
 * call sites that want the whole table once.
 */
export function resolveAllLanes(
	settings: RelevantSettings,
): Record<LaneId, LaneSpec> {
	const out = {} as Record<LaneId, LaneSpec>;
	for (const id of Object.keys(BUILTIN_LANE_DEFAULTS) as LaneId[]) {
		out[id] = resolveLaneSpec(settings, id);
	}
	return out;
}
