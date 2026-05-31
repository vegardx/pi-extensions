/**
 * Per-session persistence for the sidebar's Notes box.
 *
 * Notes are scoped to the session: each session gets its own file co-located
 * with the session's JSONL transcript under `<sessionDir>/sidebar-notes/`,
 * keyed by session id. A fresh session therefore starts with empty notes, and
 * re-attaching to the same session (resume) rehydrates them. Writes happen when
 * the editor overlay closes with a result, so no keystroke-level debounce is
 * needed — editing is a discrete open-edit-submit action.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Sub-directory of the session dir that holds per-session note files. */
const NOTES_DIR = "sidebar-notes";

/** Collapse anything that isn't a safe filename char so the path can't escape. */
function safeName(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Absolute path of the notes file for a given session. */
export function notesPath(sessionDir: string, sessionId: string): string {
	return join(sessionDir, NOTES_DIR, `${safeName(sessionId)}.md`);
}

/** Load the saved notes for a session, or "" when none exist / unreadable. */
export function loadNotes(sessionDir: string, sessionId: string): string {
	if (!sessionDir || !sessionId) return "";
	const path = notesPath(sessionDir, sessionId);
	if (!existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Persist notes for a session, creating the notes dir on first write. */
export function saveNotes(
	sessionDir: string,
	sessionId: string,
	text: string,
): void {
	if (!sessionDir || !sessionId) return;
	const dir = join(sessionDir, NOTES_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(notesPath(sessionDir, sessionId), text, "utf8");
}
