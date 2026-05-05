import type { SlashCommandInfo, ToolInfo } from "@mariozechner/pi-coding-agent";
import {
	clearDeclaredExtensions,
	declareExtension,
} from "@vegardx/pi-extensions-shared/extension-metadata.js";
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
				cmd("develop", "extension", "/repo/packages/develop/index.ts"),
				cmd("implement", "extension", "/repo/packages/develop/index.ts"),
				cmd("review", "extension", "/repo/packages/review/index.ts"),
			],
			[
				tool(
					"greet",
					"/repo/packages/startup/index.ts",
					"/repo/packages/startup/index.ts",
				),
				tool(
					"verify_step",
					"/repo/packages/verify/index.ts",
					"/repo/packages/verify/index.ts",
				),
			],
		);

		expect(grouped).toHaveLength(4);
		const developEntry = grouped.find((e) =>
			e.path.endsWith("packages/develop/index.ts"),
		);
		expect(developEntry?.commands).toEqual(["develop", "implement"]);
		expect(developEntry?.tools).toEqual([]);

		const startupEntry = grouped.find((e) =>
			e.path.endsWith("packages/startup/index.ts"),
		);
		expect(startupEntry?.tools).toEqual(["greet"]);
		expect(startupEntry?.commands).toEqual([]);
	});

	it("filters out builtin and sdk tools, and prompt/skill commands", () => {
		const grouped = groupBySource(
			[
				cmd("develop", "extension", "/repo/packages/develop/index.ts"),
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
			"/repo/packages/develop/index.ts",
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
	const verifyMeta = {
		name: "verify",
		path: "/repo/packages/verify/index.ts",
		doc: "Verify a plan.",
		configSchema: [
			{
				key: "model",
				type: "string" as const,
				fallbackChain:
					"extensionConfig.verify.model → backgroundModels.secondary.normal → ctx.model",
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
				verifyMeta.path,
				loadedFromPath(verifyMeta.path, ["verify"], ["verify_step"]),
			],
		]);
		const view = buildDeclaredView(verifyMeta, loadedByPath, {
			global: {},
			project: {
				extensionConfig: {
					verify: { model: "p/verify", maxParallel: 8 },
				},
				backgroundModels: { secondary: { normal: "p/secondary-normal" } },
			},
			merged: {
				extensionConfig: {
					verify: { model: "p/verify", maxParallel: 8 },
				},
				backgroundModels: { secondary: { normal: "p/secondary-normal" } },
			},
		});

		expect(view.commands).toEqual(["verify"]);
		expect(view.tools).toEqual(["verify_step"]);
		expect(view.configKeys).toHaveLength(2);

		const modelKey = view.configKeys.find((k) => k.schema.key === "model");
		expect(modelKey?.effective).toEqual({
			value: "p/verify",
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
		const view = buildDeclaredView(verifyMeta, new Map(), {
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
				meta: { name: "verify", path: "/v.ts" },
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
				meta: { name: "session-title", path: "/s.ts" },
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

	it("pluralises correctly for empty input and points to /extensions", () => {
		expect(renderHeadline(empty)).toBe(
			"pi-ext-startup: 0 extensions · 0 overrides · /extensions for details",
		);
	});

	it("uses singular forms for counts of one", () => {
		const summary: StartupSummary = {
			declared: [
				{
					meta: { name: "verify", path: "/v.ts" },
					commands: [],
					tools: [],
					configKeys: [
						{
							schema: { key: "model", type: "string", doc: "" },
							effective: { value: "p/m", source: "project", isOverride: true },
						},
					],
				},
			],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		};
		expect(renderHeadline(summary)).toBe(
			"pi-ext-startup: 1 extension · 1 override · /extensions for details",
		);
	});
});

// --- renderLines ------------------------------------------------------------

describe("renderLines", () => {
	it("reports (not configured) and an empty-declared message", () => {
		const lines = renderLines({
			declared: [],
			unrecognized: [],
			layered: { global: {}, project: {}, merged: {} },
		});
		expect(lines).toContain("Active model: (none — pi has no model bound)");
		expect(lines).toContain("Background primary: (not configured)");
		expect(lines).toContain("Background secondary: (not configured)");
		expect(lines).toContain("No declared extensions.");
	});

	it("renders declared extensions with effective values, sources, and tier", () => {
		const summary: StartupSummary = {
			activeModel: "anthropic/claude-sonnet-4-5",
			declared: [
				{
					meta: {
						name: "verify",
						path: "/repo/packages/verify/index.ts",
						doc: "Verify a plan.",
						configSchema: [],
						backgroundModelUse: { tier: "normal", set: "secondary" },
					},
					commands: ["verify"],
					tools: ["verify_step"],
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
								fallbackChain: "extensionConfig.verify.model → …",
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
		expect(lines).toContain(
			"Background primary: fast=anthropic/claude-haiku-4-5",
		);
		expect(lines).toContain(
			"Background secondary: normal=openrouter/anthropic/claude-sonnet-4.5",
		);
		expect(lines).toContain("Declared extensions (1):");
		expect(lines).toContain("  verify  [/repo/packages/verify/index.ts]");
		expect(lines).toContain("    doc: Verify a plan.");
		expect(lines).toContain("    commands: /verify");
		expect(lines).toContain("    tools: verify_step");
		expect(lines).toContain("    config:");
		expect(lines).toContain(
			"      maxParallel: 15 (source: default; default: 15) — Max concurrent verifier subagents.",
		);
		expect(lines).toContain(
			"      model: openrouter/anthropic/claude-sonnet-4.5 (source: project; default: extensionConfig.verify.model → …) — Override verifier model.",
		);
		expect(lines).toContain(
			"    background model: secondary.normal = openrouter/anthropic/claude-sonnet-4.5 (source: project) — subagent",
		);
	});

	it("renders the unrecognized bucket when a loaded extension didn't declare", () => {
		const summary: StartupSummary = {
			declared: [],
			unrecognized: [
				loadedFromPath("/external/foo/index.ts", ["foo"], ["foo_tool"]),
			],
			layered: { global: {}, project: {}, merged: {} },
		};
		const lines = renderLines(summary);
		expect(lines).toContain(
			"Unrecognized extensions (1; registered commands/tools but did not call declareExtension):",
		);
		expect(lines).toContain("  /external/foo/index.ts");
		expect(lines).toContain("    commands: /foo");
		expect(lines).toContain("    tools: foo_tool");
	});

	it("shows '(no declared keys)' for declared extensions without configSchema", () => {
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
		expect(lines).toContain("    config: (no declared keys)");
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
