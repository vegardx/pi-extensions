import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_NOTES_ROWS,
	NOTES_EDIT_HINT,
	renderNotesBody,
} from "../sidebar/notes.js";
import { loadNotes, notesPath, saveNotes } from "../sidebar/notes-store.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderNotesBody>[0];

describe("renderNotesBody", () => {
	it("shows the edit hint when empty", () => {
		const rows = renderNotesBody(theme, "", 30);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain(NOTES_EDIT_HINT);
	});

	it("treats whitespace-only notes as empty", () => {
		expect(renderNotesBody(theme, "   \n  \n", 30)[0]).toContain(
			NOTES_EDIT_HINT,
		);
	});

	it("renders multi-line notes, preserving blank lines", () => {
		const rows = renderNotesBody(theme, "first\n\nsecond", 30);
		expect(rows.map((r) => r.trim())).toEqual(["first", "", "second"]);
	});

	it("wraps long lines to the inner width", () => {
		const rows = renderNotesBody(theme, "aaaa bbbb cccc dddd eeee", 10);
		expect(rows.length).toBeGreaterThan(1);
		for (const r of rows) expect(r.trim().length).toBeLessThanOrEqual(9);
	});

	it("caps at MAX_NOTES_ROWS with an overflow indicator", () => {
		const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const rows = renderNotesBody(theme, many, 30);
		expect(rows).toHaveLength(MAX_NOTES_ROWS);
		expect(rows[MAX_NOTES_ROWS - 1]).toContain("more)");
	});
});

describe("notes-store", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "notes-store-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns empty string when no notes file exists", () => {
		expect(loadNotes(dir, "sess-1")).toBe("");
	});

	it("round-trips saved notes for a session", () => {
		saveNotes(dir, "sess-1", "remember this");
		expect(loadNotes(dir, "sess-1")).toBe("remember this");
	});

	it("isolates notes per session id", () => {
		saveNotes(dir, "sess-1", "one");
		saveNotes(dir, "sess-2", "two");
		expect(loadNotes(dir, "sess-1")).toBe("one");
		expect(loadNotes(dir, "sess-2")).toBe("two");
	});

	it("sanitises unsafe session ids in the path", () => {
		const p = notesPath(dir, "../../etc/passwd");
		expect(p).not.toContain("..");
		saveNotes(dir, "../../etc/passwd", "x");
		expect(readFileSync(p, "utf8")).toBe("x");
	});

	it("no-ops without a session dir or id", () => {
		expect(() => saveNotes("", "sess", "x")).not.toThrow();
		expect(loadNotes("", "sess")).toBe("");
		expect(loadNotes(dir, "")).toBe("");
	});
});
