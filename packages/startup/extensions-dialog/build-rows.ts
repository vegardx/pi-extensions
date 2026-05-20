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
import { readExtensionConfigKey } from "@vegardx/pi-extensions-shared/settings-writer.js";

import type { EffectiveSource, ExtensionRow, ScopedValue } from "./state.js";

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
