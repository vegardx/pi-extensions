/**
 * In-process registry that lets the extensions in this monorepo
 * self-declare their identity and configuration schema, so the
 * `pi-ext-startup` extension's `/extensions` command can render an
 * accurate "what's loaded, what's configurable, what's actually in
 * effect" report without hard-coding a list.
 *
 * ## Why a shared in-process registry
 *
 * pi has no public API for "list all loaded extensions" (only their
 * registered commands and tools), and extensions can't import each
 * other's modules. But every extension in this monorepo imports
 * `@vegardx/pi-extensions-shared`, so a module-level `Map` here is
 * shared across all of them via Node's module cache. By the time
 * `session_start` fires, every factory has already run and called
 * `declareExtension(...)`, so startup can iterate the registry and
 * trust it as the source of truth.
 *
 * NOTE: The registry is anchored on `globalThis` (key
 * `__pi_ext_metadata_registry__`) rather than a bare module-level `Map`
 * so it survives pi loading each extension with a separate jiti module
 * context. With per-extension contexts the module cache is not shared,
 * which means a plain `new Map()` would create a fresh instance per
 * extension and startup would never see other extensions' declarations.
 * `globalThis` has exactly one instance per process regardless of how
 * many times the module is evaluated.
 *
 * Skill-only packages (no factory, e.g. `pi-ext-gh`) cannot self-declare
 * and remain invisible to `/extensions`. Documented in startup's README.
 *
 * ## Shape
 *
 *     declareExtension({
 *       name: "verify",
 *       path: fileURLToPath(import.meta.url),
 *       doc: "Verify each step of a plan against the working tree.",
 *       configSchema: [
 *         {
 *           key: "model",
 *           type: "string",
 *           fallbackChain:
 *             "extensionConfig.verify.model → backgroundModels.secondary.normal → backgroundModels.primary.normal → ctx.model",
 *           doc: "Override the verifier model (provider/id).",
 *         },
 *         {
 *           key: "maxParallel",
 *           type: "number",
 *           default: 15,
 *           doc: "Max concurrent verifier subagents.",
 *         },
 *       ],
 *       backgroundModelUse: { tier: "normal", set: "secondary" },
 *     });
 *
 * Re-declaring with the same `name` overwrites the previous entry —
 * convenient when running tests that re-import a factory, and
 * tolerable in production because each extension declares itself
 * exactly once per process.
 */

import type {
	BackgroundSet,
	RelevantSettings,
	Tier,
} from "./extension-settings.js";

export type ConfigKeyType =
	| "string"
	| "string[]"
	| "number"
	| "boolean"
	| "enum";

/**
 * One configurable knob under `extensionConfig.<name>.<key>` in
 * `settings.json`.
 *
 * - `default` is the literal default value when the key has one
 *   (e.g. `15` for `verify.maxParallel`). Omit it for keys whose
 *   "default" is a fallback chain rather than a fixed value
 *   (typical for `model` keys); use `fallbackChain` to describe it.
 * - Both `default` and `fallbackChain` may be set; `default` wins for
 *   the literal value displayed, `fallbackChain` shows the resolution
 *   order for diagnostic purposes.
 */
export interface ConfigKeySchema {
	key: string;
	type: ConfigKeyType;
	enumValues?: readonly string[];
	default?: unknown;
	fallbackChain?: string;
	doc: string;
}

/**
 * Description of which background-model tier and set the extension
 * resolves through `@vegardx/pi-extensions-shared/model-resolver` when
 * doing side work (auto-title, ghost-text, subagent verification).
 *
 * `/extensions` uses this to surface "verify pulls
 * `backgroundModels.secondary.normal` — currently anthropic/foo".
 */
export interface BackgroundModelUseSpec {
	tier: Tier;
	set: BackgroundSet;
	/**
	 * Optional human-readable note shown next to the resolved value.
	 * Useful when the resolution does something non-obvious (e.g.
	 * legacy env-var override).
	 */
	explanation?: string;
}

/**
 * Why this extension's load state is what it is. Set by
 * `defineExtension` when it resolves the toggle; reused by
 * `/extensions` to render the per-extension state badge and by
 * `dependency-check` to skip extensions that already failed.
 */
export type ExtensionLoadState =
	| "loaded"
	| "disabled-by-config"
	| "disabled-by-env"
	| "disabled-by-missing-deps";

export type ExtensionEnabledSource = "project" | "global" | "env" | "default";

export interface ExtensionMetadata {
	/**
	 * Short, stable name. Used as the key under `extensionConfig.<name>`
	 * in settings.json and as the join key when correlating with pi's
	 * command/tool registry. Lowercase kebab-case by convention.
	 */
	name: string;
	/**
	 * Absolute path to the extension's entry file. Pass
	 * `fileURLToPath(import.meta.url)` from the factory's `index.ts` so
	 * the value lines up with `sourceInfo.path` on commands and tools.
	 */
	path: string;
	doc?: string;
	configSchema?: readonly ConfigKeySchema[];
	backgroundModelUse?: BackgroundModelUseSpec;
	/**
	 * Resolved enabled state for this session. `true` means the
	 * factory body ran. `false` means it was gated off and nothing was
	 * registered. `undefined` (legacy / unset) is treated as enabled
	 * by callers — defineExtension always sets this explicitly.
	 */
	enabled?: boolean;
	/** Where the enabled decision came from, for the /extensions UI. */
	enabledSource?: ExtensionEnabledSource;
	/**
	 * Coarse load-state. Drives the badge and disabled footer in
	 * `/extensions` and the session-start summary notify.
	 */
	loadState?: ExtensionLoadState;
	/**
	 * Hard dependencies — listed extension names that must also be
	 * loaded for this one to function. If any are missing or disabled,
	 * `defineExtension` refuses to load this extension.
	 */
	dependsOn?: readonly string[];
	/**
	 * Soft integrations — listed extensions are leveraged when present
	 * but optional. Missing ones produce an info-level notify on
	 * session start; this extension still loads.
	 */
	integratesWith?: readonly string[];
}

// Use a globalThis-anchored Map so the registry is shared even when pi
// loads each extension with a separate jiti module context (separate module
// caches → separate Map instances if stored at module level).
const REGISTRY_KEY = "__pi_ext_metadata_registry__";
if (!(globalThis as Record<string, unknown>)[REGISTRY_KEY]) {
	(globalThis as Record<string, unknown>)[REGISTRY_KEY] = new Map<
		string,
		ExtensionMetadata
	>();
}
const registry = (globalThis as Record<string, unknown>)[REGISTRY_KEY] as Map<
	string,
	ExtensionMetadata
>;

/**
 * Register an extension's metadata. Re-declaring the same `name`
 * overwrites the previous entry (last write wins). Returns the stored
 * record so callers can chain or inspect.
 */
export function declareExtension(meta: ExtensionMetadata): ExtensionMetadata {
	const stored: ExtensionMetadata = {
		name: meta.name,
		path: meta.path,
		doc: meta.doc,
		configSchema: meta.configSchema
			? [...meta.configSchema].sort((a, b) => a.key.localeCompare(b.key))
			: undefined,
		backgroundModelUse: meta.backgroundModelUse,
		enabled: meta.enabled,
		enabledSource: meta.enabledSource,
		loadState: meta.loadState,
		dependsOn: meta.dependsOn ? [...meta.dependsOn] : undefined,
		integratesWith: meta.integratesWith ? [...meta.integratesWith] : undefined,
	};
	registry.set(meta.name, stored);
	return stored;
}

/**
 * Test/internal: mutate the loadState (and optionally enabled) of an
 * already-declared extension. Used by `dependency-check` to flip an
 * extension to `"disabled-by-missing-deps"` after the post-load
 * resolution check, without re-declaring the whole record.
 */
export function updateExtensionLoadState(
	name: string,
	loadState: ExtensionLoadState,
	enabled?: boolean,
): void {
	const existing = registry.get(name);
	if (!existing) return;
	existing.loadState = loadState;
	if (enabled !== undefined) existing.enabled = enabled;
}

/**
 * Snapshot of every declared extension, sorted by name for stable
 * rendering. The returned array is a fresh copy; mutating it does not
 * affect the registry.
 */
export function getDeclaredExtensions(): ExtensionMetadata[] {
	return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up a single declaration by name, or `undefined` if nothing has
 * registered under that name.
 */
export function getDeclaredExtension(
	name: string,
): ExtensionMetadata | undefined {
	return registry.get(name);
}

/**
 * Test-only: drop every declaration. Lets vitest cases start from a
 * clean slate without bleed-through across files.
 */
export function clearDeclaredExtensions(): void {
	registry.clear();
}

// ---------------------------------------------------------------------------
// Effective-value resolution
// ---------------------------------------------------------------------------

export type EffectiveValueSource = "default" | "global" | "project";

export interface EffectiveValue {
	/**
	 * The resolved value, or `undefined` if the schema has no `default`
	 * and nothing is configured in either layer.
	 */
	value: unknown;
	/**
	 * Where `value` came from. `"default"` covers both "schema default"
	 * and "schema has no default and nothing configured" — distinguish
	 * via `isOverride` if you only care about user-supplied values.
	 */
	source: EffectiveValueSource;
	/**
	 * True when the value was supplied by the user (project or global
	 * settings.json), false when it came from the schema default or is
	 * unset entirely. Used for the "M overrides" headline count.
	 */
	isOverride: boolean;
}

interface LayeredInput {
	global: RelevantSettings;
	project: RelevantSettings;
}

function readKeyFromLayer(
	layer: RelevantSettings,
	extName: string,
	key: string,
): unknown {
	const ec = layer.extensionConfig?.[extName] as
		| Record<string, unknown>
		| undefined;
	if (!ec) return undefined;
	// Support dot-notation for nested keys (e.g. "review.enable" →
	// extensionConfig.modes.review.enable). Single-segment keys take the
	// fast path via Object.hasOwn so there is no behavioural change for
	// the common flat case.
	if (!key.includes(".")) {
		return Object.hasOwn(ec, key) ? ec[key] : undefined;
	}
	const parts = key.split(".");
	let current: unknown = ec;
	for (const part of parts) {
		if (
			typeof current !== "object" ||
			current === null ||
			!Object.hasOwn(current as Record<string, unknown>, part)
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Resolve one configurable key against the global+project layers.
 * Project wins over global (matches `readRelevantSettings` precedence);
 * if neither layer sets it, the schema default is returned.
 *
 * The schema is required so the helper can attribute "no value"
 * correctly: if the schema declares no default and no layer sets the
 * key, `value` is `undefined` and `source` is `"default"`.
 */
export function resolveEffectiveValue(input: {
	extName: string;
	key: string;
	schema: ConfigKeySchema;
	layered: LayeredInput;
}): EffectiveValue {
	const { extName, key, schema, layered } = input;
	const projectVal = readKeyFromLayer(layered.project, extName, key);
	if (projectVal !== undefined) {
		return { value: projectVal, source: "project", isOverride: true };
	}
	const globalVal = readKeyFromLayer(layered.global, extName, key);
	if (globalVal !== undefined) {
		return { value: globalVal, source: "global", isOverride: true };
	}
	return { value: schema.default, source: "default", isOverride: false };
}
