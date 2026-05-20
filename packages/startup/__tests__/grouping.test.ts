import type { SlashCommandInfo, ToolInfo } from "@mariozechner/pi-coding-agent";
import { clearDeclaredExtensions } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	buildDeclaredView,
	countOverrides,
	type DeclaredExtensionView,
	groupBySource,
	type LoadedExtension,
	renderHeadline,
	renderLines,
	resolveBackgroundTier,
	type StartupSummary,
} from "../index.js";

beforeEach(() => {
	clearDeclaredExtensions();
});

// --- fixtures ---------------------------------------------------------------

function srcInfo(
	path: string,
	source: string = path,
	scope: "user" | "project" | "temporary" = "user",
	origin: "package" | "top-level" = "package",
) {
	return { path, source, scope, origin };
}

function cmd(
	name: string,
	source: SlashCommandInfo["source"],
	path: string,
): SlashCommandInfo {
	return {
		name,
		description: `desc for ${name}`,
		source,
		sourceInfo: srcInfo(path),
	};
}

function tool(name: string, sourcePath: string, kind: string): ToolInfo {
	return {
		name,
		description: `desc for ${name}`,
		// `parameters` is an opaque schema object to consumers; an empty
		// object is fine for the grouping logic which never inspects it.
		parameters: {} as ToolInfo["parameters"],
		sourceInfo: srcInfo(sourcePath, kind),
	};
}

function loadedFromPath(
	path: string,
	commands: string[] = [],
	tools: string[] = [],
): LoadedExtension {
	return {
		path,
		source: path,
		scope: "user",
		origin: "package",
		commands,
		tools,
	};
}

// --- groupBySource ----------------------------------------------------------

describe("groupBySource", () => {
	it("dedupes commands and tools by sourceInfo.path", () => {
		const grouped = groupBySource(
			[
				cmd("plan", "extension", "/repo/packages/modes/index.ts"),
				cmd("implement", "extension", "/repo/packages/modes/index.ts"),
				cmd("review", "extension", "/repo/packages/review/index.ts"),
			],
			[
				tool(
					"greet",
					"/repo/packages/startup/index.ts",
					"/repo/packages/startup/index.ts",
				),
				tool(
					"webfetch_tool",
					"/repo/packages/webfetch/index.ts",
					"/repo/packages/webfetch/index.ts",
				),
			],
		);

		expect(grouped).toHaveLength(4);
		const modesEntry = grouped.find((e) =>
			e.path.endsWith("packages/modes/index.ts"),
		);
		expect(modesEntry?.commands).toEqual(["implement", "plan"]);
		expect(modesEntry?.tools).toEqual([]);

		const startupEntry = grouped.find((e) =>
			e.path.endsWith("packages/startup/index.ts"),
		);
		expect(startupEntry?.tools).toEqual(["greet"]);
		expect(startupEntry?.commands).toEqual([]);
	});

	it("filters out builtin and sdk tools, and prompt/skill commands", () => {
		const grouped = groupBySource(
			[
				cmd("plan", "extension", "/repo/packages/modes/index.ts"),
				cmd("my-prompt", "prompt", "/home/u/.pi/prompts/my-prompt.md"),
				cmd("my-skill", "skill", "/home/u/.pi/skills/my-skill/SKILL.md"),
			],
			[
				tool("read", "<builtin:read>", "builtin"),
				tool("custom_sdk_tool", "<sdk:foo>", "sdk"),
				tool(
					"greet",
					"/repo/packages/startup/index.ts",
					"/repo/packages/startup/index.ts",
				),
			],
		);

		expect(grouped.map((e) => e.path).sort()).toEqual([
			"/repo/packages/modes/index.ts",
			"/repo/packages/startup/index.ts",
		]);
	});

	it("sorts entries by path for stable rendering", () => {
		const grouped = groupBySource(
			[
				cmd("z", "extension", "/repo/z/index.ts"),
				cmd("a", "extension", "/repo/a/index.ts"),
				cmd("m", "extension", "/repo/m/index.ts"),
			],
			[],
		);
		expect(grouped.map((e) => e.path)).toEqual([
			"/repo/a/index.ts",
			"/repo/m/index.ts",
			"/repo/z/index.ts",
		]);
	});
});

// --- resolveBackgroundTier --------------------------------------------------

describe("resolveBackgroundTier", () => {
	it("returns the project value when set", () => {
		expect(
			resolveBackgroundTier(
				{ tier: "fast", set: "primary" },
				{
					global: {
						backgroundModels: { primary: { fast: "g/fast" } },
					},
					project: {
						backgroundModels: { primary: { fast: "p/fast" } },
					},
					merged: {
						backgroundModels: { primary: { fast: "p/fast" } },
					},
				},
			),
		).toEqual({ value: "p/fast", source: "project" });
	});

	it("returns the global value when project is unset", () => {
		expect(
			resolveBackgroundTier(
				{ tier: "fast", set: "primary" },
				{
					global: { backgroundModels: { primary: { fast: "g/fast" } } },
					project: {},
					merged: { backgroundModels: { primary: { fast: "g/fast" } } },
				},
			),
		).toEqual({ value: "g/fast", source: "global" });
	});

	it("falls back from secondary to primary at the same tier", () => {
		expect(
			resolveBackgroundTier(
				{ tier: "normal", set: "secondary" },
				{
					global: {},
					project: {
						backgroundModels: { primary: { normal: "p/normal" } },
					},
					merged: {
						backgroundModels: { primary: { normal: "p/normal" } },
					},
				},
			),
		).toEqual({ value: "p/normal", source: "project" });
	});

	it("returns default/undefined when nothing is configured", () => {
		expect(
			resolveBackgroundTier(
				{ tier: "fast", set: "primary" },
				{ global: {}, project: {}, merged: {} },
			),
		).toEqual({ value: undefined, source: "default" });
	});
});

// --- buildDeclaredView ------------------------------------------------------

describe("buildDeclaredView", () => {
	const webfetchMeta = {
		name: "webfetch",
		path: "/repo/packages/webfetch/index.ts",
		doc: "Verify a plan.",
		configSchema: [
			{
				key: "model",
				type: "string" as const,
				fallbackChain:
					"extensionConfig.webfetch.model → backgroundModels.secondary.normal → ctx.model",
				doc: "Override verifier model.",
			},
			{
				key: "maxParallel",
				type: "number" as const,
				default: 15,
				doc: "Max concurrent verifier subagents.",
			},
		],
		backgroundModelUse: {
			tier: "normal" as const,
			set: "secondary" as const,
		},
	};

	it("joins commands/tools by path and resolves both keys + tier", () => {
		const loadedByPath = new Map<string, LoadedExtension>([
			[
				webfetchMeta.path,
				loadedFromPath(webfetchMeta.path, ["webfetch_cmd"], ["webfetch_tool"]),
			],
		]);
		const view = buildDeclaredView(webfetchMeta, loadedByPath, {
			global: {},
			project: {
				extensionConfig: {
					webfetch: { model: "p/webfetch", maxParallel: 8 },
				},
				backgroundModels: { secondary: { normal: "p/secondary-normal" } },
			},
			merged: {
				extensionConfig: {
					webfetch: { model: "p/webfetch", maxParallel: 8 },
				},
				backgroundModels: { secondary: { normal: "p/secondary-normal" } },
			},
		});

		expect(view.commands).toEqual(["webfetch_cmd"]);
		expect(view.tools).toEqual(["webfetch_tool"]);
		expect(view.configKeys).toHaveLength(2);

		const modelKey = view.configKeys.find((k) => k.schema.key === "model");
		expect(modelKey?.effective).toEqual({
			value: "p/webfetch",
			source: "project",
			isOverride: true,
		});

		const mp = view.configKeys.find((k) => k.schema.key === "maxParallel");
		expect(mp?.effective).toEqual({
			value: 8,
			source: "project",
			isOverride: true,
		});

		expect(view.backgroundModel).toEqual({
			spec: { tier: "normal", set: "secondary" },
			resolvedTierValue: "p/secondary-normal",
			source: "project",
		});
	});

	it("uses defaults when no settings layer covers a key", () => {
		const view = buildDeclaredView(webfetchMeta, new Map(), {
			global: {},
			project: {},
			merged: {},
		});
		const modelKey = view.configKeys.find((k) => k.schema.key === "model");
		expect(modelKey?.effective).toEqual({
			value: undefined,
			source: "default",
			isOverride: false,
		});
		const mp = view.configKeys.find((k) => k.schema.key === "maxParallel");
		expect(mp?.effective).toEqual({
			value: 15,
			source: "default",
			isOverride: false,
		});
		expect(view.commands).toEqual([]);
		expect(view.tools).toEqual([]);
	});
});

// --- countOverrides ---------------------------------------------------------

describe("countOverrides", () => {
	it("counts only declared keys whose value came from a settings layer", () => {
		const declared: DeclaredExtensionView[] = [
			{
				meta: { name: "webfetch", path: "/v.ts" },
				commands: [],
				tools: [],
				configKeys: [
					{
						schema: { key: "model", type: "string", doc: "" },
						effective: {
							value: "p/x",
							source: "project",
							isOverride: true,
						},
					},
					{
						schema: {
							key: "maxParallel",
							type: "number",
							default: 15,
							doc: "",
						},
						effective: { value: 15, source: "default", isOverride: false },
					},
				],
			},
			{
				meta: { name: "caffeinate", path: "/s.ts" },
				commands: [],
				tools: [],
				configKeys: [
					{
						schema: { key: "model", type: "string", doc: "" },
						effective: { value: "g/y", source: "global", isOverride: true },
					},
				],
			},
		];
		expect(countOverrides(declared)).toBe(2);
	});

	it("returns 0 for empty input or all-default values", () => {
		expect(countOverrides([])).toBe(0);
		expect(
			countOverrides([
				{
					meta: { name: "x", path: "/x.ts" },
					commands: [],
					tools: [],
					configKeys: [
						{
							schema: { key: "k", type: "string", doc: "" },
							effective: {
								value: undefined,
								source: "default",
								isOverride: false,
							},
						},
					],
				},
			]),
		).toBe(0);
	});
});

// --- renderHeadline ---------------------------------------------------------

describe("renderHeadline", () => {
	const empty: StartupSummary = {
		declared: [],
		unrecognized: [],
		layered: { global: {}, project: {}, merged: {} },
	};

	it("reports 0/0 with the same · /extensions hint when nothing is installed", () => {
		expect(renderHeadline(empty)).toBe(
			"pi-ext-startup: 0 extensions · /extensions for details",
		);
	});

	it("hints at /extensions when nothing is enabled but extensions are installed", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "webfetch", path: "/v.ts", enabled: false },
					commands: [],
					tools: [],
					configKeys: [],
				},
				{
					meta: { name: "modes", path: "/m.ts", enabled: false },
					commands: [],
					tools: [],
					configKeys: [],
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		expect(renderHeadline(summary)).toBe(
			"ℹ pi-extensions: 0 of 2 enabled. Run /extensions to configure.",
		);
	});

	it("lists enabled extensions alphabetically with installed total", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "webfetch", path: "/v.ts", enabled: true },
					commands: [],
					tools: [],
					configKeys: [],
				},
				{
					meta: { name: "modes", path: "/m.ts", enabled: true },
					commands: [],
					tools: [],
					configKeys: [],
				},
				{
					meta: { name: "commit", path: "/c.ts", enabled: false },
					commands: [],
					tools: [],
					configKeys: [],
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		expect(renderHeadline(summary)).toBe(
			"✓ pi-extensions loaded: modes, webfetch (2 of 3 installed) · /extensions for details",
		);
	});

	it("appends an unrecognized addendum without polluting the enabled count (regression: PR #248 review)", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "modes", path: "/m.ts", enabled: false },
					commands: [],
					tools: [],
					configKeys: [],
				},
				{
					meta: { name: "webfetch", path: "/v.ts", enabled: false },
					commands: [],
					tools: [],
					configKeys: [],
				},
			],
			unrecognized: [
				{
					path: "/u.ts",
					source: "manifest",
					scope: "global",
					origin: "x",
					commands: [],
					tools: [],
				},
			],
			layered: { global: {}, project: {}, merged: {} },
		};
		expect(renderHeadline(summary)).toBe(
			"ℹ pi-extensions: 0 of 2 enabled (+1 unrecognized). Run /extensions to configure.",
		);
	});
});

// --- renderLines ------------------------------------------------------------

describe("renderLines", () => {
	it("renders background models block and nothing else for empty declared list", () => {
		const lines = renderLines({
			declared: [],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		});
		expect(lines).toContain("Active model: (none — pi has no model bound)");
		expect(lines).toContain("Background models:");
		expect(lines).toContain("  primary:   (not configured)");
		expect(lines).toContain("  secondary: (not configured)");
		// No extension blocks expected
		expect(
			lines.some(
				(l) =>
					l.endsWith(":") && !l.startsWith(" ") && l !== "Background models:",
			),
		).toBe(false);
	});

	it("renders declared extensions with effective values, sources, and tier", () => {
		const summary: StartupSummary = {
			activeModel: "anthropic/claude-sonnet-4-5",
			declared: [
				{
					meta: {
						name: "webfetch",
						path: "/repo/packages/webfetch/index.ts",
						doc: "Verify a plan.",
						configSchema: [],
						backgroundModelUse: { tier: "normal", set: "secondary" },
					},
					commands: ["webfetch_cmd"],
					tools: ["webfetch_tool"],
					configKeys: [
						{
							schema: {
								key: "maxParallel",
								type: "number",
								default: 15,
								doc: "Max concurrent verifier subagents.",
							},
							effective: { value: 15, source: "default", isOverride: false },
						},
						{
							schema: {
								key: "model",
								type: "string",
								fallbackChain: "extensionConfig.webfetch.model → …",
								doc: "Override verifier model.",
							},
							effective: {
								value: "openrouter/anthropic/claude-sonnet-4.5",
								source: "project",
								isOverride: true,
							},
						},
					],
					backgroundModel: {
						spec: { tier: "normal", set: "secondary", explanation: "subagent" },
						resolvedTierValue: "openrouter/anthropic/claude-sonnet-4.5",
						source: "project",
					},
				},
			],
			unrecognized: [],
			layered: {
				global: {},
				project: {
					backgroundModels: {
						primary: { fast: "anthropic/claude-haiku-4-5" },
						secondary: { normal: "openrouter/anthropic/claude-sonnet-4.5" },
					},
				},
				merged: {
					backgroundModels: {
						primary: { fast: "anthropic/claude-haiku-4-5" },
						secondary: { normal: "openrouter/anthropic/claude-sonnet-4.5" },
					},
				},
			},
		};
		const lines = renderLines(summary);

		expect(lines).toContain("Active model: anthropic/claude-sonnet-4-5");
		expect(lines).toContain("Background models:");
		expect(lines).toContain("  primary:   fast=anthropic/claude-haiku-4-5");
		expect(lines).toContain(
			"  secondary: normal=openrouter/anthropic/claude-sonnet-4.5",
		);
		// Extension header
		expect(lines).toContain("webfetch:");
		// maxParallel has a literal default and no override → annotated with (default)
		expect(lines).toContain("  maxParallel: 15 (default)");
		// model is overridden at project level → annotated with source
		expect(lines).toContain(
			"  model: openrouter/anthropic/claude-sonnet-4.5 (project)",
		);
		// Old verbose lines must not appear
		expect(lines).not.toContain(
			"  webfetch  [/repo/packages/webfetch/index.ts]",
		);
		expect(lines).not.toContain("    commands: /webfetch_cmd");
		expect(lines).not.toContain("    doc: Verify a plan.");
	});

	it("unrecognized extensions are not rendered", () => {
		const summary: StartupSummary = {
			declared: [],
			unrecognized: [
				loadedFromPath("/external/foo/index.ts", ["foo"], ["foo_tool"]),
			],
			layered: { global: {}, project: {}, merged: {} },
		};
		const lines = renderLines(summary);
		expect(lines).not.toContain("/external/foo/index.ts");
		expect(lines).not.toContain("    commands: /foo");
	});

	it("shows '(no config)' for declared extensions without configSchema", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "commit", path: "/c.ts" },
					commands: ["commit"],
					tools: [],
					configKeys: [],
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		const lines = renderLines(summary);
		expect(lines).toContain("commit:");
		expect(lines).toContain("  (no config)");
	});

	it("renders fallback-chain key as resolved value with (via set.tier)", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "webfetch", path: "/v.ts" },
					commands: [],
					tools: [],
					configKeys: [
						{
							schema: {
								key: "model",
								type: "string",
								fallbackChain:
									"extensionConfig.webfetch.model → backgroundModels.primary.fast → ctx.model",
								doc: "Override verifier model.",
							},
							effective: {
								value: undefined,
								source: "default",
								isOverride: false,
							},
						},
					],
					backgroundModel: {
						spec: { tier: "fast", set: "primary" },
						resolvedTierValue: "radicalai/eu-haiku-4-5",
						source: "global",
					},
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		const lines = renderLines(summary);
		expect(lines).toContain(
			"  model: radicalai/eu-haiku-4-5 (via primary.fast)",
		);
	});

	it("renders fallback-chain key as (unset) when backgroundModel has no resolvedTierValue", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "webfetch", path: "/v.ts" },
					commands: [],
					tools: [],
					configKeys: [
						{
							schema: {
								key: "model",
								type: "string",
								fallbackChain:
									"extensionConfig.webfetch.model → backgroundModels.primary.fast → ctx.model",
								doc: "Override verifier model.",
							},
							effective: {
								value: undefined,
								source: "default",
								isOverride: false,
							},
						},
					],
					backgroundModel: {
						spec: { tier: "fast", set: "primary" },
						resolvedTierValue: undefined,
						source: "default",
					},
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		const lines = renderLines(summary);
		expect(lines).toContain("  model: (unset)");
	});

	it("renders bare default when schema has both default and fallbackChain", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "webfetch", path: "/v.ts" },
					commands: [],
					tools: [],
					configKeys: [
						{
							schema: {
								key: "maxParallel",
								type: "number",
								default: 15,
								fallbackChain:
									"extensionConfig.webfetch.maxParallel → backgroundModels.primary.fast",
								doc: "Max parallel.",
							},
							effective: {
								value: 15,
								source: "default",
								isOverride: false,
							},
						},
					],
					backgroundModel: {
						spec: { tier: "fast", set: "primary" },
						resolvedTierValue: "radicalai/eu-haiku-4-5",
						source: "global",
					},
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		const lines = renderLines(summary);
		// literal default wins — must NOT render (via primary.fast)
		expect(lines).toContain("  maxParallel: 15 (default)");
		expect(lines).not.toContain(
			"  maxParallel: radicalai/eu-haiku-4-5 (via primary.fast)",
		);
	});
});

// --- declareExtension is wired in defaults --------------------------------

describe("startup factory side-effect", () => {
	it("self-declares as 'startup'", async () => {
		// Importing index.ts shouldn't itself register; only invoking the
		// factory does. So we explicitly call the default export.
		const mod = await import("../index.js");
		const fakePi: any = {
			on: () => {},
			registerCommand: () => {},
			getCommands: () => [],
			getAllTools: () => [],
		};
		mod.default(fakePi);

		const { getDeclaredExtensions } = await import(
			"@vegardx/pi-extensions-shared/extension-metadata.js"
		);
		const names = getDeclaredExtensions().map((m) => m.name);
		expect(names).toContain("startup");
	});
});
