/**
 * Scanner registry contract — shared types for Phase 0 deterministic
 * scanners. Each adapter under `scanners/<language>/<tool>.ts` exports
 * a `ScannerSpec` constant; `registry.runScanners(...)` orchestrates
 * probing + spawning + parsing with per-spec budget enforcement.
 *
 * No behaviour change vs. the previous flat `static-checker.ts`; this
 * is the substrate 166b/c will plug new adapters and per-scanner
 * config into.
 */

import type { RawFinding, ReviewerRole } from "../findings.js";

export type LanguageId =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "any";

/** Reviewer lane the scanner's findings feed into. */
export type ScannerLane = Extract<
	ReviewerRole,
	"code-reviewer" | "security-analyst" | "code-simplifier"
>;

/** Result of spawning a tool binary. */
export interface SpawnResult {
	/** Combined stdout + stderr, trimmed. */
	output: string;
	/** Process exit status. `null` when the spawn failed (ENOENT / timeout). */
	status: number | null;
	/** Populated when Node's spawnSync surfaced an error (incl. timeouts). */
	spawnError?: string;
}

/**
 * Execution context passed to every scanner. Probing and spawning are
 * injected so tests can drive the registry deterministically without
 * touching the filesystem or spawning real processes.
 */
export interface ScannerContext {
	cwd: string;
	/** Probe a binary by name. Returns absolute path or null when missing. */
	probe: (binary: string) => string | null;
	/** Spawn a binary with a hard timeout (ms). */
	spawn: (bin: string, args: string[], timeoutMs: number) => SpawnResult;
}

export interface ScannerSpec {
	/** Stable identifier — also the config key under `extensionConfig.review.scanners`. */
	id: string;
	/** Languages this scanner is relevant to. */
	languages: readonly LanguageId[];
	/** Reviewer lane that consumes the findings. */
	lane: ScannerLane;
	/** Default enabled state when no per-scanner config exists. */
	defaultEnabled: boolean;
	/** Hard timeout (ms) per run. */
	budgetMs: number;
	/** Binary name to probe via `node_modules/.bin/<name>` then PATH. */
	binary: string;
	/** Argv builder. Pure; no I/O. */
	buildArgs: () => string[];
	/** Parser for combined stdout+stderr. May throw — registry catches. */
	parse: (raw: string) => RawFinding[];
}

/** Outcome of running one scanner spec. */
export interface ScannerOutcome {
	spec: ScannerSpec;
	findings: RawFinding[];
	/** Was the binary on disk? */
	available: boolean;
	/** Was the spec enabled (default ∨ override)? */
	enabled: boolean;
	/** Populated when probe/spawn/parse failed. */
	error?: string;
}

/** Per-scanner overrides keyed by `ScannerSpec.id`. */
export interface ScannerOverrides {
	[id: string]: {
		enabled?: boolean;
		budgetMs?: number;
	};
}
