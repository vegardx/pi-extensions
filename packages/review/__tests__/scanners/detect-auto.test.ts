/**
 * Per-spec `detectAuto` heuristics — covers the `enable: "auto"`
 * resolution path. Each spec's heuristic is tested against a tmpdir
 * fixture that simulates the relevant config / lockfile presence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { biomeSpec } from "../../scanners/typescript/biome.js";
import { eslintSpec } from "../../scanners/typescript/eslint.js";
import { gitleaksSpec } from "../../scanners/typescript/gitleaks.js";
import { knipSpec } from "../../scanners/typescript/knip.js";
import { madgeSpec } from "../../scanners/typescript/madge.js";
import { npmAuditSpec } from "../../scanners/typescript/npm-audit.js";
import { osvScannerSpec } from "../../scanners/typescript/osv-scanner.js";
import { semgrepSpec } from "../../scanners/typescript/semgrep.js";
import { tscSpec } from "../../scanners/typescript/tsc.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "scanner-detect-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function touch(rel: string, contents = ""): void {
	const path = join(tmp, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents);
}

describe("detectAuto", () => {
	describe("tsc", () => {
		it("true when tsconfig.json exists", () => {
			touch("tsconfig.json", "{}");
			expect(tscSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false when tsconfig.json absent", () => {
			expect(tscSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("biome", () => {
		it("true with biome.json", () => {
			touch("biome.json", "{}");
			expect(biomeSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with biome.jsonc", () => {
			touch("biome.jsonc", "{}");
			expect(biomeSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false otherwise", () => {
			expect(biomeSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("eslint", () => {
		it("true with flat config", () => {
			touch("eslint.config.js", "");
			expect(eslintSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with .eslintrc.json", () => {
			touch(".eslintrc.json", "{}");
			expect(eslintSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with bare .eslintrc", () => {
			touch(".eslintrc", "");
			expect(eslintSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false otherwise", () => {
			expect(eslintSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("knip", () => {
		it("true with knip.json", () => {
			touch("knip.json", "{}");
			expect(knipSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with knip key in package.json", () => {
			touch("package.json", JSON.stringify({ knip: { entry: ["src/*"] } }));
			expect(knipSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false when package.json has no knip key", () => {
			touch("package.json", JSON.stringify({ name: "x" }));
			expect(knipSpec.detectAuto?.(tmp)).toBe(false);
		});
		it("false on malformed package.json", () => {
			touch("package.json", "not json");
			expect(knipSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("madge", () => {
		it("true when local node_modules/.bin/madge present", () => {
			touch("node_modules/.bin/madge", "#!/bin/sh\n");
			expect(madgeSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false otherwise", () => {
			expect(madgeSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("npm-audit", () => {
		it("true with package.json + package-lock.json", () => {
			touch("package.json", "{}");
			touch("package-lock.json", "{}");
			expect(npmAuditSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false with only package.json", () => {
			touch("package.json", "{}");
			expect(npmAuditSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("osv-scanner", () => {
		it("true with package-lock.json", () => {
			touch("package-lock.json", "{}");
			expect(osvScannerSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with go.mod", () => {
			touch("go.mod", "module x\n");
			expect(osvScannerSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with Cargo.lock", () => {
			touch("Cargo.lock", "");
			expect(osvScannerSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false on bare repo", () => {
			expect(osvScannerSpec.detectAuto?.(tmp)).toBe(false);
		});
	});

	describe("gitleaks", () => {
		it("always true (binary probe gates execution)", () => {
			expect(gitleaksSpec.detectAuto?.(tmp)).toBe(true);
		});
	});

	describe("semgrep", () => {
		it("true with .semgrep.yml", () => {
			touch(".semgrep.yml", "");
			expect(semgrepSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("true with semgrep.yaml", () => {
			touch("semgrep.yaml", "");
			expect(semgrepSpec.detectAuto?.(tmp)).toBe(true);
		});
		it("false without config (default ruleset is too noisy to auto-enable)", () => {
			expect(semgrepSpec.detectAuto?.(tmp)).toBe(false);
		});
	});
});

describe("semgrep buildArgs", () => {
	it("uses default ruleset when no opts", () => {
		expect(semgrepSpec.buildArgs()).toEqual([
			"scan",
			"--config",
			"p/javascript",
			"--json",
			".",
		]);
	});

	it("uses default ruleset when rulesets empty", () => {
		expect(semgrepSpec.buildArgs({ rulesets: [] })).toEqual([
			"scan",
			"--config",
			"p/javascript",
			"--json",
			".",
		]);
	});

	it("emits one --config per ruleset", () => {
		expect(
			semgrepSpec.buildArgs({
				rulesets: ["p/typescript", "p/owasp-top-ten"],
			}),
		).toEqual([
			"scan",
			"--config",
			"p/typescript",
			"--config",
			"p/owasp-top-ten",
			"--json",
			".",
		]);
	});
});
