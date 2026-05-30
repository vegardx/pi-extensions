import { describe, expect, it } from "vitest";

import {
	createState,
	currentRow,
	cycleCurrent,
	type ExtensionRow,
	moveDown,
	moveUp,
	resetCurrent,
	setScope,
	valueAt,
} from "../config-dialog/extensions-state.js";

function rows(): ExtensionRow[] {
	return [
		{
			name: "modes",
			dependsOn: [],
			integratesWith: ["commit", "review"],
			project: null,
			global: true,
			effective: true,
			effectiveSource: "global",
		},
		{
			name: "commit",
			dependsOn: [],
			integratesWith: ["review"],
			project: false,
			global: null,
			effective: false,
			effectiveSource: "project",
		},
		{
			name: "review",
			dependsOn: [],
			integratesWith: ["commit"],
			project: null,
			global: null,
			effective: false,
			effectiveSource: "default",
		},
	];
}

describe("dialog state — navigation", () => {
	it("starts on the project tab with cursor at 0", () => {
		const s = createState({ rows: rows() });
		expect(s.scope).toBe("project");
		expect(s.cursor).toBe(0);
	});

	it("moveDown advances the cursor and stops at the end", () => {
		const s = createState({ rows: rows() });
		expect(moveDown(s)).toBe(true);
		expect(s.cursor).toBe(1);
		expect(moveDown(s)).toBe(true);
		expect(s.cursor).toBe(2);
		expect(moveDown(s)).toBe(false);
		expect(s.cursor).toBe(2);
	});

	it("moveUp reverses and stops at 0", () => {
		const s = createState({ rows: rows(), cursor: 2 });
		expect(moveUp(s)).toBe(true);
		expect(s.cursor).toBe(1);
		expect(moveUp(s)).toBe(true);
		expect(s.cursor).toBe(0);
		expect(moveUp(s)).toBe(false);
	});

	it("setScope switches active tab and reports change", () => {
		const s = createState({ rows: rows() });
		expect(setScope(s, "global")).toBe(true);
		expect(s.scope).toBe("global");
		expect(setScope(s, "global")).toBe(false);
	});

	it("clamps an out-of-range initial cursor", () => {
		const s = createState({ rows: rows(), cursor: 99 });
		expect(s.cursor).toBe(2);
	});

	it("cursor is 0 on an empty row list", () => {
		const s = createState({ rows: [] });
		expect(s.cursor).toBe(0);
		expect(currentRow(s)).toBeUndefined();
	});
});

describe("dialog state — toggling", () => {
	it("cycleCurrent advances null → true → false → null on project tab", () => {
		const s = createState({ rows: rows() });
		// row[0].project starts null
		expect(cycleCurrent(s)).toBe(true);
		expect(valueAt(s, 0)).toBe(true);
		expect(cycleCurrent(s)).toBe(false);
		expect(valueAt(s, 0)).toBe(false);
		expect(cycleCurrent(s)).toBe(null);
		expect(valueAt(s, 0)).toBe(null);
		expect(cycleCurrent(s)).toBe(true);
	});

	it("cycleCurrent operates on the active scope only", () => {
		const s = createState({ rows: rows() });
		setScope(s, "global");
		// row[0].global starts true; next is false.
		expect(cycleCurrent(s)).toBe(false);
		// project scope value untouched
		expect(s.rows[0].project).toBe(null);
		expect(s.rows[0].global).toBe(false);
	});

	it("resetCurrent clears a non-null value and returns true", () => {
		const s = createState({ rows: rows(), cursor: 1 }); // commit, project=false
		expect(resetCurrent(s)).toBe(true);
		expect(s.rows[1].project).toBe(null);
	});

	it("resetCurrent returns false when the value is already null", () => {
		const s = createState({ rows: rows() }); // modes.project=null
		expect(resetCurrent(s)).toBe(false);
	});

	it("cycleCurrent is a no-op when the row list is empty", () => {
		const s = createState({ rows: [] });
		expect(cycleCurrent(s)).toBe(null);
	});
});
