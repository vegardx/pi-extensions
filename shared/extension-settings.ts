import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared settings reader for the extensions in this monorepo.
 *
 * pi exposes `getSettingsPath()` but does not give extensions a
 * pre-parsed view of user settings with project overrides applied. For
 * our own keys (`backgroundModels`, `extensionConfig`) we read the
 * files directly and merge them here — cheap, runs once per
 * session_start, no caching needed.
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

function globalSettingsPath(): string {
	// Matches pi's layout: `~/.pi/agent/settings.json`. `PI_AGENT_DIR`
	// and `HOME` overrides match pi's own behavior (see pi's config.ts).
	const base = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(base, "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

function readJsonOrNull(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Missing file, unreadable file, or invalid JSON — treat as absent.
		// We never want a malformed settings.json to crash an extension.
		return null;
	}
}

/**
 * Pull out only the keys we care about. Everything else in pi's
 * settings.json is ignored. This lets us tolerate future pi schema
 * changes without surfacing them here.
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
 */
export function readRelevantSettings(cwd: string): RelevantSettings {
	const global = extractRelevant(readJsonOrNull(globalSettingsPath()));
	const project = extractRelevant(readJsonOrNull(projectSettingsPath(cwd)));

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
