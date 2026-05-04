import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getExtensionModelOverride,
	getTierModel,
	readRelevantSettings,
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

	it("picks up backgroundModels from project settings", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					backgroundModels: {
						fast: "anthropic/haiku",
						normal: "anthropic/sonnet",
					},
				});
				expect(readRelevantSettings(cwd)).toEqual({
					backgroundModels: {
						fast: "anthropic/haiku",
						normal: "anthropic/sonnet",
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
						nitpick: { model: "openai/gpt-4o-mini" },
						"prompt-suggestion": { model: "anthropic/haiku" },
					},
				});
				const r = readRelevantSettings(cwd);
				expect(r.extensionConfig?.nitpick?.model).toBe("openai/gpt-4o-mini");
				expect(r.extensionConfig?.["prompt-suggestion"]?.model).toBe(
					"anthropic/haiku",
				);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("merges global and project, with project overriding global", () => {
		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeGlobalSettings({
					backgroundModels: {
						fast: "anthropic/haiku",
						normal: "anthropic/sonnet",
						heavy: "anthropic/opus",
					},
					extensionConfig: {
						nitpick: { model: "anthropic/sonnet" },
					},
				});
				writeProjectSettings(cwd, {
					backgroundModels: { normal: "openai/gpt-4o" },
					extensionConfig: {
						"prompt-suggestion": { model: "openai/gpt-4o-mini" },
					},
				});

				const r = readRelevantSettings(cwd);
				expect(r.backgroundModels).toEqual({
					fast: "anthropic/haiku", // from global
					normal: "openai/gpt-4o", // project overrides global
					heavy: "anthropic/opus", // from global
				});
				expect(r.extensionConfig?.nitpick?.model).toBe("anthropic/sonnet");
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
						fast: 42, // wrong type
						normal: "anthropic/sonnet",
					},
					extensionConfig: {
						nitpick: "not an object", // wrong shape
						"prompt-suggestion": { model: "anthropic/haiku" },
					},
				});
				const r = readRelevantSettings(cwd);
				expect(r.backgroundModels).toEqual({ normal: "anthropic/sonnet" });
				expect(r.extensionConfig?.nitpick).toBeUndefined();
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
		expect(getExtensionModelOverride({}, "nitpick")).toBeUndefined();
	});

	it("getExtensionModelOverride returns the configured model", () => {
		expect(
			getExtensionModelOverride(
				{ extensionConfig: { nitpick: { model: "x/y" } } },
				"nitpick",
			),
		).toBe("x/y");
	});

	it("getTierModel returns undefined when nothing is set", () => {
		expect(getTierModel({}, "fast")).toBeUndefined();
	});

	it("getTierModel returns the configured model for the tier", () => {
		expect(getTierModel({ backgroundModels: { fast: "x/y" } }, "fast")).toBe(
			"x/y",
		);
	});
});
