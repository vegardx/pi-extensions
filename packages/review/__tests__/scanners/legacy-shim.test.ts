/**
 * Smoke test: the legacy `runStaticAnalysis` shim in
 * `static-checker.ts` calls into `runScanners` and reconstructs the
 * documented `StaticAnalysisResult` shape that `auto-review.ts`
 * consumes. This locks down the back-compat boundary while the
 * underlying registry can evolve.
 */

import type { StaticAnalysisConfig } from "../../static-checker.js";
import { runStaticAnalysis } from "../../static-checker.js";

const ALL_DISABLED: StaticAnalysisConfig = {
	tsc: { enabled: false },
	biome: { enabled: false },
	eslint: { enabled: false },
	knip: { enabled: false },
	madge: { enabled: false },
	npmAudit: { enabled: false },
	osvScanner: { enabled: false },
	gitleaks: { enabled: false },
	semgrep: { enabled: false },
};

describe("runStaticAnalysis (back-compat shim over scanner registry)", () => {
	it("returns a StaticAnalysisResult with byLane + toolResults for all 9 tools", async () => {
		// Run against a tmp dir with no tools available — every scanner
		// should report available=false without throwing.
		const result = await runStaticAnalysis("/tmp", ALL_DISABLED);

		expect(result.byLane).toBeInstanceOf(Map);
		expect(Array.isArray(result.toolResults)).toBe(true);
		expect(result.toolResults).toHaveLength(9);

		const ids = result.toolResults.map((r) => r.tool).sort();
		expect(ids).toEqual([
			"biome",
			"eslint",
			"gitleaks",
			"knip",
			"madge",
			"npmAudit",
			"osvScanner",
			"semgrep",
			"tsc",
		]);

		for (const r of result.toolResults) {
			expect(r.enabled).toBe(false);
			expect(r.available).toBe(false);
			expect(r.findings).toEqual([]);
		}
	});

	it("preserves legacy camelCase tool names (npmAudit, osvScanner, not kebab-case)", async () => {
		const result = await runStaticAnalysis("/tmp", ALL_DISABLED);

		const names = result.toolResults.map((r) => r.tool);
		expect(names).toContain("npmAudit");
		expect(names).toContain("osvScanner");
		expect(names).not.toContain("npm-audit");
		expect(names).not.toContain("osv-scanner");
	});

	it("maps scanner.lane onto StaticToolResult.lane unchanged", async () => {
		const result = await runStaticAnalysis("/tmp", ALL_DISABLED);

		const lane = (id: string) =>
			result.toolResults.find((r) => r.tool === id)?.lane;

		expect(lane("tsc")).toBe("code-reviewer");
		expect(lane("biome")).toBe("code-reviewer");
		expect(lane("eslint")).toBe("code-reviewer");
		expect(lane("knip")).toBe("code-simplifier");
		expect(lane("madge")).toBe("code-simplifier");
		expect(lane("npmAudit")).toBe("security-analyst");
		expect(lane("osvScanner")).toBe("security-analyst");
		expect(lane("gitleaks")).toBe("security-analyst");
		expect(lane("semgrep")).toBe("security-analyst");
	});
});
