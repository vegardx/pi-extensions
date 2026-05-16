/**
 * Crash-report ingestion for /derp.
 *
 * `packages/modes/crash-report.ts` writes redacted JSON snapshots to
 * `~/.pi/agent/modes/crash-reports/<iso-ts>-<sessionId>.json` when a
 * phase-execution turn crashes. /derp picks up the ones tagged with
 * the *current* session id and surfaces them on the filed issue.
 *
 * Why "by sessionId" not "by mtime within window":
 *   - The user might run /derp hours after a crash; an mtime window
 *     would miss it.
 *   - Multiple concurrent sessions on the same host would otherwise
 *     leak each other's crashes into each other's issues.
 *
 * The reports on disk are already redacted at write time. We
 * defensively re-validate shape (schemaVersion === 1) and skip
 * anything malformed rather than throwing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Subset of the crash report we render. Mirrors the shape produced
 * by `packages/modes/crash-report.ts` but intentionally re-declared
 * locally — derp does not depend on the modes package.
 *
 * Fields are loose (`unknown` for nested objects we just stringify)
 * because schema drift between modes and derp is a real risk; the
 * `schemaVersion` field gates compatibility.
 */
export interface CrashReportSummary {
	schemaVersion: 1;
	timestamp: string;
	origin: string;
	error: { name: string | null; message: string; stack: string | null };
	state: {
		mode: string | null;
		stage: string | null;
		branch: string | null;
		planSlug: string | null;
		activePhaseId: string | null;
	};
	session: { id: string | null; file: string | null };
	recentEntries: ReadonlyArray<{ role: string; text: string }>;
	redactionHits: ReadonlyArray<string>;
	/** Absolute path to the JSON file on disk. Useful for the issue body. */
	sourcePath: string;
}

const SUPPORTED_SCHEMA = 1;

/**
 * Default location for crash reports — must match `crashReportDir`
 * in `packages/modes/crash-report.ts`.
 */
export function defaultCrashReportDir(home: string = homedir()): string {
	return join(home, ".pi", "agent", "modes", "crash-reports");
}

/**
 * List crash reports tagged with `sessionId`, newest first.
 *
 * Filters by:
 *   - filename contains `sessionId` (the writer encodes it in the
 *     filename, so this is cheap)
 *   - JSON parses
 *   - `schemaVersion === 1`
 *   - `session.id === sessionId` (defence in depth — the filename
 *     could be tampered with)
 *
 * Never throws. Returns `[]` for "directory missing", "no matches",
 * or "all candidates malformed".
 */
export function loadCrashReportsForSession(
	sessionId: string,
	dir: string = defaultCrashReportDir(),
): CrashReportSummary[] {
	if (!sessionId) return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}

	const candidates: { path: string; mtimeMs: number }[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		if (!name.includes(sessionId)) continue;
		const path = join(dir, name);
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		candidates.push({ path, mtimeMs });
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const out: CrashReportSummary[] = [];
	for (const { path } of candidates) {
		const parsed = parseReport(path);
		if (parsed && parsed.session.id === sessionId) out.push(parsed);
	}
	return out;
}

function parseReport(path: string): CrashReportSummary | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== SUPPORTED_SCHEMA) return null;
	const error = v.error as Record<string, unknown> | undefined;
	const state = v.state as Record<string, unknown> | undefined;
	const session = v.session as Record<string, unknown> | undefined;
	if (!error || !state || !session) return null;
	return {
		schemaVersion: 1,
		timestamp: String(v.timestamp ?? ""),
		origin: String(v.origin ?? ""),
		error: {
			name: typeof error.name === "string" ? error.name : null,
			message: String(error.message ?? ""),
			stack: typeof error.stack === "string" ? error.stack : null,
		},
		state: {
			mode: typeof state.mode === "string" ? state.mode : null,
			stage: typeof state.stage === "string" ? state.stage : null,
			branch: typeof state.branch === "string" ? state.branch : null,
			planSlug: typeof state.planSlug === "string" ? state.planSlug : null,
			activePhaseId:
				typeof state.activePhaseId === "string" ? state.activePhaseId : null,
		},
		session: {
			id: typeof session.id === "string" ? session.id : null,
			file: typeof session.file === "string" ? session.file : null,
		},
		recentEntries: Array.isArray(v.recentEntries)
			? (v.recentEntries as ReadonlyArray<{ role: string; text: string }>)
			: [],
		redactionHits: Array.isArray(v.redactionHits)
			? (v.redactionHits as ReadonlyArray<string>)
			: [],
		sourcePath: path,
	};
}
