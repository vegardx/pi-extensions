/**
 * Per-agent model configuration for the review pipeline.
 *
 * Agents are the four review lenses plus the indexer (pre-pass) and
 * the curator (synthesis). Each can be independently configured to a
 * `{set, tier}` from `backgroundModels`.
 *
 * Resolution order for a given agent id:
 *   1. `extensionConfig.review.models.<id>` — explicit per-agent override.
 *   2. `extensionConfig.review.defaultModel` — repo-level default.
 *   3. Built-in defaults from `BUILTIN_MODEL_DEFAULTS` (this module).
 *
 * Pure module: takes pre-read settings, returns resolved config. The
 * model resolver itself (which can fail) lives next to the call site
 * in `run-reviewer.ts`.
 */

import type {
	BackgroundSet,
	RelevantSettings,
	Tier,
} from "@vegardx/pi-extensions-shared/extension-settings.js";

import type { LensId } from "./findings.js";

export type { LensId };

export const ALL_LENSES: readonly LensId[] = [
	"generic",
	"code-review",
	"security",
	"simplification",
] as const;

const LENS_SET = new Set<string>(ALL_LENSES);

export function isLensId(raw: string): raw is LensId {
	return LENS_SET.has(raw);
}

/** Agents covered by per-agent model configuration. */
export type ReviewAgentId = LensId | "indexer" | "curator" | "consult";

export interface AgentModelSpec {
	set: BackgroundSet;
	tier: Tier;
}

/**
 * Built-in defaults per agent. Lenses + indexer default to
 * `secondary/normal` (cheap, fast, broad signal). The security lens
 * upgrades to `secondary/heavy` because it's the lens most likely to
 * uncover non-obvious issues that benefit from deeper reasoning. The
 * curator runs on `secondary/heavy` — synthesis is the most
 * cognitively demanding step.
 */
export const BUILTIN_MODEL_DEFAULTS: Readonly<
	Record<ReviewAgentId, AgentModelSpec>
> = {
	generic: { set: "secondary", tier: "normal" },
	"code-review": { set: "secondary", tier: "normal" },
	security: { set: "secondary", tier: "heavy" },
	simplification: { set: "secondary", tier: "normal" },
	indexer: { set: "secondary", tier: "normal" },
	curator: { set: "secondary", tier: "heavy" },
	// Second-opinion surface for contested findings; the opposite set
	// from the curator's default so the opinion comes from a different
	// model family.
	consult: { set: "primary", tier: "heavy" },
} as const;

const VALID_SETS: readonly BackgroundSet[] = ["primary", "secondary"];
const VALID_TIERS: readonly Tier[] = ["fast", "normal", "heavy"];

function isAgentModelSpec(raw: unknown): raw is AgentModelSpec {
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
 * Resolve a single agent's `{set, tier}` from settings, falling
 * through `models.<id>` → `defaultModel` → built-in default. Invalid
 * entries at any layer are skipped (fail-closed); they do not leak
 * past validation.
 */
export function resolveAgentModelSpec(
	settings: RelevantSettings,
	agentId: ReviewAgentId,
): AgentModelSpec {
	const reviewCfg = settings.extensionConfig?.review;
	if (reviewCfg && typeof reviewCfg === "object" && !Array.isArray(reviewCfg)) {
		const r = reviewCfg as Record<string, unknown>;
		const models = r.models;
		if (models && typeof models === "object" && !Array.isArray(models)) {
			const raw = (models as Record<string, unknown>)[agentId];
			if (isAgentModelSpec(raw)) return { set: raw.set, tier: raw.tier };
		}
		const defaultRaw = r.defaultModel;
		if (isAgentModelSpec(defaultRaw)) {
			return { set: defaultRaw.set, tier: defaultRaw.tier };
		}
	}
	return BUILTIN_MODEL_DEFAULTS[agentId];
}

/**
 * Resolve every agent in one pass. Convenience for call sites that
 * want the whole table once.
 */
export function resolveAllAgentModels(
	settings: RelevantSettings,
): Record<ReviewAgentId, AgentModelSpec> {
	const out = {} as Record<ReviewAgentId, AgentModelSpec>;
	for (const id of Object.keys(BUILTIN_MODEL_DEFAULTS) as ReviewAgentId[]) {
		out[id] = resolveAgentModelSpec(settings, id);
	}
	return out;
}

// ---- Per-lens multi-model / multi-pass specs ----------------------------

/**
 * Fan-out shape for one lens. `models` run in parallel within a pass;
 * `passes` run sequentially, each later pass receiving a digest of the
 * prior findings with a "find DIFFERENT issues" instruction.
 *
 * Built-in default is a single model, single pass for every lens —
 * multi-model/multi-pass is opt-in via settings until the token cost
 * has been measured on real diffs:
 *
 * ```json
 * { "extensionConfig": { "review": { "models": {
 *     "security": { "models": [
 *         { "set": "secondary", "tier": "heavy" },
 *         { "set": "primary", "tier": "heavy" }
 *       ], "passes": 2 }
 * } } } }
 * ```
 *
 * A bare `{set, tier}` entry normalises to `{models: [spec], passes: 1}`.
 */
export interface LensSpec {
	models: AgentModelSpec[];
	passes: number;
}

function isAgentModelSpecLoose(raw: unknown): raw is AgentModelSpec {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
	const o = raw as Record<string, unknown>;
	return (
		(o.set === "primary" || o.set === "secondary") &&
		(o.tier === "fast" || o.tier === "normal" || o.tier === "heavy")
	);
}

/**
 * Resolve a lens's full fan-out spec. `review.models.<lens>` may be a
 * bare `{set, tier}` (single model, single pass) or a
 * `{models: [...], passes}` object; anything invalid falls through to
 * the single-model default from {@link resolveAgentModelSpec}.
 */
export function resolveLensSpec(
	settings: RelevantSettings,
	lens: LensId,
): LensSpec {
	const reviewCfg = settings.extensionConfig?.review;
	if (reviewCfg && typeof reviewCfg === "object" && !Array.isArray(reviewCfg)) {
		const models = (reviewCfg as Record<string, unknown>).models;
		if (models && typeof models === "object" && !Array.isArray(models)) {
			const raw = (models as Record<string, unknown>)[lens];
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				const o = raw as Record<string, unknown>;
				if (Array.isArray(o.models)) {
					const specs = o.models.filter(isAgentModelSpecLoose);
					if (specs.length > 0) {
						const passesRaw = o.passes;
						const passes =
							typeof passesRaw === "number" &&
							Number.isFinite(passesRaw) &&
							passesRaw >= 1
								? Math.floor(passesRaw)
								: 1;
						return { models: specs, passes };
					}
				}
			}
		}
	}
	return { models: [resolveAgentModelSpec(settings, lens)], passes: 1 };
}

/** Read `review.consult.enabled` (default false). */
export function consultEnabled(settings: RelevantSettings): boolean {
	const reviewCfg = settings.extensionConfig?.review;
	if (!reviewCfg || typeof reviewCfg !== "object") return false;
	const consult = (reviewCfg as Record<string, unknown>).consult;
	if (!consult || typeof consult !== "object") return false;
	return (consult as Record<string, unknown>).enabled === true;
}
