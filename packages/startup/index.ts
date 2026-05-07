import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	SlashCommandInfo,
	ToolInfo,
} from "@mariozechner/pi-coding-agent";
import {
	type BackgroundModelUseSpec,
	type ConfigKeySchema,
	declareExtension,
	type EffectiveValue,
	type ExtensionMetadata,
	getDeclaredExtensions,
	resolveEffectiveValue,
} from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	getExtensionConfigBoolean,
	type LayeredRelevantSettings,
	type RelevantSettings,
	readRelevantSettings,
	readRelevantSettingsLayered,
} from "@vegardx/pi-extensions-shared/extension-settings.js";

const EXT_ID = "startup";

// ---------------------------------------------------------------------------
// Context-file discovery
// ---------------------------------------------------------------------------

const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * One AGENTS.md / CLAUDE.md file discovered on disk.
 */
export interface ContextFileInfo {
	/** Absolute filesystem path. */
	path: string;
	/** Path with home directory replaced by ~ for display. */
	displayPath: string;
	/** How specific this file is relative to the session cwd. */
	scope: "global" | "parent" | "project";
	/** Rough token estimate: ceil(charCount / 4). */
	tokens: number;
	/** Number of newline-delimited lines in the file. */
	lines: number;
}

/**
 * Discover all context files that pi would load for the given cwd, in the
 * order they appear in the assembled context:
 *
 *   1. Global: `<globalDir>/AGENTS.md` (or `CLAUDE.md`)
 *   2. Every directory from the filesystem root down to `cwd`, one file per
 *      directory (`AGENTS.md` checked before `CLAUDE.md`).
 *
 * This mirrors pi's own discovery without relying on `before_agent_start` so
 * that results are available at `session_start` time.
 *
 * `options.globalDir` defaults to `~/.pi/agent` and can be overridden in
 * tests to avoid depending on the real home directory.
 */
export function discoverContextFiles(
	cwd: string,
	options?: { globalDir?: string },
): ContextFileInfo[] {
	const home = homedir();
	const globalDir = options?.globalDir ?? join(home, ".pi", "agent");
	const results: ContextFileInfo[] = [];

	function toDisplayPath(absPath: string): string {
		const prefix = home + sep;
		return absPath.startsWith(prefix)
			? `~${absPath.slice(home.length)}`
			: absPath;
	}

	function tryAdd(dir: string, scope: ContextFileInfo["scope"]): void {
		for (const name of CONTEXT_FILE_NAMES) {
			const absPath = join(dir, name);
			if (!existsSync(absPath)) continue;
			try {
				const content = readFileSync(absPath, "utf8");
				results.push({
					path: absPath,
					displayPath: toDisplayPath(absPath),
					scope,
					tokens: Math.ceil(content.length / 4),
					lines: content.split("\n").length,
				});
			} catch {
				// Unreadable file — skip silently.
			}
			return; // at most one file per directory
		}
	}

	// 1. Global
	tryAdd(globalDir, "global");

	// 2. Every ancestor from filesystem root down to cwd (inclusive).
	//    Walk up from cwd collecting ancestors, then reverse to get root→cwd.
	const ancestors: string[] = [];
	let dir = cwd;
	while (true) {
		ancestors.push(dir);
		const parent = dirname(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}
	ancestors.reverse();

	for (const ancestor of ancestors) {
		if (ancestor === globalDir) continue; // already handled above
		const scope: ContextFileInfo["scope"] =
			ancestor === cwd ? "project" : "parent";
		tryAdd(ancestor, scope);
	}

	return results;
}

/**
 * One loaded extension as we can observe it from the public API: a single
 * `sourceInfo.path` plus the commands and tools it registered.
 *
 * pi doesn't expose "every loaded extension" to other extensions — only
 * the registered commands and tools. The metadata registry in
 * `@vegardx/pi-extensions-shared/extension-metadata` covers the rest;
 * this struct is still useful for picking up *third-party* extensions
 * that didn't self-declare (rendered under "unrecognized extensions").
 */
export interface LoadedExtension {
	path: string;
	source: string;
	scope: string;
	origin: string;
	commands: string[];
	tools: string[];
}

/**
 * One key under `extensionConfig.<name>` with its declared schema and
 * the resolved effective value. The "default" rendering uses the
 * literal default when set, otherwise the fallback chain.
 */
export interface ConfigKeyView {
	schema: ConfigKeySchema;
	effective: EffectiveValue;
}

/**
 * One declared extension joined against the command/tool registry
 * and the effective config values.
 */
export interface DeclaredExtensionView {
	meta: ExtensionMetadata;
	commands: string[];
	tools: string[];
	configKeys: ConfigKeyView[];
	backgroundModel?: {
		spec: BackgroundModelUseSpec;
		/**
		 * Resolved tier value from `backgroundModels.<set>.<tier>` (or
		 * the documented `secondary → primary` fallback). `undefined`
		 * means the tier isn't configured anywhere; the extension's
		 * resolver will fall back to `ctx.model` at call time.
		 */
		resolvedTierValue?: string;
		/** Where the tier value came from. */
		source: "project" | "global" | "default";
	};
}

export interface StartupSummary {
	declared: DeclaredExtensionView[];
	unrecognized: LoadedExtension[];
	layered: LayeredRelevantSettings;
	activeModel?: string;
	/** Context files discovered on disk for this session's cwd. */
	contextFiles?: ContextFileInfo[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Group `pi.getCommands()` and `pi.getAllTools()` by their `sourceInfo.path`.
 *
 * - Builtin tools (`sourceInfo.source === "builtin"`) and SDK-injected tools
 *   (`"sdk"`) are filtered out — they're not extensions and would just be
 *   noise.
 * - Prompt-template and skill commands (`source !== "extension"`) are also
 *   filtered out for the same reason.
 * - Output is sorted by path for stable rendering across runs.
 */
export function groupBySource(
	commands: readonly SlashCommandInfo[],
	tools: readonly ToolInfo[],
): LoadedExtension[] {
	const byPath = new Map<string, LoadedExtension>();

	const ensure = (info: {
		path: string;
		source: string;
		scope: string;
		origin: string;
	}): LoadedExtension => {
		const existing = byPath.get(info.path);
		if (existing) return existing;
		const created: LoadedExtension = {
			path: info.path,
			source: info.source,
			scope: info.scope,
			origin: info.origin,
			commands: [],
			tools: [],
		};
		byPath.set(info.path, created);
		return created;
	};

	for (const cmd of commands) {
		if (cmd.source !== "extension") continue;
		const ext = ensure(cmd.sourceInfo);
		ext.commands.push(cmd.name);
	}

	for (const tool of tools) {
		if (tool.sourceInfo.source === "builtin") continue;
		if (tool.sourceInfo.source === "sdk") continue;
		const ext = ensure(tool.sourceInfo);
		ext.tools.push(tool.name);
	}

	for (const ext of byPath.values()) {
		ext.commands.sort();
		ext.tools.sort();
	}

	return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Resolve a background-model tier under the requested set with the
 * documented `secondary → primary` fallback. Returns the resolved
 * value plus the layer it came from (or `"default"` when nothing is
 * configured anywhere).
 */
export function resolveBackgroundTier(
	spec: BackgroundModelUseSpec,
	layered: LayeredRelevantSettings,
): { value?: string; source: "project" | "global" | "default" } {
	const pick = (s: RelevantSettings): string | undefined => {
		const direct = s.backgroundModels?.[spec.set]?.[spec.tier];
		if (direct) return direct;
		// Mirror getTierModel: secondary falls back to primary.
		if (spec.set === "secondary") {
			return s.backgroundModels?.primary?.[spec.tier];
		}
		return undefined;
	};
	const fromProject = pick(layered.project);
	if (fromProject) return { value: fromProject, source: "project" };
	const fromGlobal = pick(layered.global);
	if (fromGlobal) return { value: fromGlobal, source: "global" };
	return { value: undefined, source: "default" };
}

/**
 * Build a `DeclaredExtensionView` for a single declared extension by
 * joining it against the command/tool grouping and resolving every
 * config key + background-model tier.
 */
export function buildDeclaredView(
	meta: ExtensionMetadata,
	loadedByPath: Map<string, LoadedExtension>,
	layered: LayeredRelevantSettings,
): DeclaredExtensionView {
	const loaded = loadedByPath.get(meta.path);
	const configKeys: ConfigKeyView[] = (meta.configSchema ?? []).map(
		(schema) => ({
			schema,
			effective: resolveEffectiveValue({
				extName: meta.name,
				key: schema.key,
				schema,
				layered,
			}),
		}),
	);
	const view: DeclaredExtensionView = {
		meta,
		commands: loaded?.commands ?? [],
		tools: loaded?.tools ?? [],
		configKeys,
	};
	if (meta.backgroundModelUse) {
		const r = resolveBackgroundTier(meta.backgroundModelUse, layered);
		view.backgroundModel = {
			spec: meta.backgroundModelUse,
			resolvedTierValue: r.value,
			source: r.source,
		};
	}
	return view;
}

/**
 * Count declared keys whose effective value came from a settings layer
 * (i.e. a real user override). Used in the headline.
 */
export function countOverrides(
	declared: readonly DeclaredExtensionView[],
): number {
	let n = 0;
	for (const ext of declared) {
		for (const key of ext.configKeys) {
			if (key.effective.isOverride) n += 1;
		}
	}
	return n;
}

/** Short one-liner for the `session_start` toast. */
export function renderHeadline(summary: StartupSummary): string {
	const exts = summary.declared.length + summary.unrecognized.length;
	return `pi-ext-startup: ${exts} ${exts === 1 ? "extension" : "extensions"} · /extensions for details`;
}

function formatValue(v: unknown): string {
	if (v === undefined) return "(unset)";
	if (v === null) return "null";
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		return `[${v.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(", ")}]`;
	}
	return JSON.stringify(v);
}

/**
 * Render one config key line for the lean `/extensions` format.
 *
 * Rules:
 *   - User override (project/global)  →  `key: value (project)` / `key: value (global)`
 *   - Fallback-chain key, not overridden  →  `key: value (via set.tier)` using
 *     the parent extension's `backgroundModel.resolvedTierValue`; falls back to
 *     `(unset)` when nothing could be resolved.
 *   - Literal default, not overridden  →  `key: value` (no annotation)
 */
function renderConfigKey(k: ConfigKeyView, ext: DeclaredExtensionView): string {
	const key = k.schema.key;
	if (k.effective.isOverride) {
		return `  ${key}: ${formatValue(k.effective.value)} (${k.effective.source})`;
	}
	// A literal `default` takes precedence over fallback-chain display even
	// when both are set on the schema (ConfigKeySchema: "default wins for the
	// literal value displayed"). Only enter the via/unset branch when there
	// is no concrete default to show.
	if (k.schema.fallbackChain && k.schema.default === undefined) {
		const bm = ext.backgroundModel;
		if (bm?.resolvedTierValue) {
			return `  ${key}: ${bm.resolvedTierValue} (via ${bm.spec.set}.${bm.spec.tier})`;
		}
		return `  ${key}: (unset)`;
	}
	const hasDefault = k.schema.default !== undefined;
	return `  ${key}: ${formatValue(k.effective.value)}${hasDefault ? " (default)" : ""}`;
}

/**
 * Multi-line breakdown for `/extensions`. Pure: takes a summary,
 * returns lines. The factory pipes these through `ctx.ui.notify`
 * one by one.
 */
export function renderLines(summary: StartupSummary): string[] {
	const lines: string[] = [];

	lines.push(
		`Active model: ${summary.activeModel ?? "(none — pi has no model bound)"}`,
	);

	const bg = summary.layered.merged.backgroundModels;
	const tierStr = (
		tiers: { fast?: string; normal?: string; heavy?: string } | undefined,
	): string => {
		if (!tiers || (!tiers.fast && !tiers.normal && !tiers.heavy)) {
			return "(not configured)";
		}
		const bits: string[] = [];
		if (tiers.fast) bits.push(`fast=${tiers.fast}`);
		if (tiers.normal) bits.push(`normal=${tiers.normal}`);
		if (tiers.heavy) bits.push(`heavy=${tiers.heavy}`);
		return bits.join(", ");
	};
	lines.push("");
	lines.push("Background models:");
	lines.push(`  primary:   ${tierStr(bg?.primary)}`);
	lines.push(`  secondary: ${tierStr(bg?.secondary)}`);

	// Context files
	const cfFiles = summary.contextFiles ?? [];
	lines.push("");
	if (cfFiles.length === 0) {
		lines.push("Context files: (none found)");
	} else {
		const cfTotal = cfFiles.reduce((s, f) => s + f.tokens, 0);
		const totalStr =
			cfTotal >= 1000 ? `${(cfTotal / 1000).toFixed(1)}k` : String(cfTotal);
		lines.push(`Context files (${cfFiles.length} · ${totalStr} tokens):`);
		for (const f of cfFiles) {
			const scope = f.scope.padEnd(7);
			lines.push(
				`  ${scope}  ${f.displayPath}  (${f.tokens} tok · ${f.lines} lines)`,
			);
		}
	}

	for (const ext of summary.declared) {
		lines.push("");
		lines.push(`${ext.meta.name}:`);
		if (ext.configKeys.length === 0) {
			lines.push("  (no config)");
		} else {
			for (const k of ext.configKeys) {
				lines.push(renderConfigKey(k, ext));
			}
		}
	}

	if (summary.unrecognized.length > 0) {
		lines.push("");
		lines.push("Unrecognized extensions (no metadata):");
		for (const ext of summary.unrecognized) {
			lines.push("");
			lines.push(`  ${ext.path}:`);
			if (ext.commands.length > 0) {
				lines.push(`    commands: ${ext.commands.join(", ")}`);
			}
			if (ext.tools.length > 0) {
				lines.push(`    tools: ${ext.tools.join(", ")}`);
			}
		}
	}

	return lines;
}

/** Build the structured summary from the running pi instance. */
export function summarize(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): StartupSummary {
	const grouped = groupBySource(pi.getCommands(), pi.getAllTools());
	const loadedByPath = new Map(grouped.map((e) => [e.path, e]));
	const declaredMetas = getDeclaredExtensions();
	const declaredPaths = new Set(declaredMetas.map((m) => m.path));
	const layered = readRelevantSettingsLayered(ctx.cwd);

	const declared = declaredMetas.map((m) =>
		buildDeclaredView(m, loadedByPath, layered),
	);
	const unrecognized = grouped.filter((e) => !declaredPaths.has(e.path));

	const activeModel = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	return {
		declared,
		unrecognized,
		layered,
		activeModel,
		contextFiles: discoverContextFiles(ctx.cwd),
	};
}

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Reports loaded extensions, their declared config knobs, and effective values.",
		configSchema: [
			{
				key: "enabled",
				type: "boolean",
				default: true,
				doc: "Show the extension summary on session start. Set to false to suppress the startup report (the /extensions command still works). Default: true.",
			},
		],
	});

	// One multi-line notify, not many. pi's interactive-mode `showStatus`
	// (where `info` notifications land) replaces the *previous* status text
	// in place when consecutive info notifies arrive — so a per-line loop
	// collapses to whichever line happened to be last. A single notify with
	// embedded newlines renders as one Text block instead.
	const emitReport = (ctx: ExtensionContext) => {
		const summary = summarize(pi, ctx);
		const body = [renderHeadline(summary), "", ...renderLines(summary)].join(
			"\n",
		);
		ctx.ui.notify(body, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		const settings = readRelevantSettings(ctx.cwd);
		const enabled = getExtensionConfigBoolean(
			settings,
			EXT_ID,
			"enabled",
			true,
		);
		if (!enabled) return;
		emitReport(ctx);
	});

	pi.registerCommand("extensions", {
		description:
			"Show what pi loaded from this monorepo: declared extensions, config schemas, effective values, and active model.",
		handler: async (_args, ctx) => {
			emitReport(ctx);
		},
	});
}
