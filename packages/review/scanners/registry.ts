/**
 * Scanner registry — orchestrates probing, spawning and parsing across
 * a set of `ScannerSpec`s. Per-spec budgets are enforced via Node's
 * `spawnSync({ timeout })`. Probe / spawn failures and parse errors
 * are captured into `ScannerOutcome.error` so a slow or broken scanner
 * never blocks the rest of the pipeline.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	ScannerContext,
	ScannerOutcome,
	ScannerOverrides,
	ScannerSpec,
	SpawnResult,
} from "./types.js";

/** Default `probe`: prefer local `node_modules/.bin`, fall back to PATH. */
export function defaultProbe(name: string, cwd: string): string | null {
	const local = join(cwd, "node_modules", ".bin", name);
	if (existsSync(local)) return local;
	const r = spawnSync("which", [name], {
		encoding: "utf8",
		timeout: 3_000,
		stdio: "pipe",
	});
	if (r.status === 0 && r.stdout.trim()) return name;
	return null;
}

/** Default `spawn`: synchronous, combined output, hard timeout. */
export function defaultSpawn(
	bin: string,
	args: string[],
	timeoutMs: number,
	cwd: string,
): SpawnResult {
	const r = spawnSync(bin, args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: "pipe",
	});
	if (r.error) {
		return { output: "", status: null, spawnError: r.error.message };
	}
	const output = [r.stdout ?? "", r.stderr ?? ""].join("\n").trim();
	return { output, status: r.status };
}

/**
 * Build a default `ScannerContext` rooted at `cwd`. Tests construct
 * their own context with stubbed probe/spawn.
 */
export function defaultScannerContext(cwd: string): ScannerContext {
	return {
		cwd,
		probe: (name) => defaultProbe(name, cwd),
		spawn: (bin, args, timeout) => defaultSpawn(bin, args, timeout, cwd),
	};
}

/**
 * Run every spec, sequentially, in registration order. Disabled specs
 * skip probing and execution. Missing binaries, spawn failures,
 * non-zero-exit-with-no-output, and parser exceptions all collapse
 * into `outcome.error` — the loop never throws.
 */
export function runScanners(
	specs: readonly ScannerSpec[],
	ctx: ScannerContext,
	overrides: ScannerOverrides = {},
): ScannerOutcome[] {
	const outcomes: ScannerOutcome[] = [];

	for (const spec of specs) {
		const o = overrides[spec.id] ?? {};
		const enabled = o.enabled ?? spec.defaultEnabled;
		const budgetMs = o.budgetMs ?? spec.budgetMs;

		if (!enabled) {
			outcomes.push({
				spec,
				findings: [],
				available: false,
				enabled: false,
			});
			continue;
		}

		const bin = ctx.probe(spec.binary);
		if (!bin) {
			outcomes.push({
				spec,
				findings: [],
				available: false,
				enabled: true,
				error: `${spec.binary} not found in node_modules/.bin or PATH`,
			});
			continue;
		}

		const result = ctx.spawn(bin, spec.buildArgs(), budgetMs);

		if (result.spawnError) {
			outcomes.push({
				spec,
				findings: [],
				available: true,
				enabled: true,
				error: `spawn error: ${result.spawnError}`,
			});
			continue;
		}

		const output = result.output;
		if (!output) {
			if (result.status !== 0 && result.status !== null) {
				outcomes.push({
					spec,
					findings: [],
					available: true,
					enabled: true,
					error: `exited ${result.status} with no output`,
				});
				continue;
			}
			outcomes.push({
				spec,
				findings: [],
				available: true,
				enabled: true,
			});
			continue;
		}

		try {
			const findings = spec.parse(output);
			outcomes.push({
				spec,
				findings,
				available: true,
				enabled: true,
			});
		} catch (err) {
			outcomes.push({
				spec,
				findings: [],
				available: true,
				enabled: true,
				error: `parse error: ${
					err instanceof Error ? err.message : String(err)
				}`,
			});
		}
	}

	return outcomes;
}
