/**
 * Raw-JSON writer for `extensionConfig.<name>.<key>` in either the
 * project (`<cwd>/.pi/settings.json`) or the global
 * (`<agentDir>/settings.json`) settings file.
 *
 * pi's `SettingsManager` doesn't expose setters for `extensionConfig`,
 * so we read the file as raw JSON, modify the key in place, and write
 * it back. This mirrors `setEnabledInProjectSettings` in
 * `packages/caffeinate/index.ts` but generalised to two scopes and
 * any key.
 *
 * Concurrency: `writeFileSync` is not atomic if the process dies
 * mid-write. We accept that — settings.json is a user-editable file,
 * the worst case is a corrupt JSON the user has to fix by hand, and
 * pi itself uses `FileSettingsStorage.withLock` (which we can't reach
 * from here) for its own writes. Callers that need atomicity should
 * serialise their own calls.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export type SettingsScope = "project" | "global";

/**
 * Resolves the path to the settings.json for a given scope.
 *
 * `agentDir` is optional and defaults to pi's resolution (honouring
 * `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent/`). Tests pass
 * an explicit override.
 */
export function settingsPath(
	scope: SettingsScope,
	cwd: string,
	agentDir?: string,
): string {
	if (scope === "project") return join(cwd, ".pi", "settings.json");
	return join(agentDir ?? getAgentDir(), "settings.json");
}

/**
 * Read a value from a plain object following a dot-separated path. Bails
 * to `undefined` the moment a segment is missing or non-traversable (a
 * primitive or array stands in for an object). Used for both the flat
 * (`enabled`) and nested (`review.enable`) key forms.
 */
function readPath(obj: Record<string, unknown>, parts: string[]): unknown {
	let current: unknown = obj;
	for (const part of parts) {
		if (
			!current ||
			typeof current !== "object" ||
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
 * Reject path segments (and extension names) that would let a crafted
 * key walk into `Object.prototype` — `__proto__`, `prototype`,
 * `constructor` — or an empty segment. The writers below mutate the
 * object graph by indexing these segments, so a value like
 * `__proto__.polluted` (or an extension named `__proto__`) must be
 * refused before any mutation. Read paths are already safe (they gate on
 * `Object.hasOwn`).
 */
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeSegments(segments: readonly string[]): void {
	for (const segment of segments) {
		if (segment.length === 0) {
			throw new Error("settings-writer: empty key segment");
		}
		if (UNSAFE_SEGMENTS.has(segment)) {
			throw new Error(
				`settings-writer: refusing to write prototype-polluting key segment "${segment}"`,
			);
		}
	}
}

/**
 * Set a value at a dot-separated path under `root`, creating (or
 * replacing non-object) intermediate containers as needed. Returns the
 * previous leaf value (or `undefined`).
 */
function setPath(
	root: Record<string, unknown>,
	parts: string[],
	value: unknown,
): unknown {
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const next = current[part];
		if (!next || typeof next !== "object" || Array.isArray(next)) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	const leaf = parts[parts.length - 1];
	const previous = current[leaf];
	current[leaf] = value;
	return previous;
}

/**
 * Delete the value at a dot-separated path under `root`, then prune any
 * intermediate objects that became empty as a result (so clearing the
 * last nested knob leaves no `{ review: {} }` husk behind). Returns the
 * previous leaf value (or `undefined` when the path was already absent).
 */
function deletePath(root: Record<string, unknown>, parts: string[]): unknown {
	const chain: Array<{ obj: Record<string, unknown>; key: string }> = [];
	let current = root;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		const next = current[part];
		if (!next || typeof next !== "object" || Array.isArray(next)) {
			return undefined;
		}
		chain.push({ obj: current, key: part });
		current = next as Record<string, unknown>;
	}
	const leaf = parts[parts.length - 1];
	const previous = current[leaf];
	delete current[leaf];
	// Walk back up pruning emptied containers.
	for (let i = chain.length - 1; i >= 0; i--) {
		const { obj, key } = chain[i];
		if (Object.keys(obj[key] as Record<string, unknown>).length > 0) break;
		delete obj[key];
	}
	return previous;
}

/**
 * Reads `<settings>.extensionConfig.<extensionName>.<key>`.
 *
 * `key` may be a dot-separated path (e.g. `review.enable`) to read a
 * nested value; a flat key reads the top-level field as before.
 *
 * Returns `undefined` when the file is missing or any of the parent
 * objects are missing. Returns the raw value otherwise (without type
 * coercion — caller decides what's acceptable).
 */
export function readExtensionConfigKey(
	scope: SettingsScope,
	cwd: string,
	extensionName: string,
	key: string,
	agentDir?: string,
): unknown {
	const path = settingsPath(scope, cwd, agentDir);
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const ec = (raw as Record<string, unknown>).extensionConfig;
	if (!ec || typeof ec !== "object" || Array.isArray(ec)) return undefined;
	const entry = (ec as Record<string, unknown>)[extensionName];
	if (!entry || typeof entry !== "object" || Array.isArray(entry))
		return undefined;
	return readPath(entry as Record<string, unknown>, key.split("."));
}

export interface WriteResult {
	path: string;
	previous: unknown;
}

/**
 * Writes `<settings>.extensionConfig.<extensionName>.<key> = value` to
 * the settings.json for `scope`. `key` may be a dot-separated path
 * (e.g. `review.enable`), in which case the nested object structure is
 * created as needed — this matches the shape extensions actually read
 * (`extensionConfig.modes.review.enable`), not a literal `"review.enable"`
 * property.
 *
 * `value` accepts `string[]` for array knobs; an empty array `[]` is a
 * meaningful "explicitly empty" value and is stored as-is (distinct from
 * `null`, which deletes). When `value` is `null`, the key is deleted and
 * any nested objects emptied by the delete are pruned; if the resulting
 * per-extension entry becomes empty it's removed too (so resetting the
 * only key on an extension leaves the file clean).
 *
 * Creates the file (and parent dir) if missing. Preserves all other
 * keys verbatim — we never round-trip through `SettingsManager`,
 * which would re-emit only the typed subset of fields it knows about
 * and silently drop the rest.
 */
export function writeExtensionConfigKey(
	scope: SettingsScope,
	cwd: string,
	extensionName: string,
	key: string,
	value: boolean | string | number | string[] | null,
	agentDir?: string,
): WriteResult {
	const path = settingsPath(scope, cwd, agentDir);
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const extensionConfig =
		raw.extensionConfig &&
		typeof raw.extensionConfig === "object" &&
		!Array.isArray(raw.extensionConfig)
			? (raw.extensionConfig as Record<string, unknown>)
			: {};
	const entry =
		extensionConfig[extensionName] &&
		typeof extensionConfig[extensionName] === "object" &&
		!Array.isArray(extensionConfig[extensionName])
			? (extensionConfig[extensionName] as Record<string, unknown>)
			: {};

	const parts = key.split(".");
	// Reject prototype-polluting / empty segments before any mutation.
	assertSafeSegments([extensionName, ...parts]);
	let previous: unknown;

	if (value === null) {
		previous = deletePath(entry, parts);
		if (Object.keys(entry).length === 0) {
			delete extensionConfig[extensionName];
		} else {
			extensionConfig[extensionName] = entry;
		}
	} else {
		previous = setPath(entry, parts, value);
		extensionConfig[extensionName] = entry;
	}

	if (Object.keys(extensionConfig).length === 0) {
		delete raw.extensionConfig;
	} else {
		raw.extensionConfig = extensionConfig;
	}

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
	return { path, previous };
}

// ---------------------------------------------------------------------------
// Background-model tiers (top-level `backgroundModels.<set>.<tier>`)
// ---------------------------------------------------------------------------

/**
 * Background-model set/tier. Mirrors the labels the resolver and the
 * `/config` Models page use. Kept as plain string unions here (rather
 * than importing from `extension-settings`) so the writer has no
 * dependency on the reader.
 */
export type BackgroundModelSet = "primary" | "secondary";
export type BackgroundModelTier = "fast" | "normal" | "heavy";

/**
 * Reads `<settings>.backgroundModels.<set>.<tier>`.
 *
 * Returns `undefined` when the file is missing, any parent object is
 * absent, or the value isn't a string. No secondary→primary fallback —
 * this reports the literal value stored at the requested scope, which
 * is what the `/config` Models page needs to attribute overrides to a
 * layer.
 */
export function readBackgroundModel(
	scope: SettingsScope,
	cwd: string,
	set: BackgroundModelSet,
	tier: BackgroundModelTier,
	agentDir?: string,
): string | undefined {
	const path = settingsPath(scope, cwd, agentDir);
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const bg = (raw as Record<string, unknown>).backgroundModels;
	if (!bg || typeof bg !== "object" || Array.isArray(bg)) return undefined;
	const setObj = (bg as Record<string, unknown>)[set];
	if (!setObj || typeof setObj !== "object" || Array.isArray(setObj))
		return undefined;
	const value = (setObj as Record<string, unknown>)[tier];
	return typeof value === "string" ? value : undefined;
}

/**
 * Writes `<settings>.backgroundModels.<set>.<tier> = value` to the
 * settings.json for `scope`. When `value` is `null` the tier is
 * deleted; emptied `<set>` objects and an emptied `backgroundModels`
 * object are pruned so clearing the last override leaves no dangling
 * structure.
 *
 * Like `writeExtensionConfigKey`, this round-trips the raw JSON and
 * preserves every other key verbatim — `SettingsManager` doesn't expose
 * setters for `backgroundModels`.
 */
export function writeBackgroundModel(
	scope: SettingsScope,
	cwd: string,
	set: BackgroundModelSet,
	tier: BackgroundModelTier,
	value: string | null,
	agentDir?: string,
): WriteResult {
	const path = settingsPath(scope, cwd, agentDir);
	let raw: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const backgroundModels =
		raw.backgroundModels &&
		typeof raw.backgroundModels === "object" &&
		!Array.isArray(raw.backgroundModels)
			? (raw.backgroundModels as Record<string, unknown>)
			: {};
	const setObj =
		backgroundModels[set] &&
		typeof backgroundModels[set] === "object" &&
		!Array.isArray(backgroundModels[set])
			? (backgroundModels[set] as Record<string, unknown>)
			: {};

	const previous = setObj[tier];

	if (value === null) {
		delete setObj[tier];
		if (Object.keys(setObj).length === 0) {
			delete backgroundModels[set];
		} else {
			backgroundModels[set] = setObj;
		}
	} else {
		setObj[tier] = value;
		backgroundModels[set] = setObj;
	}

	if (Object.keys(backgroundModels).length === 0) {
		delete raw.backgroundModels;
	} else {
		raw.backgroundModels = backgroundModels;
	}

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
	return { path, previous };
}
