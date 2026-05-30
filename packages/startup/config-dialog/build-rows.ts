/**
 * Build the row snapshot the `/extensions` dialog renders from.
 *
 * Joins three sources:
 *
 *   1. The in-process metadata registry (`getDeclaredExtensions()`),
 *      which holds the resolved `enabled` / `enabledSource` /
 *      `loadState` for the current session plus dep declarations.
 *   2. The raw `extensionConfig.<name>.enabled` values from the
 *      project and global settings.json files. We intentionally read
 *      the raw files (not pi's typed `SettingsManager`, which doesn't
 *      surface `extensionConfig` setters and would round-trip values
 *      through a typed schema that drops unknown keys).
 *   3. The cycle-time effective decision recorded on each metadata
 *      entry — this is what's actually live this session, regardless
 *      of what the dialog later writes to disk.
 */

import type { ExtensionMetadata } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	readBackgroundModel,
	readExtensionConfigKey,
} from "@vegardx/pi-extensions-shared/settings-writer.js";

import type {
	EffectiveSource,
	ExtensionRow,
	ScopedValue,
} from "./extensions-state.js";
import {
	buildKnobRows,
	type KnobRow,
	type KnobSchema,
	type ScopedValue as KnobValue,
} from "./knobs-state.js";
import { buildModelRows, type ModelRow } from "./models-state.js";

/**
 * Coerce a raw JSON value to a tri-state. Anything that isn't a
 * literal boolean is treated as `null` (unset) — typo-tolerant in the
 * same direction as `getExtensionConfigBoolean`.
 */
function coerceScopedValue(raw: unknown): ScopedValue {
	if (raw === true) return true;
	if (raw === false) return false;
	return null;
}

export interface BuildRowsOptions {
	cwd: string;
	agentDir?: string;
	declared: readonly ExtensionMetadata[];
}

/**
 * Build the row list. Sorted alphabetically by name so the dialog
 * order is stable across sessions.
 */
export function buildRows(opts: BuildRowsOptions): ExtensionRow[] {
	const sorted = [...opts.declared].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	return sorted.map((meta) => buildRow(meta, opts.cwd, opts.agentDir));
}

function buildRow(
	meta: ExtensionMetadata,
	cwd: string,
	agentDir: string | undefined,
): ExtensionRow {
	const project = coerceScopedValue(
		readExtensionConfigKey("project", cwd, meta.name, "enabled"),
	);
	const global = coerceScopedValue(
		readExtensionConfigKey("global", cwd, meta.name, "enabled", agentDir),
	);
	return {
		name: meta.name,
		doc: meta.doc,
		dependsOn: meta.dependsOn ?? [],
		integratesWith: meta.integratesWith ?? [],
		project,
		global,
		effective: meta.enabled === true,
		effectiveSource: (meta.enabledSource ?? "default") as EffectiveSource,
	};
}

/**
 * Read the six background-model tiers from disk for both scopes.
 *
 * Mirrors `buildRows`: reads the raw project (`<cwd>/.pi/settings.json`)
 * and global (`<agentDir>/settings.json`) files and attributes each
 * literal `"provider/id"` value to its scope. No merge, no
 * secondary→primary fallback — that's the Models page's job to display.
 */
export function readModelRows(opts: {
	cwd: string;
	agentDir?: string;
}): ModelRow[] {
	return buildModelRows((set, tier, scope) => {
		const value = readBackgroundModel(
			scope,
			opts.cwd,
			set,
			tier,
			opts.agentDir,
		);
		return value ?? null;
	});
}

/**
 * Coerce a raw settings value to a knob `ScopedValue`. Missing/null →
 * `null` (unset); primitives and string arrays pass through; anything
 * else (a malformed shape) is treated as unset.
 */
function coerceKnobValue(raw: unknown): KnobValue {
	if (raw === undefined || raw === null) return null;
	if (
		typeof raw === "string" ||
		typeof raw === "number" ||
		typeof raw === "boolean"
	) {
		return raw;
	}
	if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) {
		return raw as string[];
	}
	return null;
}

/**
 * Build the knob rows for the Settings page: every declared extension's
 * `configSchema` knobs, joined against the raw project + global values.
 * Extensions are sorted by name; within each, `declareExtension` already
 * sorted keys. Extensions with no schema contribute no rows.
 */
export function readKnobRows(opts: BuildRowsOptions): KnobRow[] {
	const schemas: KnobSchema[] = [];
	const sorted = [...opts.declared].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	for (const meta of sorted) {
		for (const k of meta.configSchema ?? []) {
			schemas.push({
				extName: meta.name,
				key: k.key,
				type: k.type,
				enumValues: k.enumValues,
				default: k.default,
				doc: k.doc,
			});
		}
	}
	return buildKnobRows(schemas, (extName, key, scope) =>
		coerceKnobValue(
			readExtensionConfigKey(scope, opts.cwd, extName, key, opts.agentDir),
		),
	);
}
