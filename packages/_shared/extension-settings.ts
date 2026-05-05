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
 *         "fast":   "provider/id",
 *         "normal": "provider/id",
 *         "heavy":  "provider/id"
 *       },
 *       "extensionConfig": {
 *         "<extension-name>": { "model": "provider/id" }
 *       }
 *     }
 *
 * Anything else in settings.json is pi's business and is ignored here.
 */

export type Tier = "fast" | "normal" | "heavy";

export interface BackgroundModels {
	fast?: string;
	normal?: string;
	heavy?: string;
}

export interface ExtensionConfig {
	model?: string;
}

export interface RelevantSettings {
	backgroundModels?: BackgroundModels;
	extensionConfig?: Record<string, ExtensionConfig | undefined>;
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
		const pick: BackgroundModels = {};
		if (typeof bg.fast === "string") pick.fast = bg.fast;
		if (typeof bg.normal === "string") pick.normal = bg.normal;
		if (typeof bg.heavy === "string") pick.heavy = bg.heavy;
		if (pick.fast || pick.normal || pick.heavy) out.backgroundModels = pick;
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
		merged.backgroundModels = {
			...global.backgroundModels,
			...project.backgroundModels,
		};
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
 * Get the configured model for a background tier (if any).
 * Format is `"provider/id"` when set.
 */
export function getTierModel(
	settings: RelevantSettings,
	tier: Tier,
): string | undefined {
	return settings.backgroundModels?.[tier];
}
