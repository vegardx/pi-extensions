import type {
	ExtensionAPI,
	ExtensionContext,
	SlashCommandInfo,
	ToolInfo,
} from "@mariozechner/pi-coding-agent";
import {
	type RelevantSettings,
	readRelevantSettings,
} from "@vegardx/pi-extensions-shared/extension-settings.js";

/**
 * One loaded extension as we can observe it from the public API: a single
 * `sourceInfo.path` plus the commands and tools it registered.
 *
 * pi doesn't expose "every loaded extension" to other extensions — only
 * the registered commands and tools. So this is a *contributions-based*
 * view, not a true module list. See README for the caveat.
 */
export interface LoadedExtension {
	path: string;
	source: string;
	scope: string;
	origin: string;
	commands: string[];
	tools: string[];
}

export interface StartupSummary {
	extensions: LoadedExtension[];
	settings: RelevantSettings;
	activeModel?: string;
}

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

/** Count of `extensionConfig.<name>.model` overrides actually set. */
export function countOverrides(settings: RelevantSettings): number {
	const ec = settings.extensionConfig;
	if (!ec) return 0;
	let n = 0;
	for (const cfg of Object.values(ec)) {
		if (cfg?.model) n += 1;
	}
	return n;
}

/** Short one-liner for the `session_start` toast. */
export function renderHeadline(summary: StartupSummary): string {
	const exts = summary.extensions.length;
	const overrides = countOverrides(summary.settings);
	const parts = [
		`${exts} ${exts === 1 ? "extension" : "extensions"}`,
		`${overrides} model override${overrides === 1 ? "" : "s"}`,
	];
	return `pi-ext-startup: ${parts.join(" · ")} · /loaded for details`;
}

/**
 * Multi-line breakdown for `/loaded`. Pure: takes a summary, returns
 * lines. The factory pipes these through `ctx.ui.notify` one by one.
 */
export function renderLines(summary: StartupSummary): string[] {
	const lines: string[] = [];

	lines.push(
		`Active model: ${summary.activeModel ?? "(none — pi has no model bound)"}`,
	);

	const bg = summary.settings.backgroundModels;
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

	const overrides = summary.settings.extensionConfig;
	if (overrides && Object.keys(overrides).length > 0) {
		lines.push("Per-extension overrides:");
		for (const [name, cfg] of Object.entries(overrides).sort()) {
			if (cfg?.model) lines.push(`  ${name}: model=${cfg.model}`);
		}
	} else {
		lines.push("Per-extension overrides: (none)");
	}

	if (summary.extensions.length === 0) {
		lines.push("No extensions registered commands or tools.");
		return lines;
	}

	lines.push(
		`Loaded extensions (${summary.extensions.length}, by sourceInfo.path):`,
	);
	for (const ext of summary.extensions) {
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

	return lines;
}

/** Build the structured summary from the running pi instance. */
export function summarize(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): StartupSummary {
	const extensions = groupBySource(pi.getCommands(), pi.getAllTools());
	const settings = readRelevantSettings(ctx.cwd);
	const activeModel = ctx.model
		? `${ctx.model.provider}/${ctx.model.id}`
		: undefined;
	return { extensions, settings, activeModel };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const summary = summarize(pi, ctx);
		ctx.ui.notify(renderHeadline(summary), "info");
	});

	pi.registerCommand("loaded", {
		description:
			"Show what pi loaded from this monorepo (extensions, settings, active model)",
		handler: async (_args, ctx) => {
			const summary = summarize(pi, ctx);
			for (const line of renderLines(summary)) {
				ctx.ui.notify(line, "info");
			}
		},
	});
}
