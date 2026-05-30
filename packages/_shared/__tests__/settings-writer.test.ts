/**
 * Round-trip tests for the raw settings writer used by `/extensions`
 * to flip per-extension `enabled` keys at project / global scope.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	readBackgroundModel,
	readExtensionConfigKey,
	settingsPath,
	writeBackgroundModel,
	writeExtensionConfigKey,
} from "../settings-writer.js";

describe("settings-writer", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-ext-sw-cwd-"));
		agentDir = mkdtempSync(join(tmpdir(), "pi-ext-sw-agent-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("settingsPath resolves project to <cwd>/.pi/settings.json", () => {
		expect(settingsPath("project", cwd)).toBe(
			join(cwd, ".pi", "settings.json"),
		);
	});

	it("settingsPath resolves global to <agentDir>/settings.json", () => {
		expect(settingsPath("global", cwd, agentDir)).toBe(
			join(agentDir, "settings.json"),
		);
	});

	it("creates a fresh project settings.json on write and reports previous=undefined", () => {
		const result = writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"enabled",
			true,
		);
		expect(result.path).toBe(join(cwd, ".pi", "settings.json"));
		expect(result.previous).toBeUndefined();
		const written = JSON.parse(readFileSync(result.path, "utf8"));
		expect(written).toEqual({
			extensionConfig: { modes: { enabled: true } },
		});
	});

	it("creates a fresh global settings.json on write", () => {
		const result = writeExtensionConfigKey(
			"global",
			cwd,
			"modes",
			"enabled",
			true,
			agentDir,
		);
		expect(result.path).toBe(join(agentDir, "settings.json"));
		const written = JSON.parse(readFileSync(result.path, "utf8"));
		expect(written).toEqual({
			extensionConfig: { modes: { enabled: true } },
		});
	});

	it("preserves unrelated top-level keys on write", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				defaultProvider: "anthropic",
				extensionConfig: {
					verify: { model: "openai/gpt-4o" },
					modes: { defaultMode: "plan" },
				},
			}),
		);
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.defaultProvider).toBe("anthropic");
		expect(written.extensionConfig.verify).toEqual({ model: "openai/gpt-4o" });
		expect(written.extensionConfig.modes).toEqual({
			defaultMode: "plan",
			enabled: true,
		});
	});

	it("reports the previous value when overwriting", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		const result = writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"enabled",
			false,
		);
		expect(result.previous).toBe(true);
	});

	it("removes the key when value is null and prunes empty entries", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		writeExtensionConfigKey("project", cwd, "modes", "enabled", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig).toBeUndefined();
	});

	it("keeps sibling keys on the same extension when removing one key", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		writeExtensionConfigKey("project", cwd, "modes", "defaultMode", "plan");
		writeExtensionConfigKey("project", cwd, "modes", "enabled", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.modes).toEqual({ defaultMode: "plan" });
	});

	it("keeps sibling extensions when removing the last key on one extension", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		writeExtensionConfigKey("project", cwd, "review", "enabled", true);
		writeExtensionConfigKey("project", cwd, "modes", "enabled", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig).toEqual({ review: { enabled: true } });
	});

	it("readExtensionConfigKey returns the value when present", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		expect(readExtensionConfigKey("project", cwd, "modes", "enabled")).toBe(
			true,
		);
	});

	it("readExtensionConfigKey returns undefined when the file is missing", () => {
		expect(readExtensionConfigKey("project", cwd, "modes", "enabled")).toBe(
			undefined,
		);
	});

	it("readExtensionConfigKey returns undefined when the key is missing", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		expect(
			readExtensionConfigKey("project", cwd, "modes", "defaultMode"),
		).toBeUndefined();
		expect(
			readExtensionConfigKey("project", cwd, "review", "enabled"),
		).toBeUndefined();
	});

	it("throws on a corrupt settings.json instead of silently overwriting it", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), "not json {{{");
		expect(() =>
			writeExtensionConfigKey("project", cwd, "modes", "enabled", true),
		).toThrow();
	});

	// -- nested (dot-notation) keys -----------------------------------------

	it("writes a dotted key as a nested object, not a literal property", () => {
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", true);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.modes).toEqual({ review: { enable: true } });
		expect(written.extensionConfig.modes["review.enable"]).toBeUndefined();
	});

	it("merges sibling nested keys under the same group", () => {
		writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"compaction.phaseTokens",
			10000,
		);
		writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"compaction.summaryTokens",
			100000,
		);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.modes.compaction).toEqual({
			phaseTokens: 10000,
			summaryTokens: 100000,
		});
	});

	it("reports the previous nested value on overwrite", () => {
		writeExtensionConfigKey("project", cwd, "modes", "mode.default", "plan");
		const result = writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"mode.default",
			"auto",
		);
		expect(result.previous).toBe("plan");
	});

	it("prunes an emptied nested group and entry when deleting the last nested key", () => {
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", true);
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig).toBeUndefined();
	});

	it("keeps sibling nested keys when deleting one", () => {
		writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"compaction.phaseTokens",
			10000,
		);
		writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"compaction.summaryTokens",
			100000,
		);
		writeExtensionConfigKey(
			"project",
			cwd,
			"modes",
			"compaction.phaseTokens",
			null,
		);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.modes.compaction).toEqual({
			summaryTokens: 100000,
		});
	});

	it("lets flat and nested keys coexist on one extension", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", true);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.modes).toEqual({
			enabled: true,
			review: { enable: true },
		});
	});

	it("deleting a nested key keeps a flat sibling", () => {
		writeExtensionConfigKey("project", cwd, "modes", "enabled", true);
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", true);
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.modes).toEqual({ enabled: true });
	});

	it("readExtensionConfigKey reads a dotted key", () => {
		writeExtensionConfigKey("project", cwd, "modes", "review.enable", true);
		expect(
			readExtensionConfigKey("project", cwd, "modes", "review.enable"),
		).toBe(true);
		expect(
			readExtensionConfigKey("project", cwd, "modes", "review.missing"),
		).toBeUndefined();
	});

	// -- string[] values ----------------------------------------------------

	it("writes and reads a string[] value", () => {
		writeExtensionConfigKey("project", cwd, "caffeinate", "flags", [
			"-i",
			"-m",
		]);
		expect(
			readExtensionConfigKey("project", cwd, "caffeinate", "flags"),
		).toEqual(["-i", "-m"]);
	});

	it("stores an explicitly empty array as [] (not deleted)", () => {
		writeExtensionConfigKey("project", cwd, "derp", "labels", []);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig.derp.labels).toEqual([]);
	});

	it("deletes an array key on null", () => {
		writeExtensionConfigKey("project", cwd, "derp", "labels", ["bug"]);
		writeExtensionConfigKey("project", cwd, "derp", "labels", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.extensionConfig).toBeUndefined();
	});

	it("refuses prototype-polluting key segments and does not pollute", () => {
		expect(() =>
			writeExtensionConfigKey("project", cwd, "modes", "__proto__.polluted", 1),
		).toThrow(/prototype-polluting/);
		expect(() =>
			writeExtensionConfigKey("project", cwd, "__proto__", "x", 1),
		).toThrow(/prototype-polluting/);
		// Object.prototype stayed clean.
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("refuses an empty key segment", () => {
		expect(() =>
			writeExtensionConfigKey("project", cwd, "modes", "a..b", 1),
		).toThrow(/empty key segment/);
	});
});

describe("settings-writer — background models", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-ext-bg-cwd-"));
		agentDir = mkdtempSync(join(tmpdir(), "pi-ext-bg-agent-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("writes a tier to a fresh project settings.json", () => {
		const result = writeBackgroundModel(
			"project",
			cwd,
			"primary",
			"fast",
			"anthropic/claude-haiku",
		);
		expect(result.path).toBe(join(cwd, ".pi", "settings.json"));
		expect(result.previous).toBeUndefined();
		const written = JSON.parse(readFileSync(result.path, "utf8"));
		expect(written).toEqual({
			backgroundModels: { primary: { fast: "anthropic/claude-haiku" } },
		});
	});

	it("writes a tier to a fresh global settings.json", () => {
		const result = writeBackgroundModel(
			"global",
			cwd,
			"secondary",
			"heavy",
			"openai/gpt-4o",
			agentDir,
		);
		expect(result.path).toBe(join(agentDir, "settings.json"));
		const written = JSON.parse(readFileSync(result.path, "utf8"));
		expect(written).toEqual({
			backgroundModels: { secondary: { heavy: "openai/gpt-4o" } },
		});
	});

	it("preserves sibling tiers and unrelated keys", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				defaultProvider: "anthropic",
				backgroundModels: { primary: { fast: "a/b", normal: "c/d" } },
				extensionConfig: { modes: { enabled: true } },
			}),
		);
		writeBackgroundModel("project", cwd, "primary", "heavy", "e/f");
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.defaultProvider).toBe("anthropic");
		expect(written.extensionConfig.modes).toEqual({ enabled: true });
		expect(written.backgroundModels.primary).toEqual({
			fast: "a/b",
			normal: "c/d",
			heavy: "e/f",
		});
	});

	it("reports previous value on overwrite", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "a/b");
		const result = writeBackgroundModel(
			"project",
			cwd,
			"primary",
			"fast",
			"c/d",
		);
		expect(result.previous).toBe("a/b");
	});

	it("removes the tier on null and prunes the empty set and backgroundModels", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "a/b");
		writeBackgroundModel("project", cwd, "primary", "fast", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.backgroundModels).toBeUndefined();
	});

	it("keeps sibling tiers when clearing one", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "a/b");
		writeBackgroundModel("project", cwd, "primary", "normal", "c/d");
		writeBackgroundModel("project", cwd, "primary", "fast", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.backgroundModels.primary).toEqual({ normal: "c/d" });
	});

	it("keeps sibling set when clearing the last tier of another set", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "a/b");
		writeBackgroundModel("project", cwd, "secondary", "fast", "c/d");
		writeBackgroundModel("project", cwd, "secondary", "fast", null);
		const written = JSON.parse(
			readFileSync(join(cwd, ".pi", "settings.json"), "utf8"),
		);
		expect(written.backgroundModels).toEqual({ primary: { fast: "a/b" } });
	});

	it("reads back a written tier and returns undefined for unset / missing", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "a/b");
		expect(readBackgroundModel("project", cwd, "primary", "fast")).toBe("a/b");
		expect(
			readBackgroundModel("project", cwd, "primary", "normal"),
		).toBeUndefined();
		expect(
			readBackgroundModel("global", cwd, "primary", "fast", agentDir),
		).toBeUndefined();
	});

	it("does NOT apply secondary→primary fallback on read", () => {
		writeBackgroundModel("project", cwd, "primary", "fast", "a/b");
		expect(
			readBackgroundModel("project", cwd, "secondary", "fast"),
		).toBeUndefined();
	});
});
