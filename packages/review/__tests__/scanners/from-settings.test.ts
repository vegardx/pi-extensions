/**
 * `runStaticAnalysisFromSettings` — settings-aware entry point that
 * picks between the new `extensionConfig.review.scanners` schema and
 * the legacy `extensionConfig.review.staticAnalysis`. These tests
 * cover both branches plus the precedence between them.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { runStaticAnalysisFromSettings } from "../../static-checker.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "from-settings-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function settings(extensionConfig: unknown): RelevantSettings {
	return { extensionConfig } as RelevantSettings;
}

describe("runStaticAnalysisFromSettings", () => {
	it("uses new scanners schema when present", async () => {
		// Disable every tool via the new schema.
		const cfg = settings({
			review: {
				scanners: {
					default: { enable: false },
				},
			},
		});
		const result = await runStaticAnalysisFromSettings(cwd, cfg);
		expect(result.toolResults).toHaveLength(9);
		for (const r of result.toolResults) {
			expect(r.enabled).toBe(false);
			expect(r.available).toBe(false);
		}
	});

	it('auto-resolves enable: "auto" via spec.detectAuto', async () => {
		// Only tsc should auto-enable (tsconfig.json present); no other
		// scanner has its detector trigger. Binaries are absent so
		// available=false, but enabled=true is what we're locking down.
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		const cfg = settings({
			review: {
				scanners: {
					default: { enable: "auto" },
				},
			},
		});
		const result = await runStaticAnalysisFromSettings(cwd, cfg);
		const tsc = result.toolResults.find((r) => r.tool === "tsc");
		const biome = result.toolResults.find((r) => r.tool === "biome");
		expect(tsc?.enabled).toBe(true);
		expect(biome?.enabled).toBe(false);
	});

	it("falls back to legacy staticAnalysis when scanners absent", async () => {
		const cfg = settings({
			review: {
				staticAnalysis: {
					tsc: { enabled: false },
					biome: { enabled: false },
				},
			},
		});
		const result = await runStaticAnalysisFromSettings(cwd, cfg);
		const tsc = result.toolResults.find((r) => r.tool === "tsc");
		const biome = result.toolResults.find((r) => r.tool === "biome");
		expect(tsc?.enabled).toBe(false);
		expect(biome?.enabled).toBe(false);
	});

	it("legacy explicit override wins when passed alongside (legacy path)", async () => {
		// No new schema → legacy explicit override drives behaviour.
		const result = await runStaticAnalysisFromSettings(
			cwd,
			settings(undefined),
			{ tsc: { enabled: false } },
		);
		const tsc = result.toolResults.find((r) => r.tool === "tsc");
		expect(tsc?.enabled).toBe(false);
	});

	it("new schema wins over legacy explicit override (new path)", async () => {
		// Both supplied: new schema enables tsc, legacy override disables.
		// New path is preferred so tsc.enabled should be true.
		const cfg = settings({
			review: {
				scanners: {
					tsc: { enable: true },
				},
			},
		});
		const result = await runStaticAnalysisFromSettings(cwd, cfg, {
			tsc: { enabled: false },
		});
		const tsc = result.toolResults.find((r) => r.tool === "tsc");
		expect(tsc?.enabled).toBe(true);
	});

	it("budgetMs threads through new schema", async () => {
		// Hard to assert directly without spawn; the registry path will
		// pass `budgetMs` to spawn but we just smoke-test it parses
		// without throwing.
		const cfg = settings({
			review: {
				scanners: {
					default: { enable: false, budgetMs: 5000 },
				},
			},
		});
		await expect(
			runStaticAnalysisFromSettings(cwd, cfg),
		).resolves.toBeDefined();
	});
});
