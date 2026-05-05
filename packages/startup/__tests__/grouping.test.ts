import type { SlashCommandInfo, ToolInfo } from "@mariozechner/pi-coding-agent";
import {
	countOverrides,
	groupBySource,
	renderHeadline,
	renderLines,
	type StartupSummary,
} from "../index.js";

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

		// Only the two true extensions survive.
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

	it("returns an empty list when nothing matches", () => {
		expect(groupBySource([], [])).toEqual([]);
		expect(
			groupBySource([], [tool("read", "<builtin:read>", "builtin")]),
		).toEqual([]);
	});
});

// --- countOverrides ---------------------------------------------------------

describe("countOverrides", () => {
	it("counts only entries with a model set", () => {
		expect(countOverrides({})).toBe(0);
		expect(countOverrides({ extensionConfig: {} })).toBe(0);
		expect(
			countOverrides({
				extensionConfig: {
					verify: { model: "anthropic/claude-sonnet-4-5-20250929" },
					"prompt-suggestion": {},
					"session-title": { model: "openrouter/anthropic/claude-haiku-4-5" },
				},
			}),
		).toBe(2);
	});
});

// --- renderHeadline ---------------------------------------------------------

describe("renderHeadline", () => {
	const empty: StartupSummary = { extensions: [], settings: {} };

	it("pluralises correctly for empty input", () => {
		expect(renderHeadline(empty)).toBe(
			"pi-ext-startup: 0 extensions · 0 model overrides · /loaded for details",
		);
	});

	it("uses singular forms for counts of one", () => {
		const summary: StartupSummary = {
			extensions: [
				{
					path: "/repo/packages/startup/index.ts",
					source: "x",
					scope: "user",
					origin: "package",
					commands: ["loaded"],
					tools: [],
				},
			],
			settings: {
				extensionConfig: { verify: { model: "p/m" } },
			},
		};
		expect(renderHeadline(summary)).toBe(
			"pi-ext-startup: 1 extension · 1 model override · /loaded for details",
		);
	});
});

// --- renderLines ------------------------------------------------------------

describe("renderLines", () => {
	it("reports (not configured) and (none) for an empty summary", () => {
		const lines = renderLines({ extensions: [], settings: {} });
		expect(lines).toContain("Active model: (none — pi has no model bound)");
		expect(lines).toContain("Background primary: (not configured)");
		expect(lines).toContain("Background secondary: (not configured)");
		expect(lines).toContain("Per-extension overrides: (none)");
		expect(lines).toContain("No extensions registered commands or tools.");
	});

	it("prints partial tier configuration without inventing missing tiers", () => {
		const lines = renderLines({
			extensions: [],
			settings: {
				backgroundModels: {
					primary: { fast: "anthropic/claude-haiku-4-5" },
				},
			},
			activeModel: "anthropic/claude-sonnet-4-5",
		});
		expect(lines).toContain(
			"Background primary: fast=anthropic/claude-haiku-4-5",
		);
		expect(lines).toContain("Background secondary: (not configured)");
		expect(lines).toContain("Active model: anthropic/claude-sonnet-4-5");
	});

	it("renders a fully-configured summary with extensions, tiers, overrides", () => {
		const summary: StartupSummary = {
			activeModel: "anthropic/claude-sonnet-4-5",
			extensions: [
				{
					path: "/repo/packages/develop/index.ts",
					source: "/repo/packages/develop/index.ts",
					scope: "user",
					origin: "package",
					commands: ["develop", "implement"],
					tools: [],
				},
				{
					path: "/repo/packages/startup/index.ts",
					source: "/repo/packages/startup/index.ts",
					scope: "user",
					origin: "package",
					commands: ["loaded"],
					tools: ["greet"],
				},
			],
			settings: {
				backgroundModels: {
					primary: {
						fast: "anthropic/claude-haiku-4-5",
						normal: "anthropic/claude-sonnet-4-5",
						heavy: "anthropic/claude-opus-4-5",
					},
					secondary: { normal: "openrouter/anthropic/claude-sonnet-4.5" },
				},
				extensionConfig: {
					verify: { model: "openrouter/anthropic/claude-sonnet-4.5" },
				},
			},
		};
		const lines = renderLines(summary);

		expect(lines).toContain(
			"Background primary: fast=anthropic/claude-haiku-4-5, normal=anthropic/claude-sonnet-4-5, heavy=anthropic/claude-opus-4-5",
		);
		expect(lines).toContain(
			"Background secondary: normal=openrouter/anthropic/claude-sonnet-4.5",
		);
		expect(lines).toContain("Per-extension overrides:");
		expect(lines).toContain(
			"  verify: model=openrouter/anthropic/claude-sonnet-4.5",
		);
		expect(lines).toContain("Loaded extensions (2, by sourceInfo.path):");
		expect(lines).toContain("  /repo/packages/develop/index.ts");
		expect(lines).toContain("    commands: /develop, /implement");
		expect(lines).toContain("    tools: (none)");
		expect(lines).toContain("  /repo/packages/startup/index.ts");
		expect(lines).toContain("    commands: /loaded");
		expect(lines).toContain("    tools: greet");
	});
});
