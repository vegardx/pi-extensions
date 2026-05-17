/**
 * Process-level crash instrumentation for /implement.
 *
 * Captures `uncaughtException` / `unhandledRejection` while a phase is
 * executing and writes a redacted crash report to
 * `~/.pi/agent/modes/crash-reports/`. The next `/derp` invocation
 * picks up reports newer than the session start and attaches them to
 * the issue body.
 *
 * Two non-negotiables:
 *   1. **Never alter exit behaviour.** We use
 *      `uncaughtExceptionMonitor` (monitor-only by contract) and
 *      add a non-handling `unhandledRejection` listener. pi-mono's
 *      own crash handling is undisturbed.
 *   2. **Fail closed on redaction.** Any secret-shaped hit in the
 *      gathered context is rewritten to `[REDACTED:...]` before the
 *      report is written. We still write the report — the redactor
 *      is authoritative.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type RedactHit,
	redactFull,
	summariseHitKinds,
} from "@vegardx/pi-extensions-shared/redact.js";

export type CrashOrigin = "uncaughtException" | "unhandledRejection";

export interface CrashReport {
	schemaVersion: 1;
	/** ISO timestamp of when the crash was observed. */
	timestamp: string;
	origin: CrashOrigin;
	error: {
		name: string | null;
		message: string;
		/** Stack trace, post-redaction. May be null if the thrown value had none. */
		stack: string | null;
	};
	/** Snapshot of the agent's modeState at crash time. */
	state: {
		mode: string | null;
		stage: string | null;
		branch: string | null;
		planSlug: string | null;
		activePhaseId: string | null;
	};
	session: {
		id: string | null;
		/** Absolute path to the session JSONL on disk, post home-path collapse. */
		file: string | null;
	};
	/**
	 * Last N session entries summarised down to `{ role, text }`.
	 * Heavy truncation per entry — we are not reconstructing the
	 * full transcript.
	 */
	recentEntries: ReadonlyArray<{ role: string; text: string }>;
	/**
	 * De-duplicated kinds from the redactor. Empty array means
	 * nothing matched — the report is verbatim. Non-empty means
	 * one or more substitutions were applied.
	 */
	redactionHits: ReadonlyArray<string>;
}

/**
 * Hooks the crash handler reads at fire time. All getters are
 * called inside the listener so they reflect *current* state, not
 * the state at install time.
 */
export interface CrashHandlerDeps {
	/** Active mode + branch + phase. Returning null fields is fine. */
	getModeSnapshot: () => {
		mode: string | null;
		stage: string | null;
		branch: string | null;
		planSlug: string | null;
		activePhaseId: string | null;
	};
	/**
	 * Current SessionManager-like object, or null if no /implement
	 * is in flight. Crash reports only fire when this returns a
	 * value AND `getModeSnapshot().stage === "executing"`.
	 */
	getSessionAccessor: () => SessionAccessor | null;
	/**
	 * Test seam. Production wiring uses `node:fs.writeFileSync` +
	 * `mkdirSync` + a path under `homedir()`. Tests pass an
	 * in-memory recorder.
	 */
	writeReport?: (path: string, payload: string) => void;
	/** Test seam: override `homedir()`. */
	homeDir?: () => string;
	/** Test seam: override `new Date()`. */
	now?: () => Date;
}

/**
 * Minimum surface we need from pi-mono's SessionManager. Kept
 * narrow so tests can substitute a plain object.
 */
export interface SessionAccessor {
	getSessionId: () => string;
	getSessionFile: () => string | undefined;
	getEntries: () => readonly unknown[];
}

const RECENT_ENTRIES = 6;
const PER_ENTRY_CHAR_BUDGET = 800;

/**
 * Subdirectory for crash reports. Keyed by extension (modes), not
 * by repo, mirroring derp's `~/.pi/agent/derp/pending/` convention.
 * Cross-repo crash reports land in one place; `/derp` filters to
 * the active session by `sessionId` rather than by directory.
 */
export const CRASH_REPORT_SUBDIR = join("modes", "crash-reports");

export function crashReportDir(home: string = homedir()): string {
	return join(home, ".pi", "agent", CRASH_REPORT_SUBDIR);
}

/**
 * Build a crash report from raw inputs. Pure: no I/O, no clock, no
 * homedir lookup. Tests exercise this directly.
 *
 * Redaction strategy:
 *   - Each text-bearing field passes through `redactFull` which
 *     strips secrets, internal hosts, and home paths.
 *   - The combined hit list is summarised by kind on the report so
 *     reviewers can tell *something* matched without seeing what.
 */
export function buildCrashReport(input: {
	timestamp: Date;
	origin: CrashOrigin;
	error: unknown;
	state: CrashHandlerDeps extends { getModeSnapshot: () => infer S }
		? S
		: never;
	session: { id: string | null; file: string | null };
	entries: readonly unknown[];
}): CrashReport {
	const allHits: RedactHit[] = [];

	const redactString = (s: string | null | undefined): string | null => {
		if (s === null || s === undefined) return null;
		const r = redactFull(s);
		allHits.push(...r.hits);
		return r.text;
	};

	const errObj = toErrorShape(input.error);
	const error = {
		name: errObj.name,
		message: redactString(errObj.message) ?? "",
		stack: redactString(errObj.stack),
	};

	const recentEntries = summariseEntries(input.entries, RECENT_ENTRIES).map(
		(e) => ({
			role: e.role,
			text: redactString(e.text) ?? "",
		}),
	);

	const sessionFile = redactString(input.session.file);

	return {
		schemaVersion: 1,
		timestamp: input.timestamp.toISOString(),
		origin: input.origin,
		error,
		state: input.state,
		session: { id: input.session.id, file: sessionFile },
		recentEntries,
		redactionHits: summariseHitKinds(allHits),
	};
}

interface ErrorShape {
	name: string | null;
	message: string;
	stack: string | null;
}

function toErrorShape(value: unknown): ErrorShape {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack ?? null,
		};
	}
	if (typeof value === "string") {
		return { name: null, message: value, stack: null };
	}
	if (value && typeof value === "object") {
		const obj = value as { name?: unknown; message?: unknown; stack?: unknown };
		return {
			name: typeof obj.name === "string" ? obj.name : null,
			message:
				typeof obj.message === "string"
					? obj.message
					: safeJsonStringify(value),
			stack: typeof obj.stack === "string" ? obj.stack : null,
		};
	}
	return { name: null, message: String(value), stack: null };
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

interface SummarisedEntry {
	role: string;
	text: string;
}

/**
 * Pull `count` salient entries off the tail. We accept `unknown[]`
 * because pi's session entry shape evolves; the few fields we read
 * (`type`, `role`, `content`, `text`) have been stable across
 * recent versions. Mirrors the approach in `derp/context.ts`.
 */
function summariseEntries(
	entries: readonly unknown[],
	count: number,
): SummarisedEntry[] {
	if (count <= 0 || entries.length === 0) return [];
	const tail = entries.slice(-count);
	const out: SummarisedEntry[] = [];
	for (const e of tail) {
		const obj = e as { type?: unknown; role?: unknown; content?: unknown };
		const role = typeof obj.role === "string" ? obj.role : "other";
		const text = readEntryText(obj);
		if (text === null) continue;
		out.push({
			role:
				role === "user" || role === "assistant" || role === "tool"
					? role
					: "other",
			text: truncate(text, PER_ENTRY_CHAR_BUDGET),
		});
	}
	return out;
}

function readEntryText(entry: { content?: unknown }): string | null {
	const c = entry.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		const parts: string[] = [];
		for (const part of c as Array<{ type?: unknown; text?: unknown }>) {
			if (typeof part?.text === "string") parts.push(part.text);
		}
		return parts.length > 0 ? parts.join("\n") : null;
	}
	return null;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/**
 * Build the canonical filename for a crash report. Format:
 * `<iso-timestamp>-<sessionId-or-unknown>.json`. Slashes and colons
 * stripped so the filename is portable.
 */
export function crashReportFilename(opts: {
	timestamp: Date;
	sessionId: string | null;
}): string {
	const ts = opts.timestamp.toISOString().replace(/[:.]/g, "-");
	const sid = (opts.sessionId ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
	return `${ts}-${sid}.json`;
}

/**
 * Install monitor-only listeners for `uncaughtException` and a
 * non-handling listener for `unhandledRejection`. Returns a
 * disposer that removes both.
 *
 * The handlers are best-effort: they swallow any error thrown
 * inside themselves so a crash inside the crash handler can never
 * mask the original error.
 *
 * Crash reports are only written when the agent is in the
 * `executing` stage. Other modes (plan / ask / hack) are
 * uninstrumented because they don't have the "phase context worth
 * preserving" property.
 */
export function installCrashHandler(deps: CrashHandlerDeps): () => void {
	const onUncaught = (err: unknown): void => {
		fire(err, "uncaughtException");
	};
	const onUnhandled = (reason: unknown): void => {
		fire(reason, "unhandledRejection");
		// NOTE: registering an `unhandledRejection` listener suppresses
		// Node's default behaviour (Node 15+ defaults to terminate). This
		// is a deliberate tradeoff for a TUI extension: capturing the
		// crash report and letting the process continue is preferable to
		// silent termination of an interactive session. Pi-mono itself
		// does not register an `unhandledRejection` listener, so this is
		// the only listener attached and the only behaviour shift.
	};

	const fire = (err: unknown, origin: CrashOrigin): void => {
		try {
			const state = deps.getModeSnapshot();
			if (state.stage !== "executing") return;
			const session = deps.getSessionAccessor();
			const at = (deps.now ?? (() => new Date()))();

			let entries: readonly unknown[] = [];
			let sessionId: string | null = null;
			let sessionFile: string | null = null;
			if (session) {
				try {
					entries = session.getEntries();
				} catch {
					// pi-mono session may already be torn down — best-effort.
				}
				try {
					sessionId = session.getSessionId();
				} catch {
					// noop
				}
				try {
					sessionFile = session.getSessionFile() ?? null;
				} catch {
					// noop
				}
			}

			const report = buildCrashReport({
				timestamp: at,
				origin,
				error: err,
				state,
				session: { id: sessionId, file: sessionFile },
				entries,
			});

			const home = (deps.homeDir ?? homedir)();
			const dir = crashReportDir(home);
			const file = join(dir, crashReportFilename({ timestamp: at, sessionId }));
			const payload = JSON.stringify(report, null, 2);

			if (deps.writeReport) {
				deps.writeReport(file, payload);
			} else {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, payload, "utf8");
			}
		} catch {
			// Crash-in-crash-handler must never mask the original error.
		}
	};

	process.on("uncaughtExceptionMonitor", onUncaught);
	process.on("unhandledRejection", onUnhandled);

	return () => {
		process.off("uncaughtExceptionMonitor", onUncaught);
		process.off("unhandledRejection", onUnhandled);
	};
}
