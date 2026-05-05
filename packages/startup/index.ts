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
	type LayeredRelevantSettings,
	type RelevantSettings,
	readRelevantSettingsLayered,
} from "@vegardx/pi-extensions-shared/extension-settings.js";

const EXT_ID = "startup";

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
	const exts = summary.declared.length;
	const overrides = countOverrides(summary.declared);
	const parts = [
		`${exts} ${exts === 1 ? "extension" : "extensions"}`,
		`${overrides} override${overrides === 1 ? "" : "s"}`,
	];
	return `pi-ext-startup: ${parts.join(" · ")} · /extensions for details`;
}

function formatValue(v: unknown): string {
	if (v === undefined) return "(unset)";
	if (v === null) return "null";
	if (typeof v === "string") return v;
	return JSON.stringify(v);
}

function formatDefault(schema: ConfigKeySchema): string {
	if (schema.default !== undefined) return formatValue(schema.default);
	if (schema.fallbackChain) return schema.fallbackChain;
	return "(unset)";
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
	const tierLine = (
		label: string,
		tiers: { fast?: string; normal?: string; heavy?: string } | undefined,
	) => {
		if (!tiers || (!tiers.fast && !tiers.normal && !tiers.heavy)) {
			return `${label}: (not configured)`;
		}
		const bits: string[] = [];
		if (tiers.fast) bits.push(`fast=${tiers.fast}`);
		if (tiers.normal) bits.push(`normal=${tiers.normal}`);
		if (tiers.heavy) bits.push(`heavy=${tiers.heavy}`);
		return `${label}: ${bits.join(", ")}`;
	};
	lines.push(tierLine("Background primary", bg?.primary));
	lines.push(tierLine("Background secondary", bg?.secondary));

	if (summary.declared.length === 0) {
		lines.push("No declared extensions.");
	} else {
		lines.push(`Declared extensions (${summary.declared.length}):`);
		for (const ext of summary.declared) {
			lines.push(`  ${ext.meta.name}  [${ext.meta.path}]`);
			if (ext.meta.doc) lines.push(`    doc: ${ext.meta.doc}`);
			lines.push(
				`    commands: ${ext.commands.length ? ext.commands.map((c) => `/${c}`).join(", ") : "(none)"}`,
			);
			lines.push(
				`    tools: ${ext.tools.length ? ext.tools.join(", ") : "(none)"}`,
			);

			if (ext.configKeys.length === 0) {
				lines.push("    config: (no declared keys)");
			} else {
				lines.push("    config:");
				for (const k of ext.configKeys) {
					const value = formatValue(k.effective.value);
					const def = formatDefault(k.schema);
					const sourceLabel = k.effective.isOverride
						? k.effective.source
						: "default";
					lines.push(
						`      ${k.schema.key}: ${value} (source: ${sourceLabel}; default: ${def}) — ${k.schema.doc}`,
					);
				}
			}

			if (ext.backgroundModel) {
				const { spec, resolvedTierValue, source } = ext.backgroundModel;
				const valueText = resolvedTierValue
					? `${resolvedTierValue} (source: ${source})`
					: "(unset; falls back to ctx.model at call time)";
				const note = spec.explanation ? ` — ${spec.explanation}` : "";
				lines.push(
					`    background model: ${spec.set}.${spec.tier} = ${valueText}${note}`,
				);
			}
		}
	}

	if (summary.unrecognized.length > 0) {
		lines.push(
			`Unrecognized extensions (${summary.unrecognized.length}; registered commands/tools but did not call declareExtension):`,
		);
		for (const ext of summary.unrecognized) {
			const cmds = ext.commands.length
				? `commands: ${ext.commands.map((c) => `/${c}`).join(", ")}`
				: "commands: (none)";
			const tools = ext.tools.length
				? `tools: ${ext.tools.join(", ")}`
				: "tools: (none)";
			lines.push(`  ${ext.path}`);
			lines.push(`    ${cmds}`);
			lines.push(`    ${tools}`);
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
	return { declared, unrecognized, layered, activeModel };
}

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Reports loaded extensions, their declared config knobs, and effective values.",
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
