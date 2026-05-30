/**
 * Resolve the effective editor configuration from settings + env.
 *
 * Pure module — takes pre-read settings, returns a fully-resolved
 * config. Environment fallback (`VISUAL` / `EDITOR`) is honoured
 * only when the user did not set `extensionConfig.editor.command`.
 */

import {
	getExtensionConfigBoolean,
	getExtensionConfigString,
	getExtensionConfigStringArray,
	type RelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";

export const EXT_ID = "editor";
export const DEFAULT_ARGS = ["{path}"] as const;
const COMMAND_ENV_VAR = "VISUAL";
const COMMAND_ENV_VAR_FALLBACK = "EDITOR";
const DEFAULT_COMMAND = "code";

export const EDITOR_PRESETS = [
	"auto",
	"code",
	"cursor",
	"windsurf",
	"intellij",
	"nvim",
	"sublime",
	"custom",
] as const;

export type EditorPreset = (typeof EDITOR_PRESETS)[number];

interface PresetConfig {
	command: string;
	args: readonly string[];
}

const PRESET_CONFIGS: Record<
	Exclude<EditorPreset, "auto" | "custom">,
	PresetConfig
> = {
	code: { command: "code", args: ["-g", "{path}:{line}:{col}"] },
	cursor: { command: "cursor", args: ["-g", "{path}:{line}:{col}"] },
	windsurf: { command: "windsurf", args: ["-g", "{path}:{line}:{col}"] },
	intellij: { command: "idea", args: ["--line", "{line}", "{path}"] },
	nvim: { command: "nvim", args: ["+{line}", "{path}"] },
	sublime: { command: "subl", args: ["{path}:{line}:{col}"] },
};

export interface EditorConfig {
	command: string;
	args: string[];
	detach: boolean;
}

export type EnvLookup = (name: string) => string | undefined;

const DEFAULT_ENV: EnvLookup = (name) => process.env[name];

/**
 * Wrap an `EnvLookup` so empty-string env values (e.g. `$VISUAL=""`)
 * fall through to the next layer instead of being treated as a real
 * configured value. Without this, an empty env var would spawn `""`
 * which surfaces as `not-found` rather than rolling forward to the
 * next env var or the `"code"` default.
 */
function envOrUndefined(env: EnvLookup, name: string): string | undefined {
	const raw = env(name);
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve `extensionConfig.editor.{command,args,detach}` with env
 * fallback. Order:
 *
 * 1. `extensionConfig.editor.command` from settings.json
 * 2. `$VISUAL` (POSIX convention for the user's preferred GUI editor)
 * 3. `$EDITOR` (POSIX convention for the user's preferred text editor)
 * 4. `"code"` (most-installed GUI editor; surfaces on PATH-miss
 *    notification if absent so the user knows what to set)
 *
 * `args` defaults to `["{path}"]` so even with no template, opening
 * a path Just Works against any sensible editor binary.
 *
 * `detach` defaults to true — closing pi must NEVER kill the editor.
 */
export function resolveEditorConfig(
	settings: RelevantSettings,
	env: EnvLookup = DEFAULT_ENV,
): EditorConfig {
	const explicitCommand = getExtensionConfigString(
		settings,
		EXT_ID,
		"command",
		"",
	).trim();
	const rawPreset = getExtensionConfigString(
		settings,
		EXT_ID,
		"preset",
		"auto",
	);
	const preset: EditorPreset = EDITOR_PRESETS.includes(
		rawPreset as EditorPreset,
	)
		? (rawPreset as EditorPreset)
		: "auto";
	const presetConfig =
		preset === "auto" || preset === "custom"
			? undefined
			: PRESET_CONFIGS[preset];
	const command =
		explicitCommand.length > 0
			? explicitCommand
			: (presetConfig?.command ??
				envOrUndefined(env, COMMAND_ENV_VAR) ??
				envOrUndefined(env, COMMAND_ENV_VAR_FALLBACK) ??
				DEFAULT_COMMAND);

	const args = getExtensionConfigStringArray(
		settings,
		EXT_ID,
		"args",
		presetConfig ? [...presetConfig.args] : [...DEFAULT_ARGS],
	);

	const detach = getExtensionConfigBoolean(settings, EXT_ID, "detach", true);

	return { command, args, detach };
}
