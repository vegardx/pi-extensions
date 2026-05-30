/**
 * Pure-state tests for the `/config` Models page: row construction,
 * effective-value computation (project ?? global, no fallback),
 * navigation, and the model picker (open / filter / move / select /
 * clear).
 */

import { describe, expect, it } from "vitest";

import {
	buildModelRows,
	CLEAR_OPTION,
	closePicker,
	createModelsState,
	currentModelRow,
	effectiveModel,
	effectiveModelSource,
	MODEL_ROW_ORDER,
	type ModelRow,
	modelsMoveDown,
	modelsMoveUp,
	openPicker,
	pickerAppend,
	pickerBackspace,
	pickerMoveDown,
	pickerOptions,
	pickerSelect,
} from "../config-dialog/models-state.js";

const AVAILABLE = [
	"anthropic/claude-haiku",
	"anthropic/claude-sonnet",
	"openai/gpt-4o",
];

function rows(): ModelRow[] {
	return buildModelRows((set, tier, scope) => {
		if (set === "primary" && tier === "fast" && scope === "project")
			return "anthropic/claude-haiku";
		if (set === "primary" && tier === "normal" && scope === "global")
			return "openai/gpt-4o";
		return null;
	});
}

describe("buildModelRows / effective", () => {
	it("produces six rows in canonical order", () => {
		const r = buildModelRows(() => null);
		expect(r).toHaveLength(6);
		expect(r.map((x) => `${x.set}.${x.tier}`)).toEqual(
			MODEL_ROW_ORDER.map((x) => `${x.set}.${x.tier}`),
		);
	});

	it("effective prefers project over global with no cross-set fallback", () => {
		const r = rows();
		const byTier = (set: string, tier: string): ModelRow => {
			const found = r.find((x) => x.set === set && x.tier === tier);
			if (!found) throw new Error(`missing ${set}.${tier}`);
			return found;
		};
		const pf = byTier("primary", "fast");
		expect(effectiveModel(pf)).toBe("anthropic/claude-haiku");
		expect(effectiveModelSource(pf)).toBe("project");

		const pn = byTier("primary", "normal");
		expect(effectiveModel(pn)).toBe("openai/gpt-4o");
		expect(effectiveModelSource(pn)).toBe("global");

		// secondary.fast has no value and must NOT borrow primary.fast
		const sf = byTier("secondary", "fast");
		expect(effectiveModel(sf)).toBeNull();
		expect(effectiveModelSource(sf)).toBe("default");
	});
});

describe("models navigation", () => {
	it("moves the cursor within bounds", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		expect(s.cursor).toBe(0);
		expect(modelsMoveUp(s)).toBe(false);
		for (let i = 0; i < 5; i++) expect(modelsMoveDown(s)).toBe(true);
		expect(s.cursor).toBe(5);
		expect(modelsMoveDown(s)).toBe(false);
		expect(modelsMoveUp(s)).toBe(true);
		expect(s.cursor).toBe(4);
	});

	it("blocks navigation while the picker is open", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		openPicker(s);
		expect(modelsMoveDown(s)).toBe(false);
		expect(modelsMoveUp(s)).toBe(false);
	});
});

describe("picker", () => {
	it("opens for the current row and lists clear + all available", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		modelsMoveDown(s); // primary.normal
		expect(openPicker(s)).toBe(true);
		expect(s.picker?.rowIndex).toBe(1);
		expect(pickerOptions(s)).toEqual([CLEAR_OPTION, ...AVAILABLE]);
	});

	it("filters by case-insensitive substring and clamps the cursor", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		openPicker(s);
		pickerMoveDown(s);
		pickerMoveDown(s);
		pickerMoveDown(s); // cursor at 3 (openai/gpt-4o)
		pickerAppend(s, "g");
		pickerAppend(s, "p");
		pickerAppend(s, "t"); // "gpt" → only openai/gpt-4o
		expect(pickerOptions(s)).toEqual([CLEAR_OPTION, "openai/gpt-4o"]);
		expect(s.picker?.cursor).toBeLessThanOrEqual(1);
	});

	it("backspace shrinks the filter and stops at empty", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		openPicker(s);
		pickerAppend(s, "x");
		expect(pickerBackspace(s)).toBe(true);
		expect(s.picker?.query).toBe("");
		expect(pickerBackspace(s)).toBe(false);
	});

	it("select sets the value at the active scope and closes", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		openPicker(s); // row 0 = primary.fast
		pickerMoveDown(s); // CLEAR -> first available
		const sel = pickerSelect(s, "global");
		expect(sel).toEqual({
			type: "set",
			row: s.rows[0],
			spec: "anthropic/claude-haiku",
		});
		expect(s.rows[0].global).toBe("anthropic/claude-haiku");
		expect(s.rows[0].project).toBe("anthropic/claude-haiku"); // project pre-set in fixture
		expect(s.picker).toBeUndefined();
	});

	it("selecting CLEAR removes the value at the active scope", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		openPicker(s); // row 0 = primary.fast, project set
		const sel = pickerSelect(s, "project");
		expect(sel?.type).toBe("clear");
		expect(s.rows[0].project).toBeNull();
	});

	it("closePicker discards without changing values", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		openPicker(s);
		pickerMoveDown(s);
		expect(closePicker(s)).toBe(true);
		expect(s.picker).toBeUndefined();
		expect(s.rows[0].project).toBe("anthropic/claude-haiku"); // untouched
		expect(closePicker(s)).toBe(false);
	});

	it("currentModelRow tracks the cursor", () => {
		const s = createModelsState({ rows: rows(), available: AVAILABLE });
		expect(currentModelRow(s)?.set).toBe("primary");
		modelsMoveDown(s);
		modelsMoveDown(s);
		expect(currentModelRow(s)?.tier).toBe("heavy");
	});
});
