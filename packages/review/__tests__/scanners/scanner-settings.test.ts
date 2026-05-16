/**
 * Tests for `scanner-settings.ts` — the reader/resolver for the new
 * `extensionConfig.review.scanners` schema. Covers parsing, fail-closed
 * type validation, default-block merging, and `enable: "auto"`
 * resolution via `spec.detectAuto`.
 */

import type { RelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import {
	EMPTY_SCANNER_SETTINGS,
	hasScannerSettings,
	readScannerSettings,
	resolveScannerOverrides,
} from "../../scanners/scanner-settings.js";
import type { ScannerSpec } from "../../scanners/types.js";

function settings(extensionConfig: unknown): RelevantSettings {
	return { extensionConfig } as RelevantSettings;
}

function makeSpec(over: Partial<ScannerSpec> = {}): ScannerSpec {
	return {
		id: "fake",
		languages: ["typescript"],
		lane: "code-reviewer",
		defaultEnabled: false,
		budgetMs: 1_000,
		binary: "fake",
		buildArgs: () => [],
		parse: () => [],
		...over,
	};
}

describe("hasScannerSettings", () => {
	it("returns false when extensionConfig is missing", () => {
		expect(hasScannerSettings(settings(undefined))).toBe(false);
		expect(hasScannerSettings(settings({}))).toBe(false);
	});

	it("returns false when review.scanners is absent", () => {
		expect(
			hasScannerSettings(settings({ review: { staticAnalysis: {} } })),
		).toBe(false);
	});

	it("returns false when review.scanners is not an object", () => {
		expect(hasScannerSettings(settings({ review: { scanners: [] } }))).toBe(
			false,
		);
		expect(hasScannerSettings(settings({ review: { scanners: "no" } }))).toBe(
			false,
		);
	});

	it("returns true when review.scanners is an object", () => {
		expect(hasScannerSettings(settings({ review: { scanners: {} } }))).toBe(
			true,
		);
		expect(
			hasScannerSettings(
				settings({ review: { scanners: { tsc: { enable: true } } } }),
			),
		).toBe(true);
	});
});

describe("readScannerSettings", () => {
	it("returns empty when key absent or wrong shape", () => {
		expect(readScannerSettings(settings(undefined))).toEqual({ entries: {} });
		expect(readScannerSettings(settings({ review: 1 }))).toEqual({
			entries: {},
		});
		expect(
			readScannerSettings(settings({ review: { scanners: null } })),
		).toEqual({ entries: {} });
	});

	it("parses default block", () => {
		const out = readScannerSettings(
			settings({
				review: {
					scanners: {
						default: { enable: true, budgetMs: 5000 },
					},
				},
			}),
		);
		expect(out.default).toEqual({ enable: true, budgetMs: 5000 });
		expect(out.entries).toEqual({});
	});

	it("parses per-id entries with valid fields", () => {
		const out = readScannerSettings(
			settings({
				review: {
					scanners: {
						tsc: { enable: true, budgetMs: 10_000 },
						semgrep: {
							enable: "auto",
							args: { rulesets: ["p/owasp-top-ten", "p/typescript"] },
						},
					},
				},
			}),
		);
		expect(out.entries.tsc).toEqual({ enable: true, budgetMs: 10_000 });
		expect(out.entries.semgrep).toEqual({
			enable: "auto",
			args: { rulesets: ["p/owasp-top-ten", "p/typescript"] },
		});
	});

	it("drops entries with invalid types (fail-closed)", () => {
		const out = readScannerSettings(
			settings({
				review: {
					scanners: {
						tsc: { enable: "yes", budgetMs: -5 },
						biome: { enable: 1 },
						eslint: "nope",
					},
				},
			}),
		);
		expect(out.entries.tsc).toEqual({}); // both fields rejected, stays empty
		expect(out.entries.biome).toEqual({}); // enable: 1 rejected
		// eslint entry parsed as null → not in map
		expect(out.entries.eslint).toBeUndefined();
	});

	it("drops args when rulesets contains non-strings", () => {
		const out = readScannerSettings(
			settings({
				review: {
					scanners: {
						semgrep: {
							enable: true,
							args: { rulesets: ["p/typescript", 42] },
						},
					},
				},
			}),
		);
		expect(out.entries.semgrep).toEqual({ enable: true });
	});

	it("ignores unknown args fields", () => {
		const out = readScannerSettings(
			settings({
				review: {
					scanners: {
						semgrep: { enable: true, args: { unknownThing: "x" } },
					},
				},
			}),
		);
		expect(out.entries.semgrep).toEqual({ enable: true });
	});
});

describe("resolveScannerOverrides", () => {
	it("returns empty when no settings configured", () => {
		const specs = [makeSpec({ id: "tsc" })];
		expect(
			resolveScannerOverrides(specs, EMPTY_SCANNER_SETTINGS, "/cwd"),
		).toEqual({});
	});

	it("applies per-id overrides", () => {
		const specs = [makeSpec({ id: "tsc" })];
		const out = resolveScannerOverrides(
			specs,
			{ entries: { tsc: { enable: false, budgetMs: 2000 } } },
			"/cwd",
		);
		expect(out.tsc).toEqual({ enabled: false, budgetMs: 2000 });
	});

	it("falls back to default block", () => {
		const specs = [makeSpec({ id: "tsc" }), makeSpec({ id: "biome" })];
		const out = resolveScannerOverrides(
			specs,
			{ default: { enable: true, budgetMs: 5000 }, entries: {} },
			"/cwd",
		);
		expect(out.tsc).toEqual({ enabled: true, budgetMs: 5000 });
		expect(out.biome).toEqual({ enabled: true, budgetMs: 5000 });
	});

	it("per-id wins over default", () => {
		const specs = [makeSpec({ id: "tsc" }), makeSpec({ id: "biome" })];
		const out = resolveScannerOverrides(
			specs,
			{
				default: { enable: false, budgetMs: 5000 },
				entries: { tsc: { enable: true } },
			},
			"/cwd",
		);
		expect(out.tsc).toEqual({ enabled: true, budgetMs: 5000 });
		expect(out.biome).toEqual({ enabled: false, budgetMs: 5000 });
	});

	it("resolves enable:auto via spec.detectAuto", () => {
		const specs = [
			makeSpec({ id: "tsc", detectAuto: () => true }),
			makeSpec({ id: "biome", detectAuto: () => false }),
		];
		const out = resolveScannerOverrides(
			specs,
			{
				entries: {
					tsc: { enable: "auto" },
					biome: { enable: "auto" },
				},
			},
			"/cwd",
		);
		expect(out.tsc).toEqual({ enabled: true });
		expect(out.biome).toEqual({ enabled: false });
	});

	it("falls back to defaultEnabled when detectAuto absent", () => {
		const specs = [
			makeSpec({ id: "tsc", defaultEnabled: true }),
			makeSpec({ id: "biome", defaultEnabled: false }),
		];
		const out = resolveScannerOverrides(
			specs,
			{
				entries: {
					tsc: { enable: "auto" },
					biome: { enable: "auto" },
				},
			},
			"/cwd",
		);
		expect(out.tsc).toEqual({ enabled: true });
		expect(out.biome).toEqual({ enabled: false });
	});

	it("threads args through", () => {
		const specs = [makeSpec({ id: "semgrep" })];
		const out = resolveScannerOverrides(
			specs,
			{
				entries: {
					semgrep: {
						enable: true,
						args: { rulesets: ["p/typescript"] },
					},
				},
			},
			"/cwd",
		);
		expect(out.semgrep).toEqual({
			enabled: true,
			args: { rulesets: ["p/typescript"] },
		});
	});

	it("passes cwd through to detectAuto", () => {
		const seen: string[] = [];
		const specs = [
			makeSpec({
				id: "tsc",
				detectAuto: (cwd) => {
					seen.push(cwd);
					return true;
				},
			}),
		];
		resolveScannerOverrides(
			specs,
			{ entries: { tsc: { enable: "auto" } } },
			"/some/path",
		);
		expect(seen).toEqual(["/some/path"]);
	});

	it("emits no override entry when neither id nor default supplies fields", () => {
		const specs = [makeSpec({ id: "tsc" })];
		const out = resolveScannerOverrides(
			specs,
			{ default: {}, entries: { tsc: {} } },
			"/cwd",
		);
		expect(out).toEqual({});
	});
});
