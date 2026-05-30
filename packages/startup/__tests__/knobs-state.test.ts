import {
	buildKnobRows,
	closeOverlay,
	createKnobsState,
	editCurrent,
	effectiveKnob,
	inputAppend,
	inputBackspace,
	inputCommit,
	inputMoveLeft,
	type KnobRow,
	type KnobSchema,
	knobsMoveDown,
	knobsMoveUp,
	pickerAppend,
	pickerOptions,
	pickerSelect,
	resetCurrent,
	scopeValue,
} from "../config-dialog/knobs-state.js";

function row(
	partial: Partial<KnobRow> & Pick<KnobRow, "key" | "type">,
): KnobRow {
	return {
		extName: "modes",
		doc: "doc",
		project: null,
		global: null,
		...partial,
	};
}

function stateOf(rows: KnobRow[], availableModels: string[] = []) {
	return createKnobsState({ rows, availableModels });
}

describe("effectiveKnob", () => {
	it("prefers project, then global, then default", () => {
		expect(
			effectiveKnob(row({ key: "model", type: "string", default: undefined })),
		).toEqual({ value: null, source: "default" });
		expect(
			effectiveKnob(row({ key: "x", type: "number", default: 5 })),
		).toEqual({ value: 5, source: "default" });
		expect(
			effectiveKnob(row({ key: "x", type: "number", default: 5, global: 7 })),
		).toEqual({ value: 7, source: "global" });
		expect(
			effectiveKnob(
				row({ key: "x", type: "number", default: 5, global: 7, project: 9 }),
			),
		).toEqual({ value: 9, source: "project" });
	});

	it("treats false and [] as real values, not unset", () => {
		expect(
			effectiveKnob(
				row({ key: "b", type: "boolean", default: true, project: false }),
			),
		).toEqual({ value: false, source: "project" });
		expect(
			effectiveKnob(row({ key: "a", type: "string[]", global: [] })),
		).toEqual({ value: [], source: "global" });
	});
});

describe("navigation", () => {
	it("moves within bounds and is blocked while an overlay is open", () => {
		const s = stateOf([
			row({ key: "a", type: "number", default: 1 }),
			row({ key: "b", type: "number", default: 2 }),
		]);
		expect(knobsMoveUp(s)).toBe(false);
		expect(knobsMoveDown(s)).toBe(true);
		expect(s.cursor).toBe(1);
		expect(knobsMoveDown(s)).toBe(false);
		editCurrent(s, "project"); // opens input overlay
		expect(knobsMoveUp(s)).toBe(false);
	});
});

describe("boolean editing", () => {
	it("cycles null → true → false → null in place", () => {
		const s = stateOf([row({ key: "b", type: "boolean", default: false })]);
		expect(editCurrent(s, "project")).toEqual({
			type: "cycled",
			row: s.rows[0],
			value: true,
		});
		expect(editCurrent(s, "project").type).toBe("cycled");
		expect(s.rows[0].project).toBe(false);
		editCurrent(s, "project");
		expect(s.rows[0].project).toBe(null);
		// global scope is independent
		expect(s.rows[0].global).toBe(null);
	});
});

describe("enum picker", () => {
	it("opens a picker, filters, and selects into the active scope", () => {
		const s = stateOf([
			row({
				key: "mode.default",
				type: "enum",
				enumValues: ["plan", "auto", "ask", "hack"],
			}),
		]);
		expect(editCurrent(s, "global")).toEqual({ type: "overlay" });
		expect(pickerOptions(s)[0]).toBe("(clear override)");
		expect(pickerOptions(s)).toContain("plan");

		// filter to "as" → ask
		pickerAppend(s, "a");
		pickerAppend(s, "s");
		expect(pickerOptions(s)).toEqual(["(clear override)", "ask"]);
		// cursor 1 = "ask"
		if (s.overlay?.kind === "picker") s.overlay.cursor = 1;
		const sel = pickerSelect(s, "global");
		expect(sel).toEqual({ type: "set", row: s.rows[0], value: "ask" });
		expect(s.rows[0].global).toBe("ask");
		expect(s.overlay).toBeUndefined();
	});

	it("clear sentinel resets the active scope", () => {
		const s = stateOf([
			row({
				key: "mode.default",
				type: "enum",
				enumValues: ["plan"],
				project: "plan",
			}),
		]);
		editCurrent(s, "project");
		if (s.overlay?.kind === "picker") s.overlay.cursor = 0; // CLEAR
		expect(pickerSelect(s, "project")).toEqual({
			type: "clear",
			row: s.rows[0],
		});
		expect(s.rows[0].project).toBeNull();
	});
});

describe("model picker", () => {
	it("uses availableModels as options for a model key", () => {
		const s = stateOf(
			[row({ key: "model", type: "string" })],
			["anthropic/haiku", "openai/gpt-4o"],
		);
		editCurrent(s, "project");
		expect(pickerOptions(s)).toEqual([
			"(clear override)",
			"anthropic/haiku",
			"openai/gpt-4o",
		]);
	});
});

describe("number input", () => {
	it("commits a finite number and rejects non-numbers (stays open)", () => {
		const s = stateOf([row({ key: "n", type: "number", default: 10 })]);
		editCurrent(s, "project");
		inputAppend(s, "4x");
		const bad = inputCommit(s, "project");
		expect(bad?.type).toBe("invalid");
		expect(s.overlay?.kind).toBe("input"); // still open
		// fix it
		inputBackspace(s);
		const ok = inputCommit(s, "project");
		expect(ok).toEqual({ type: "set", row: s.rows[0], value: 4 });
		expect(s.rows[0].project).toBe(4);
	});

	it("rejects an empty number buffer", () => {
		const s = stateOf([row({ key: "n", type: "number", default: 10 })]);
		editCurrent(s, "project");
		expect(inputCommit(s, "project")?.type).toBe("invalid");
	});
});

describe("string[] input", () => {
	it("parses comma/space tokens and validates against enumValues", () => {
		const s = stateOf([
			row({
				key: "review.agents",
				type: "string[]",
				enumValues: ["a", "b", "c"],
			}),
		]);
		editCurrent(s, "project");
		inputAppend(s, "a, b c");
		expect(inputCommit(s, "project")).toEqual({
			type: "set",
			row: s.rows[0],
			value: ["a", "b", "c"],
		});
	});

	it("rejects a token outside enumValues", () => {
		const s = stateOf([
			row({ key: "review.agents", type: "string[]", enumValues: ["a", "b"] }),
		]);
		editCurrent(s, "project");
		inputAppend(s, "a, zzz");
		expect(inputCommit(s, "project")?.type).toBe("invalid");
	});

	it("commits an empty buffer as [] (explicitly empty)", () => {
		const s = stateOf([row({ key: "labels", type: "string[]" })]);
		editCurrent(s, "project");
		const r = inputCommit(s, "project");
		expect(r).toEqual({ type: "set", row: s.rows[0], value: [] });
	});
});

describe("string input + caret", () => {
	it("inserts at the caret and commits empty string as a real value", () => {
		const s = stateOf([
			row({ key: "titlePrefix", type: "string", default: "[x] " }),
		]);
		editCurrent(s, "project");
		inputAppend(s, "abc");
		inputMoveLeft(s); // caret before 'c'
		inputAppend(s, "Z");
		const r = inputCommit(s, "project");
		expect(r).toEqual({ type: "set", row: s.rows[0], value: "abZc" });
	});
});

describe("reset + overlay close", () => {
	it("reset clears the active scope only when set", () => {
		const s = stateOf([row({ key: "n", type: "number", project: 3 })]);
		expect(resetCurrent(s, "global")).toBe(false); // global unset
		expect(resetCurrent(s, "project")).toEqual({ row: s.rows[0] });
		expect(s.rows[0].project).toBeNull();
	});

	it("closeOverlay discards an in-progress edit", () => {
		const s = stateOf([row({ key: "n", type: "number", default: 1 })]);
		editCurrent(s, "project");
		inputAppend(s, "999");
		expect(closeOverlay(s)).toBe(true);
		expect(s.rows[0].project).toBeNull(); // not committed
	});
});

describe("buildKnobRows", () => {
	it("joins schemas against the per-scope lookup", () => {
		const schemas: KnobSchema[] = [
			{
				extName: "modes",
				key: "mode.default",
				type: "enum",
				enumValues: ["plan"],
				doc: "d",
			},
			{
				extName: "derp",
				key: "polish.timeoutMs",
				type: "number",
				default: 30000,
				doc: "d",
			},
		];
		const rows = buildKnobRows(schemas, (ext, key, scope) =>
			ext === "modes" && key === "mode.default" && scope === "project"
				? "auto"
				: null,
		);
		expect(rows[0].project).toBe("auto");
		expect(rows[0].global).toBeNull();
		expect(scopeValue(rows[1], "project")).toBeNull();
		expect(rows[1].default).toBe(30000);
	});
});
