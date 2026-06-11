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

import type { RawFinding } from "../findings.js";

export type LanguageId =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust"
	| "any";

/**
 * Lane the scanner's findings feed into. Historic role names kept as
 * opaque registry keys; `run-reviewer.ts` maps them onto lenses.
 */
export type ScannerLane =
	| "code-reviewer"
	| "security-analyst"
	| "code-simplifier";

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

/**
 * Optional argument-builder inputs. Per-scanner config (e.g.
 * `rulesets` for semgrep) flows in here from
 * `extensionConfig.review.scanners.<id>` so the registry can stay
 * agnostic about each adapter's option surface.
 */
export interface ScannerArgsOptions {
	/** Semgrep config rulesets (e.g. `p/typescript`, `p/owasp-top-ten`). */
	rulesets?: readonly string[];
	/**
	 * Repository root the scanner will run against. Optional because
	 * most adapters don't need it; semgrep uses it to detect a repo
	 * config file and skip the default `p/javascript` ruleset when one
	 * is present (so auto-enable matches the user's actual rules).
	 */
	cwd?: string;
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
	/**
	 * Argv builder. Pure; no I/O. Receives optional adapter-specific
	 * options (currently `rulesets` for semgrep) sourced from per-scanner
	 * config; specs that don't need options can ignore the argument.
	 */
	buildArgs: (opts?: ScannerArgsOptions) => string[];
	/**
	 * Heuristic for `enable: "auto"` — return `true` when the cwd has the
	 * relevant config / lockfile / etc. for this scanner to be useful.
	 * When unset, `enable: "auto"` resolves to `defaultEnabled`.
	 */
	detectAuto?: (cwd: string) => boolean;
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
		args?: ScannerArgsOptions;
	};
}
