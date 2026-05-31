/**
 * Pure renderer for the sidebar's Notes box body. Wraps the stored free-text
 * notes to the live inner width and caps the height so a long note can't starve
 * the Plan box above it — overflow is signalled with a trailing "… (n more)".
 * Editing happens in the host's multi-line editor (IME-safe by construction);
 * this only paints the current text plus an edit hint.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";

/** Hard cap on rendered note rows so the Plan box keeps room. */
export const MAX_NOTES_ROWS = 8;

/** Key hint shown when the box is empty (must match the registered shortcut). */
export const NOTES_EDIT_HINT = "ctrl+shift+n to edit";

/**
 * Render the Notes body: wrapped note lines capped at {@link MAX_NOTES_ROWS},
 * or a dim placeholder hint when there are no notes yet.
 */
export function renderNotesBody(
	theme: Theme,
	notes: string,
	innerWidth: number,
): string[] {
	const width = Math.max(1, innerWidth - 1);
	if (notes.trim() === "") {
		return [` ${theme.fg("dim", NOTES_EDIT_HINT)}`];
	}

	const wrapped: string[] = [];
	for (const line of notes.replace(/\r\n?/g, "\n").split("\n")) {
		if (line === "") {
			wrapped.push("");
			continue;
		}
		for (const chunk of wrapTextWithAnsi(line, width)) {
			wrapped.push(` ${theme.fg("text", chunk)}`);
		}
	}

	if (wrapped.length <= MAX_NOTES_ROWS) return wrapped;
	const hidden = wrapped.length - (MAX_NOTES_ROWS - 1);
	return [
		...wrapped.slice(0, MAX_NOTES_ROWS - 1),
		` ${theme.fg("dim", `… (${hidden} more)`)}`,
	];
}
