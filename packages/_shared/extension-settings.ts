import { SettingsManager } from "@mariozechner/pi-coding-agent";

/**
 * Shared settings reader for the extensions in this monorepo.
 *
 * We defer the *where* (global path, project path, env-var overrides,
 * any future XDG / config-dir changes) to pi's `SettingsManager`, and
 * keep the *how* (picking our keys out, merging project over global)
 * local. That way pi remains the authority on config layout and any
 * future change there — e.g. honoring `$XDG_CONFIG_HOME` or renaming
 * the agent dir — lands here for free.
 *
 * pi's `Settings` type is closed (it doesn't declare
 * `backgroundModels` or `extensionConfig`), but the underlying JSON
 * is parsed untyped and unknown keys survive intact. We cast to
 * `Record<string, unknown>` at the boundary and validate shapes
 * ourselves.
 *
 * Shape we care about:
 *
 *     {
 *       "backgroundModels": {
 *         "primary":   { "fast": "provider/id", "normal": "provider/id", "heavy": "provider/id" },
 *         "secondary": { "fast": "provider/id", "normal": "provider/id", "heavy": "provider/id" }
 *       },
 *       "extensionConfig": {
 *         "<extension-name>": { "model": "provider/id" }
 *       }
 *     }
 *
 * The `primary` and `secondary` sets are peers, not fallbacks. Most
 * extensions read from `primary`; `verify` reads from `secondary` so
 * users can configure two model families and use one to cross-check
 * the other. If a tier isn't set under the requested set, the
 * resolver falls back to the same tier under `primary` so users
 * who configure only `primary` still get sensible behavior.
 *
 * Anything else in settings.json is pi's business and is ignored here.
 */

export type Tier = "fast" | "normal" | "heavy";

export type BackgroundSet = "primary" | "secondary";

export interface BackgroundModelsTiers {
	fast?: string;
	normal?: string;
	heavy?: string;
}

export interface BackgroundModels {
	primary?: BackgroundModelsTiers;
	secondary?: BackgroundModelsTiers;
}

export interface ExtensionConfig {
	model?: string;
}

export interface RelevantSettings {
	backgroundModels?: BackgroundModels;
	extensionConfig?: Record<string, ExtensionConfig | undefined>;
}

/**
 * Validate and pick a tier object out of an unknown value.
 */
function extractTiers(raw: unknown): BackgroundModelsTiers | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const pick: BackgroundModelsTiers = {};
	if (typeof obj.fast === "string") pick.fast = obj.fast;
	if (typeof obj.normal === "string") pick.normal = obj.normal;
	if (typeof obj.heavy === "string") pick.heavy = obj.heavy;
	return pick.fast || pick.normal || pick.heavy ? pick : undefined;
}

/**
 * Pull out only the keys we care about. Everything else in pi's
 * settings.json is ignored. This lets us tolerate pi schema changes
 * without surfacing them here.
 */
function extractRelevant(raw: unknown): RelevantSettings {
	if (!raw || typeof raw !== "object") return {};
	const obj = raw as Record<string, unknown>;
	const out: RelevantSettings = {};

	if (obj.backgroundModels && typeof obj.backgroundModels === "object") {
		const bg = obj.backgroundModels as Record<string, unknown>;
		const primary = extractTiers(bg.primary);
		const secondary = extractTiers(bg.secondary);
		if (primary || secondary) {
			out.backgroundModels = {};
			if (primary) out.backgroundModels.primary = primary;
			if (secondary) out.backgroundModels.secondary = secondary;
		}
	}

	if (obj.extensionConfig && typeof obj.extensionConfig === "object") {
		const ec = obj.extensionConfig as Record<string, unknown>;
		const pick: Record<string, ExtensionConfig | undefined> = {};
		for (const [name, value] of Object.entries(ec)) {
			if (value && typeof value === "object") {
				const v = value as Record<string, unknown>;
				if (typeof v.model === "string") pick[name] = { model: v.model };
			}
		}
		if (Object.keys(pick).length > 0) out.extensionConfig = pick;
	}

	return out;
}

/**
 * Read and merge global + project settings, returning only the keys
 * this monorepo's extensions care about. Project values override
 * global values at the leaf level (per-tier, per-extension), matching
 * pi's documented precedence.
 *
 * `cwd` is passed to pi's SettingsManager which derives the project
 * settings path from it. `agentDir` is an optional override; without
 * it pi uses its own resolution (honoring `PI_CODING_AGENT_DIR`,
 * falling back to `~/.pi/agent/`).
 */
export function readRelevantSettings(
	cwd: string,
	agentDir?: string,
): RelevantSettings {
	const manager = SettingsManager.create(cwd, agentDir);
	const global = extractRelevant(manager.getGlobalSettings());
	const project = extractRelevant(manager.getProjectSettings());

	const merged: RelevantSettings = {};

	if (global.backgroundModels || project.backgroundModels) {
		merged.backgroundModels = {};
		if (global.backgroundModels?.primary || project.backgroundModels?.primary) {
			merged.backgroundModels.primary = {
				...global.backgroundModels?.primary,
				...project.backgroundModels?.primary,
			};
		}
		if (
			global.backgroundModels?.secondary ||
			project.backgroundModels?.secondary
		) {
			merged.backgroundModels.secondary = {
				...global.backgroundModels?.secondary,
				...project.backgroundModels?.secondary,
			};
		}
	}

	if (global.extensionConfig || project.extensionConfig) {
		merged.extensionConfig = {};
		const names = new Set([
			...Object.keys(global.extensionConfig ?? {}),
			...Object.keys(project.extensionConfig ?? {}),
		]);
		for (const name of names) {
			merged.extensionConfig[name] = {
				...global.extensionConfig?.[name],
				...project.extensionConfig?.[name],
			};
		}
	}

	return merged;
}

/**
 * Get the model override for a specific extension (if any).
 * Format is `"provider/id"` when set.
 */
export function getExtensionModelOverride(
	settings: RelevantSettings,
	extensionName: string,
): string | undefined {
	return settings.extensionConfig?.[extensionName]?.model;
}

/**
 * Get the configured model for a background tier under the requested
 * set. If the tier isn't set under `secondary`, falls back to the same
 * tier under `primary` — the resolver's "secondary uses primary as a
 * sensible default" rule. Format is `"provider/id"` when set.
 */
export function getTierModel(
	settings: RelevantSettings,
	tier: Tier,
	set: BackgroundSet = "primary",
): string | undefined {
	const direct = settings.backgroundModels?.[set]?.[tier];
	if (direct) return direct;
	if (set === "secondary") {
		return settings.backgroundModels?.primary?.[tier];
	}
	return undefined;
}
