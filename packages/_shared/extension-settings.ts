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
	/**
	 * Per-extension knobs beyond `model`. Validated only at the boundary
	 * (the value must be an object); individual keys are not type-checked
	 * here — each extension casts to its own shape via `declareExtension`
	 * and a schema-aware reader.
	 */
	[key: string]: unknown;
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
			if (value && typeof value === "object" && !Array.isArray(value)) {
				// Preserve all keys under each extension entry verbatim. The
				// `model` field is special-cased only by the resolver — every
				// other key is consumed by the owning extension via its own
				// schema. We still narrow `model` to a string to match its
				// declared type.
				const src = value as Record<string, unknown>;
				const entry: ExtensionConfig = { ...src };
				if (typeof src.model === "string") {
					entry.model = src.model;
				} else {
					delete entry.model;
				}
				pick[name] = entry;
			}
		}
		if (Object.keys(pick).length > 0) out.extensionConfig = pick;
	}

	return out;
}

/**
 * Layered view of merged settings: the same data `readRelevantSettings`
 * returns, plus the un-merged `global` and `project` slices so callers
 * can attribute each effective value back to its source layer.
 *
 * `merged` is computed exactly the way `readRelevantSettings` does it
 * (project overrides global at the leaf level), so existing call sites
 * keep working unchanged.
 */
export interface LayeredRelevantSettings {
	global: RelevantSettings;
	project: RelevantSettings;
	merged: RelevantSettings;
}

/**
 * Read global and project settings separately, plus the merged view.
 * Used by `/extensions` (in `pi-ext-startup`) to label each effective
 * value as coming from `global`, `project`, or the extension's default.
 *
 * Project values override global values at the leaf level (per-tier,
 * per-extension), matching pi's documented precedence.
 */
export function readRelevantSettingsLayered(
	cwd: string,
	agentDir?: string,
): LayeredRelevantSettings {
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

	return { global, project, merged };
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
	return readRelevantSettingsLayered(cwd, agentDir).merged;
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
 * Look up a (possibly dotted) key under `extensionConfig.<name>`.
 * A flat key reads the top-level field; a dotted key (e.g.
 * `review.enable`) walks the nested object structure that extensions
 * actually store. Mirrors `readKeyFromLayer` in `extension-metadata.ts`
 * and bails to `undefined` the moment a segment is missing.
 */
function readConfigKey(
	settings: RelevantSettings,
	extensionName: string,
	key: string,
): unknown {
	const entry = settings.extensionConfig?.[extensionName] as
		| Record<string, unknown>
		| undefined;
	if (!entry) return undefined;
	if (!key.includes(".")) {
		return Object.hasOwn(entry, key) ? entry[key] : undefined;
	}
	let current: unknown = entry;
	for (const part of key.split(".")) {
		if (
			typeof current !== "object" ||
			current === null ||
			Array.isArray(current) ||
			!Object.hasOwn(current as Record<string, unknown>, part)
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Get a typed boolean flag under `extensionConfig.<name>.<key>`. Used
 * by extensions that expose simple opt-out / feature toggles in
 * `settings.json` without wanting to write their own settings reader.
 *
 * `key` may be a dot-separated path (e.g. `review.enable`).
 *
 * `defaultValue` is returned both when the key is unset and when the
 * value is not a JSON boolean — we deliberately do NOT coerce strings
 * like `"true"` so a typo in settings.json fails closed (back to the
 * extension's default) instead of silently flipping behavior.
 */
export function getExtensionConfigBoolean(
	settings: RelevantSettings,
	extensionName: string,
	key: string,
	defaultValue: boolean,
): boolean {
	const raw = readConfigKey(settings, extensionName, key);
	return typeof raw === "boolean" ? raw : defaultValue;
}

/**
 * Get a typed string-array value under `extensionConfig.<name>.<key>`.
 * Accepts a JSON array of strings; returns `defaultValue` when the key
 * is unset, not an array, or contains any non-string element. Falls
 * closed on partial matches so typos in settings.json don't silently
 * drop individual entries. `key` may be a dot-separated path.
 */
export function getExtensionConfigStringArray(
	settings: RelevantSettings,
	extensionName: string,
	key: string,
	defaultValue: string[],
): string[] {
	const raw = readConfigKey(settings, extensionName, key);
	if (!Array.isArray(raw)) return defaultValue;
	if (raw.some((v) => typeof v !== "string")) return defaultValue;
	return raw as string[];
}

/**
 * Get a typed string value under `extensionConfig.<name>.<key>`. Returns
 * `defaultValue` both when the key is unset and when the value is not a
 * string — we deliberately do NOT coerce non-strings so a typo in
 * settings.json fails closed (back to the extension's default). `key`
 * may be a dot-separated path.
 */
export function getExtensionConfigString(
	settings: RelevantSettings,
	extensionName: string,
	key: string,
	defaultValue: string,
): string {
	const raw = readConfigKey(settings, extensionName, key);
	return typeof raw === "string" ? raw : defaultValue;
}

/**
 * Get a typed number value under `extensionConfig.<name>.<key>`. Returns
 * `defaultValue` when the key is unset or the value is not a finite JSON
 * number — NaN/Infinity and non-numbers all fail closed back to the
 * default. `key` may be a dot-separated path (e.g. `compaction.phaseTokens`).
 */
export function getExtensionConfigNumber(
	settings: RelevantSettings,
	extensionName: string,
	key: string,
	defaultValue: number,
): number {
	const raw = readConfigKey(settings, extensionName, key);
	return typeof raw === "number" && Number.isFinite(raw) ? raw : defaultValue;
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
