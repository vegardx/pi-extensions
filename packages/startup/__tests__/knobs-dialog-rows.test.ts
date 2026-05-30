/**
 * Disk join for the `/config` Settings page rows.
 *
 * The editing state machine lives in `knobs-state.test.ts`; this file
 * covers `readKnobRows`: gathering every declared extension's
 * configSchema, sorting by extension, reading dotted keys from both
 * settings layers, and coercing raw values to ScopedValue.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionMetadata } from "@vegardx/pi-extensions-shared/extension-metadata.js";

import { readKnobRows } from "../config-dialog/build-rows.js";

const path = fileURLToPath(import.meta.url);

const META: ExtensionMetadata[] = [
	{
		name: "modes",
		path,
		configSchema: [
			{
				key: "mode.default",
				type: "enum",
				enumValues: ["plan", "auto"],
				doc: "d",
			},
			{ key: "review.enable", type: "boolean", default: false, doc: "d" },
		],
	},
	{
		name: "derp",
		path,
		configSchema: [
			{ key: "polish.timeoutMs", type: "number", default: 30000, doc: "d" },
		],
	},
	{ name: "no-schema", path },
];

describe("readKnobRows", () => {
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-ext-knobs-cwd-"));
		agentDir = mkdtempSync(join(tmpdir(), "pi-ext-knobs-agent-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("flattens schemas sorted by extension, skipping extensions with none", () => {
		const rows = readKnobRows({ cwd, agentDir, declared: META });
		expect(rows.map((r) => `${r.extName}.${r.key}`)).toEqual([
			"derp.polish.timeoutMs",
			"modes.mode.default",
			"modes.review.enable",
		]);
	});

	it("reads dotted keys from project and global layers", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				extensionConfig: { modes: { mode: { default: "auto" } } },
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				extensionConfig: { modes: { review: { enable: true } } },
			}),
		);
		const rows = readKnobRows({ cwd, agentDir, declared: META });
		const modeDefault = rows.find((r) => r.key === "mode.default");
		const reviewEnable = rows.find((r) => r.key === "review.enable");
		expect(modeDefault?.project).toBe("auto");
		expect(modeDefault?.global).toBeNull();
		expect(reviewEnable?.global).toBe(true);
		expect(reviewEnable?.project).toBeNull();
	});

	it("coerces malformed values (object/mixed array) to null", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "settings.json"),
			JSON.stringify({
				extensionConfig: { derp: { polish: { timeoutMs: { nope: 1 } } } },
			}),
		);
		const rows = readKnobRows({ cwd, agentDir, declared: META });
		expect(rows.find((r) => r.key === "polish.timeoutMs")?.project).toBeNull();
	});

	it("carries schema metadata (type, default, enumValues, doc) onto rows", () => {
		const rows = readKnobRows({ cwd, agentDir, declared: META });
		const modeDefault = rows.find((r) => r.key === "mode.default");
		expect(modeDefault?.type).toBe("enum");
		expect(modeDefault?.enumValues).toEqual(["plan", "auto"]);
		const timeout = rows.find((r) => r.key === "polish.timeoutMs");
		expect(timeout?.default).toBe(30000);
	});
});
