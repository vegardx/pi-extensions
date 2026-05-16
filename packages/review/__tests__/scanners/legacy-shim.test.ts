/**
 * Smoke test: the legacy `runStaticAnalysis` shim in
 * `static-checker.ts` calls into `runScanners` and reconstructs the
 * documented `StaticAnalysisResult` shape that `auto-review.ts`
 * consumes. This locks down the back-compat boundary while the
 * underlying registry can evolve.
 */

import { runStaticAnalysis } from "../../static-checker.js";

describe("runStaticAnalysis (back-compat shim over scanner registry)", () => {
	it("returns a StaticAnalysisResult with byLane + toolResults", async () => {
		// Run against a tmp dir that has no node_modules and likely no
		// global tools either — every scanner should report `available:
		// false` without throwing.
		const result = await runStaticAnalysis("/tmp", {
			tsc: { enabled: false },
			biome: { enabled: false },
			eslint: { enabled: false },
			knip: { enabled: false },
			npmAudit: { enabled: false },
			semgrep: { enabled: false },
		});

		expect(result.byLane).toBeInstanceOf(Map);
		expect(Array.isArray(result.toolResults)).toBe(true);
		expect(result.toolResults).toHaveLength(6);

		const ids = result.toolResults.map((r) => r.tool).sort();
		expect(ids).toEqual([
			"biome",
			"eslint",
			"knip",
			"npmAudit",
			"semgrep",
			"tsc",
		]);

		for (const r of result.toolResults) {
			expect(r.enabled).toBe(false);
			expect(r.available).toBe(false);
			expect(r.findings).toEqual([]);
		}
	});

	it("preserves legacy camelCase tool name `npmAudit` (not kebab)", async () => {
		const result = await runStaticAnalysis("/tmp", {
			tsc: { enabled: false },
			biome: { enabled: false },
			eslint: { enabled: false },
			knip: { enabled: false },
			npmAudit: { enabled: false },
			semgrep: { enabled: false },
		});

		const names = result.toolResults.map((r) => r.tool);
		expect(names).toContain("npmAudit");
		expect(names).not.toContain("npm-audit");
	});

	it("maps scanner.lane onto StaticToolResult.lane unchanged", async () => {
		const result = await runStaticAnalysis("/tmp", {
			tsc: { enabled: false },
			biome: { enabled: false },
			eslint: { enabled: false },
			knip: { enabled: false },
			npmAudit: { enabled: false },
			semgrep: { enabled: false },
		});

		const lane = (id: string) =>
			result.toolResults.find((r) => r.tool === id)?.lane;

		expect(lane("tsc")).toBe("code-reviewer");
		expect(lane("biome")).toBe("code-reviewer");
		expect(lane("eslint")).toBe("code-reviewer");
		expect(lane("knip")).toBe("code-simplifier");
		expect(lane("npmAudit")).toBe("security-analyst");
		expect(lane("semgrep")).toBe("security-analyst");
	});
});
