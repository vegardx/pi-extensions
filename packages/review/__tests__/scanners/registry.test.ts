/**
 * Tests for the scanner registry — `runScanners` orchestrates probe /
 * spawn / parse with per-spec budget enforcement, captures errors
 * into `outcome.error`, and never throws. Adapter parsers are covered
 * by the existing `static-checker.test.ts` (which now imports from
 * the registry's barrel).
 */

import { runScanners } from "../../scanners/registry.js";
import type {
	ScannerContext,
	ScannerOutcome,
	ScannerSpec,
	SpawnResult,
} from "../../scanners/types.js";

function makeSpec(over: Partial<ScannerSpec> = {}): ScannerSpec {
	return {
		id: "fake",
		languages: ["typescript"],
		lane: "code-reviewer",
		defaultEnabled: true,
		budgetMs: 1_000,
		binary: "fake",
		buildArgs: () => [],
		parse: () => [],
		...over,
	};
}

interface SpawnCall {
	bin: string;
	args: string[];
	timeoutMs: number;
}

function makeCtx(opts: {
	probe?: (binary: string) => string | null;
	spawn?: (bin: string, args: string[], timeoutMs: number) => SpawnResult;
	cwd?: string;
}): { ctx: ScannerContext; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const ctx: ScannerContext = {
		cwd: opts.cwd ?? "/tmp",
		probe: opts.probe ?? ((name) => `/path/to/${name}`),
		spawn:
			opts.spawn ??
			((bin, args, timeoutMs) => {
				calls.push({ bin, args, timeoutMs });
				return { output: "", status: 0 };
			}),
	};
	return { ctx, calls };
}

describe("runScanners", () => {
	it("returns one outcome per spec in registration order", () => {
		const a = makeSpec({ id: "a" });
		const b = makeSpec({ id: "b" });
		const c = makeSpec({ id: "c" });
		const { ctx } = makeCtx({});

		const out = runScanners([a, b, c], ctx);

		expect(out.map((o) => o.spec.id)).toEqual(["a", "b", "c"]);
	});

	it("skips disabled specs without probing", () => {
		const probed: string[] = [];
		const spec = makeSpec({ defaultEnabled: false });
		const { ctx } = makeCtx({
			probe: (name) => {
				probed.push(name);
				return `/x/${name}`;
			},
		});

		const out = runScanners([spec], ctx);

		expect(out[0]?.enabled).toBe(false);
		expect(out[0]?.available).toBe(false);
		expect(probed).toEqual([]);
	});

	it("respects override.enabled = true on default-disabled spec", () => {
		const spec = makeSpec({ id: "off-by-default", defaultEnabled: false });
		const { ctx, calls } = makeCtx({});

		const out = runScanners([spec], ctx, {
			"off-by-default": { enabled: true },
		});

		expect(out[0]?.enabled).toBe(true);
		expect(calls).toHaveLength(1);
	});

	it("respects override.enabled = false on default-enabled spec", () => {
		const spec = makeSpec({ id: "on-by-default" });
		const { ctx, calls } = makeCtx({});

		const out = runScanners([spec], ctx, {
			"on-by-default": { enabled: false },
		});

		expect(out[0]?.enabled).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("forwards override.budgetMs to spawn", () => {
		const spec = makeSpec({ budgetMs: 1_000 });
		const { ctx, calls } = makeCtx({});

		runScanners([spec], ctx, { fake: { budgetMs: 5_000 } });

		expect(calls[0]?.timeoutMs).toBe(5_000);
	});

	it("missing binary → outcome.available = false with error", () => {
		const spec = makeSpec({ binary: "ghostly" });
		const { ctx, calls } = makeCtx({ probe: () => null });

		const out = runScanners([spec], ctx);

		expect(out[0]?.available).toBe(false);
		expect(out[0]?.enabled).toBe(true);
		expect(out[0]?.error).toMatch(/ghostly not found/);
		expect(calls).toHaveLength(0);
	});

	it("spawn error → outcome.error captured, no throw", () => {
		const spec = makeSpec();
		const { ctx } = makeCtx({
			spawn: () => ({
				output: "",
				status: null,
				spawnError: "ETIMEDOUT",
			}),
		});

		const out = runScanners([spec], ctx);

		expect(out[0]?.findings).toEqual([]);
		expect(out[0]?.error).toBe("spawn error: ETIMEDOUT");
	});

	it("non-zero exit with no output → outcome.error", () => {
		const spec = makeSpec();
		const { ctx } = makeCtx({
			spawn: () => ({ output: "", status: 2 }),
		});

		const out = runScanners([spec], ctx);

		expect(out[0]?.error).toBe("exited 2 with no output");
	});

	it("zero exit with empty output → no findings, no error", () => {
		const spec = makeSpec();
		const { ctx } = makeCtx({
			spawn: () => ({ output: "", status: 0 }),
		});

		const out = runScanners([spec], ctx);

		expect(out[0]?.findings).toEqual([]);
		expect(out[0]?.error).toBeUndefined();
	});

	it("parser exception → outcome.error: parse error: <msg>", () => {
		const spec = makeSpec({
			parse: () => {
				throw new Error("bad json");
			},
		});
		const { ctx } = makeCtx({
			spawn: () => ({ output: "non-empty", status: 0 }),
		});

		const out = runScanners([spec], ctx);

		expect(out[0]?.findings).toEqual([]);
		expect(out[0]?.error).toBe("parse error: bad json");
	});

	it("happy path: parses output into findings", () => {
		const spec = makeSpec({
			parse: () => [
				{
					severity: "NOTE",
					file: "x.ts",
					title: "hi",
					description: "d",
					suggestedAction: "",
				},
			],
		});
		const { ctx } = makeCtx({
			spawn: () => ({ output: "data", status: 1 }),
		});

		const out = runScanners([spec], ctx);

		expect(out[0]?.findings).toHaveLength(1);
		expect(out[0]?.findings[0]?.title).toBe("hi");
		expect(out[0]?.error).toBeUndefined();
	});

	it("one broken spec does not stop subsequent specs", () => {
		const broken = makeSpec({
			id: "broken",
			parse: () => {
				throw new Error("boom");
			},
		});
		const ok = makeSpec({
			id: "ok",
			parse: () => [
				{
					severity: "NOTE",
					file: "x.ts",
					title: "ok",
					description: "",
					suggestedAction: "",
				},
			],
		});
		const { ctx } = makeCtx({
			spawn: () => ({ output: "x", status: 0 }),
		});

		const out: ScannerOutcome[] = runScanners([broken, ok], ctx);

		expect(out[0]?.error).toBe("parse error: boom");
		expect(out[1]?.findings).toHaveLength(1);
		expect(out[1]?.error).toBeUndefined();
	});

	it("uses spec.budgetMs when no override provided", () => {
		const spec = makeSpec({ budgetMs: 7_777 });
		const { ctx, calls } = makeCtx({});

		runScanners([spec], ctx);

		expect(calls[0]?.timeoutMs).toBe(7_777);
	});

	it("forwards spec.buildArgs() to spawn", () => {
		const spec = makeSpec({
			binary: "x",
			buildArgs: () => ["--flag", "value"],
		});
		const { ctx, calls } = makeCtx({});

		runScanners([spec], ctx);

		expect(calls[0]?.args).toEqual(["--flag", "value"]);
	});
});
