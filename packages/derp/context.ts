/**
 * Context gathering for /derp.
 *
 * Pure-ish: reads pi's session state and crawls node_modules for
 * version info, then returns a plain `DerpContext` value. No mutation, no
 * pi.sendMessage, no agent turn — that's the whole point of /derp.
 *
 * Everything here runs synchronously inside the slash-command
 * handler. The polish step (LLM) and the gh shell-out are kept in
 * separate modules so this one stays cheap and easy to unit-test.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type CrashReportSummary,
	defaultCrashReportDir,
	loadCrashReportsForSession,
} from "./crash-reports.js";

// ---------------------------------------------------------------------------
// Remote URL parsing
// ---------------------------------------------------------------------------

// Re-exported from `@vegardx/pi-extensions-shared/git-origin.js` so
// /derp and /idea share one parser. Tests still import from this
// module's local path.
export {
	type OriginInfo,
	parseOriginUrl,
} from "@vegardx/pi-extensions-shared/git-origin.js";

// ---------------------------------------------------------------------------
// Session-entry summarisation
// ---------------------------------------------------------------------------

/**
 * One row in the session-recent-tail summary handed to the polish
 * subagent. Kept minimal — we are not trying to reconstruct the
 * conversation, just give the LLM enough to write a coherent
 * "what was happening" paragraph.
 */
export interface RecentEntry {
	role: "user" | "assistant" | "tool" | "other";
	/** Truncated text. May contain newlines. */
	text: string;
}

const PER_ENTRY_CHAR_BUDGET = 1200;

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/**
 * Pull the last `count` salient entries out of an opaque entries
 * array (returned by `ctx.sessionManager.getEntries()`). We keep the
 * shape loose because pi's session entry shape evolves; the few
 * fields we read (`type`, `role`, `content`, `text`) have been
 * stable across recent versions.
 *
 * Each entry is summarised down to a `{ role, text }` row with
 * heavy truncation so the polish payload doesn't blow up on a
 * long-running session.
 */
export function summariseEntries(
	entries: readonly unknown[],
	count: number,
): RecentEntry[] {
	if (count <= 0 || entries.length === 0) return [];
	const tail = entries.slice(-count);
	const out: RecentEntry[] = [];
	for (const raw of tail) {
		if (!raw || typeof raw !== "object") continue;
		const e = raw as Record<string, unknown>;
		const role = pickRole(e);
		const text = pickText(e);
		if (!text) continue;
		out.push({ role, text: truncate(text, PER_ENTRY_CHAR_BUDGET) });
	}
	return out;
}

function pickRole(e: Record<string, unknown>): RecentEntry["role"] {
	const candidates = [e.role, e.type, e.kind];
	for (const c of candidates) {
		if (typeof c !== "string") continue;
		const v = c.toLowerCase();
		if (v === "user" || v === "human") return "user";
		if (v === "assistant" || v === "model") return "assistant";
		if (v.includes("tool")) return "tool";
	}
	return "other";
}

function pickText(e: Record<string, unknown>): string {
	const direct = e.text ?? e.content ?? e.message;
	if (typeof direct === "string") return direct;
	if (Array.isArray(direct)) {
		// pi-style structured content: array of `{ type, text }` blocks.
		const parts: string[] = [];
		for (const block of direct) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (typeof b.text === "string") parts.push(b.text);
			else if (typeof b.content === "string") parts.push(b.content);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return "";
}

// ---------------------------------------------------------------------------
// pi version (best-effort)
// ---------------------------------------------------------------------------

/**
 * Look up `@mariozechner/pi-coding-agent`'s installed version by
 * crawling upward from the entry path until we find a `node_modules`
 * containing the package. Best-effort: returns `null` when the
 * package can't be located (e.g. running from a tarball install).
 */
export function readPiVersion(startPath: string): string | null {
	let dir = startPath;
	for (let i = 0; i < 12; i++) {
		const candidate = join(
			dir,
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
			"package.json",
		);
		try {
			const raw = readFileSync(candidate, "utf8");
			const pkg = JSON.parse(raw) as { version?: unknown };
			if (typeof pkg.version === "string") return pkg.version;
		} catch {
			/* keep walking */
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// ---------------------------------------------------------------------------
// DerpContext
// ---------------------------------------------------------------------------

export interface DerpContext {
	/** User-supplied free-form report text (already trimmed, non-empty). */
	userText: string;
	/** ISO date (yyyy-mm-dd) when the report was filed. */
	date: string;
	/** pi session id. */
	sessionId: string;
	/** Human-friendly session name set via `pi.setSessionName()`, or null. */
	sessionName: string | null;
	/** Version of `@mariozechner/pi-coding-agent` if discoverable. */
	piVersion: string | null;
	/** Tail of the session conversation, summarised + truncated. */
	recentEntries: RecentEntry[];
	/**
	 * Crash reports tagged with this session id, newest first. Empty
	 * for sessions that didn't crash. Already redacted at write time;
	 * we render them verbatim into the issue body.
	 */
	crashReports: CrashReportSummary[];
}

export interface GatherContextInput {
	cwd: string;
	userText: string;
	sessionId: string;
	sessionName?: string | null;
	entries: readonly unknown[];
	recentEntryCount: number;
	/** Where to start crawling for pi's package.json. Default: `cwd`. */
	piVersionStartPath?: string;
	/**
	 * Where to look for crash-report files. Default: the same path
	 * `packages/modes/crash-report.ts` writes to. Tests override.
	 */
	crashReportsDir?: string;
}

/**
 * Bail reasons surfaced to the caller (which decides how to notify
 * the user). Returning a discriminated result instead of throwing
 * keeps the slash-command handler tidy.
 */
export type GatherResult =
	| { ok: true; ctx: DerpContext }
	| { ok: false; reason: "empty-input"; detail: string };

/**
 * Gather everything we need to file an issue. Synchronous; never
 * throws. Returns a discriminated result so the handler can notify
 * and bail with no extra control flow.
 */
export function gatherDerpContext(input: GatherContextInput): GatherResult {
	const userText = input.userText.trim();
	if (!userText) {
		return {
			ok: false,
			reason: "empty-input",
			detail:
				"derp: needs something to derp on (e.g. `/derp ghost text overlaps input on iTerm`)",
		};
	}

	const piVersion = readPiVersion(input.piVersionStartPath ?? input.cwd);

	const crashReports = loadCrashReportsForSession(
		input.sessionId,
		input.crashReportsDir ?? defaultCrashReportDir(),
	);

	const ctx: DerpContext = {
		userText,
		date: new Date().toISOString().slice(0, 10),
		sessionId: input.sessionId,
		sessionName: input.sessionName ?? null,
		piVersion,
		recentEntries: summariseEntries(input.entries, input.recentEntryCount),
		crashReports,
	};
	return { ok: true, ctx };
}
