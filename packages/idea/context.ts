/**
 * Context gathering for /idea.
 *
 * Pure-ish: reads pi's session state and inspects cwd's git origin,
 * then returns a plain `IdeaContext` value. No mutation, no
 * `pi.sendMessage`, no agent turn — that's the whole point of
 * /idea.
 *
 * Differs from /derp on two axes:
 *   - `/idea` always targets cwd's `origin` remote; we resolve it
 *     synchronously and bail if the cwd isn't in a git repo or has
 *     no origin.
 *   - The polish payload is shaped for "feature idea / improvement
 *     suggestion" rather than "bug report".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type GitRunner,
	type OriginInfo,
	readOrigin,
} from "@vegardx/pi-extensions-shared/git-origin.js";

// ---------------------------------------------------------------------------
// Session-entry summarisation
// ---------------------------------------------------------------------------

/**
 * One row in the session-recent-tail summary handed to the polish
 * subagent. Kept minimal — we are not trying to reconstruct the
 * conversation, just give the LLM enough to write a coherent
 * "what context the idea came from" paragraph.
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
 * array (returned by `ctx.sessionManager.getEntries()`). Loose shape
 * because pi's session entry schema evolves; the few fields we read
 * (`type`, `role`, `content`, `text`) have been stable across recent
 * versions.
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
 * containing the package.
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
// IdeaContext
// ---------------------------------------------------------------------------

export interface IdeaContext {
	/** User-supplied free-form idea text (already trimmed, non-empty). */
	userText: string;
	/** ISO date (yyyy-mm-dd) when the idea was filed. */
	date: string;
	/** pi session id. */
	sessionId: string;
	/** Human-friendly session name set via `pi.setSessionName()`, or null. */
	sessionName: string | null;
	/** Version of `@mariozechner/pi-coding-agent` if discoverable. */
	piVersion: string | null;
	/** Tail of the session conversation, summarised + truncated. */
	recentEntries: RecentEntry[];
	/** Resolved cwd-origin remote (host/owner/repo). */
	origin: OriginInfo;
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
	/** Test seam — inject a stubbed git runner. */
	gitRunner?: GitRunner;
}

/**
 * Bail reasons surfaced to the caller (which decides how to notify
 * the user).
 */
export type GatherResult =
	| { ok: true; ctx: IdeaContext }
	| {
			ok: false;
			reason: "empty-input" | "no-origin";
			detail: string;
	  };

/**
 * Gather everything we need to file an idea against cwd's origin.
 * Synchronous; never throws.
 */
export function gatherIdeaContext(input: GatherContextInput): GatherResult {
	const userText = input.userText.trim();
	if (!userText) {
		return {
			ok: false,
			reason: "empty-input",
			detail:
				"idea: needs something to capture (e.g. `/idea pre/post phases should auto-detect manual TODOs`)",
		};
	}

	const origin = readOrigin(input.cwd, input.gitRunner);
	if (!origin) {
		return {
			ok: false,
			reason: "no-origin",
			detail:
				"idea: cwd is not inside a git repo with an `origin` remote — cannot resolve target",
		};
	}

	const piVersion = readPiVersion(input.piVersionStartPath ?? input.cwd);

	const ctx: IdeaContext = {
		userText,
		date: new Date().toISOString().slice(0, 10),
		sessionId: input.sessionId,
		sessionName: input.sessionName ?? null,
		piVersion,
		recentEntries: summariseEntries(input.entries, input.recentEntryCount),
		origin,
	};
	return { ok: true, ctx };
}
