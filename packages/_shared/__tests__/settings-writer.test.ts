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
	readExtensionConfigKey,
	settingsPath,
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
});
