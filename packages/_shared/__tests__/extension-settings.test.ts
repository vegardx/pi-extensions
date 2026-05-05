import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getExtensionModelOverride,
	getTierModel,
	readRelevantSettings,
	readRelevantSettingsLayered,
} from "../extension-settings.js";

function mkTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-ext-settings-test-"));
}

function writeProjectSettings(cwd: string, body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body));
}

function withIsolatedAgentDir<T>(fn: () => T): T {
	// Point PI_CODING_AGENT_DIR at an empty tmpdir so the test can't
	// accidentally read the developer's real ~/.pi/agent/settings.json.
	// This is the same env var pi itself honors via getAgentDir().
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-settings-test-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeGlobalSettings(body: unknown): void {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) throw new Error("PI_CODING_AGENT_DIR must be set for this helper");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(body));
}

describe("readRelevantSettings", () => {
	it("returns an empty object when nothing is configured", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				expect(readRelevantSettings(cwd)).toEqual({});
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("ignores keys pi cares about that we don't", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					defaultProvider: "anthropic",
					defaultModel: "claude-sonnet-4-5",
					theme: "dark",
					packages: ["git:github.com/user/repo"],
				});
				expect(readRelevantSettings(cwd)).toEqual({});
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("picks up backgroundModels.primary from project settings", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					backgroundModels: {
						primary: {
							fast: "anthropic/haiku",
							normal: "anthropic/sonnet",
						},
					},
				});
				expect(readRelevantSettings(cwd)).toEqual({
					backgroundModels: {
						primary: {
							fast: "anthropic/haiku",
							normal: "anthropic/sonnet",
						},
					},
				});
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("picks up backgroundModels.secondary from project settings", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					backgroundModels: {
						primary: { normal: "anthropic/sonnet" },
						secondary: { normal: "openai/gpt-4o" },
					},
				});
				expect(readRelevantSettings(cwd)).toEqual({
					backgroundModels: {
						primary: { normal: "anthropic/sonnet" },
						secondary: { normal: "openai/gpt-4o" },
					},
				});
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("picks up extensionConfig.<name>.model from project settings", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: {
						verify: { model: "openai/gpt-4o-mini" },
						"prompt-suggestion": { model: "anthropic/haiku" },
					},
				});
				const r = readRelevantSettings(cwd);
				expect(r.extensionConfig?.verify?.model).toBe("openai/gpt-4o-mini");
				expect(r.extensionConfig?.["prompt-suggestion"]?.model).toBe(
					"anthropic/haiku",
				);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("merges global and project, with project overriding global per-set per-tier", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeGlobalSettings({
					backgroundModels: {
						primary: {
							fast: "anthropic/haiku",
							normal: "anthropic/sonnet",
							heavy: "anthropic/opus",
						},
						secondary: {
							normal: "openai/gpt-4o",
						},
					},
					extensionConfig: {
						verify: { model: "anthropic/sonnet" },
					},
				});
				writeProjectSettings(cwd, {
					backgroundModels: {
						primary: { normal: "openai/gpt-4o" },
						secondary: { heavy: "openai/o1" },
					},
					extensionConfig: {
						"prompt-suggestion": { model: "openai/gpt-4o-mini" },
					},
				});

				const r = readRelevantSettings(cwd);
				expect(r.backgroundModels?.primary).toEqual({
					fast: "anthropic/haiku", // from global
					normal: "openai/gpt-4o", // project overrides global
					heavy: "anthropic/opus", // from global
				});
				expect(r.backgroundModels?.secondary).toEqual({
					normal: "openai/gpt-4o", // from global
					heavy: "openai/o1", // from project
				});
				expect(r.extensionConfig?.verify?.model).toBe("anthropic/sonnet");
				expect(r.extensionConfig?.["prompt-suggestion"]?.model).toBe(
					"openai/gpt-4o-mini",
				);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("treats malformed JSON as absent rather than throwing", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				writeFileSync(join(cwd, ".pi", "settings.json"), "{ this is not json");
				expect(() => readRelevantSettings(cwd)).not.toThrow();
				expect(readRelevantSettings(cwd)).toEqual({});
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("skips malformed entries inside an otherwise-valid file", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					backgroundModels: {
						primary: {
							fast: 42, // wrong type
							normal: "anthropic/sonnet",
						},
						secondary: "not an object", // wrong shape
					},
					extensionConfig: {
						verify: "not an object", // wrong shape
						"prompt-suggestion": { model: "anthropic/haiku" },
					},
				});
				const r = readRelevantSettings(cwd);
				expect(r.backgroundModels?.primary).toEqual({
					normal: "anthropic/sonnet",
				});
				expect(r.backgroundModels?.secondary).toBeUndefined();
				expect(r.extensionConfig?.verify).toBeUndefined();
				expect(r.extensionConfig?.["prompt-suggestion"]?.model).toBe(
					"anthropic/haiku",
				);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});

describe("helpers", () => {
	it("getExtensionModelOverride returns undefined when nothing is set", () => {
		expect(getExtensionModelOverride({}, "verify")).toBeUndefined();
	});

	it("getExtensionModelOverride returns the configured model", () => {
		expect(
			getExtensionModelOverride(
				{ extensionConfig: { verify: { model: "x/y" } } },
				"verify",
			),
		).toBe("x/y");
	});

	it("getTierModel returns undefined when nothing is set", () => {
		expect(getTierModel({}, "fast")).toBeUndefined();
	});

	it("getTierModel returns the configured model for the primary set by default", () => {
		expect(
			getTierModel({ backgroundModels: { primary: { fast: "x/y" } } }, "fast"),
		).toBe("x/y");
	});

	it("getTierModel reads from secondary when requested", () => {
		expect(
			getTierModel(
				{
					backgroundModels: {
						primary: { fast: "p/p" },
						secondary: { fast: "s/s" },
					},
				},
				"fast",
				"secondary",
			),
		).toBe("s/s");
	});

	it("getTierModel falls back to primary when secondary lacks the tier", () => {
		expect(
			getTierModel(
				{
					backgroundModels: {
						primary: { fast: "p/p", normal: "p/n" },
						secondary: { fast: "s/s" }, // no `normal`
					},
				},
				"normal",
				"secondary",
			),
		).toBe("p/n");
	});

	it("getTierModel returns undefined when both primary and secondary lack the tier", () => {
		expect(
			getTierModel(
				{ backgroundModels: { primary: { fast: "p/p" } } },
				"normal",
				"secondary",
			),
		).toBeUndefined();
	});

	it("getTierModel does NOT fall through to secondary when primary lacks the tier", () => {
		// The fallback rule is asymmetric — secondary uses primary as a
		// sensible default, but primary is the explicit choice, so a
		// missing primary tier shouldn't quietly use secondary.
		expect(
			getTierModel(
				{ backgroundModels: { secondary: { fast: "s/s" } } },
				"fast",
				"primary",
			),
		).toBeUndefined();
	});
});

describe("readRelevantSettingsLayered", () => {
	it("returns three empty objects when nothing is configured", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				const layered = readRelevantSettingsLayered(cwd);
				expect(layered.global).toEqual({});
				expect(layered.project).toEqual({});
				expect(layered.merged).toEqual({});
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("keeps global and project slices separate while merging into `merged`", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeGlobalSettings({
					backgroundModels: {
						primary: { fast: "g/fast", normal: "g/normal" },
					},
					extensionConfig: {
						verify: { model: "g/verify", maxParallel: 4 },
					},
				});
				writeProjectSettings(cwd, {
					backgroundModels: { primary: { fast: "p/fast" } },
					extensionConfig: { verify: { model: "p/verify" } },
				});

				const layered = readRelevantSettingsLayered(cwd);

				expect(layered.global.backgroundModels?.primary).toEqual({
					fast: "g/fast",
					normal: "g/normal",
				});
				expect(layered.global.extensionConfig?.verify?.model).toBe("g/verify");
				expect(layered.project.backgroundModels?.primary).toEqual({
					fast: "p/fast",
				});
				expect(layered.project.extensionConfig?.verify?.model).toBe("p/verify");

				// merged: project overrides global at the leaf level.
				expect(layered.merged.backgroundModels?.primary).toEqual({
					fast: "p/fast",
					normal: "g/normal",
				});
				expect(layered.merged.extensionConfig?.verify?.model).toBe("p/verify");
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("`merged` matches what readRelevantSettings returns", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeGlobalSettings({
					extensionConfig: { verify: { model: "g/x" } },
				});
				writeProjectSettings(cwd, {
					extensionConfig: {
						"prompt-suggestion": { model: "p/y" },
					},
				});

				const layered = readRelevantSettingsLayered(cwd);
				expect(layered.merged).toEqual(readRelevantSettings(cwd));
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});
