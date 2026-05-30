/**
 * Snapshot builder for `/extensions` dialog rows.
 *
 * The dialog state machine is tested in `extensions-dialog-state.test.ts`;
 * this file covers the disk join: that we read both project and
 * global settings.json files, attribute values to the right scope,
 * and pass through metadata correctly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionMetadata } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRows } from "../config-dialog/build-rows.js";

const META: ExtensionMetadata[] = [
	{
		name: "modes",
		path: fileURLToPath(import.meta.url),
		doc: "Mode switching",
		integratesWith: ["commit", "review"],
		enabled: true,
		enabledSource: "project",
		loadState: "loaded",
	},
	{
		name: "commit",
		path: fileURLToPath(import.meta.url),
		doc: "Commit workflow",
		integratesWith: ["review"],
		enabled: false,
		enabledSource: "default",
		loadState: "disabled-by-config",
	},
];

describe("buildRows", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-ext-rows-cwd-"));
		agentDir = mkdtempSync(join(tmpdir(), "pi-ext-rows-agent-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("returns rows sorted alphabetically by name", () => {
		const rows = buildRows({ cwd, agentDir, declared: META });
		expect(rows.map((r) => r.name)).toEqual(["commit", "modes"]);
	});

	it("reports null for both scopes when neither file has the key", () => {
		const rows = buildRows({ cwd, agentDir, declared: META });
		const modes = rows.find((r) => r.name === "modes");
		expect(modes?.project).toBeNull();
		expect(modes?.global).toBeNull();
	});

	it("reads project settings from <cwd>/.pi/settings.json", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({ extensionConfig: { modes: { enabled: true } } }),
		);
		const rows = buildRows({ cwd, agentDir, declared: META });
		expect(rows.find((r) => r.name === "modes")?.project).toBe(true);
	});

	it("reads global settings from <agentDir>/settings.json", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ extensionConfig: { commit: { enabled: false } } }),
		);
		const rows = buildRows({ cwd, agentDir, declared: META });
		expect(rows.find((r) => r.name === "commit")?.global).toBe(false);
	});

	it("treats non-boolean values as null (typo-tolerant)", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				extensionConfig: { modes: { enabled: "true" } },
			}),
		);
		const rows = buildRows({ cwd, agentDir, declared: META });
		expect(rows.find((r) => r.name === "modes")?.project).toBeNull();
	});

	it("passes through dependsOn/integratesWith/effectiveSource from metadata", () => {
		const rows = buildRows({ cwd, agentDir, declared: META });
		const modes = rows.find((r) => r.name === "modes");
		expect(modes?.integratesWith).toEqual(["commit", "review"]);
		expect(modes?.dependsOn).toEqual([]);
		expect(modes?.effective).toBe(true);
		expect(modes?.effectiveSource).toBe("project");
		const commit = rows.find((r) => r.name === "commit");
		expect(commit?.effective).toBe(false);
		expect(commit?.effectiveSource).toBe("default");
	});
});
