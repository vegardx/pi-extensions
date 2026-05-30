/**
 * Pure state model for the `/config` Models page.
 *
 * The page edits the six background-model tiers stored at the top level
 * of settings.json:
 *
 *     backgroundModels:
 *       primary:   { fast, normal, heavy }
 *       secondary: { fast, normal, heavy }
 *
 * Each tier holds a `"provider/id"` model spec or is unset. The page
 * shows the literal value at the active scope (project / global) and an
 * effective column computed as `project ?? global` — a flat
 * leaf-level merge with **no** secondary→primary fallback. The
 * resolver's runtime fallback is a separate concern; here we only
 * surface and write the literal values so each override is attributable
 * to exactly one layer.
 *
 * Toggling opens a model picker (a filterable list of the session's
 * auth-configured models plus a "clear" sentinel). Selecting writes the
 * value at the active scope; the dialog owns persistence.
 *
 * Zero TUI / I/O dependencies so every transition is unit-testable.
 */

export type ModelSet = "primary" | "secondary";
export type ModelTier = "fast" | "normal" | "heavy";

/** Fixed display order: primary tiers first, then secondary. */
export const MODEL_ROW_ORDER: ReadonlyArray<{
	set: ModelSet;
	tier: ModelTier;
}> = [
	{ set: "primary", tier: "fast" },
	{ set: "primary", tier: "normal" },
	{ set: "primary", tier: "heavy" },
	{ set: "secondary", tier: "fast" },
	{ set: "secondary", tier: "normal" },
	{ set: "secondary", tier: "heavy" },
];

export interface ModelRow {
	set: ModelSet;
	tier: ModelTier;
	/** Literal value at project scope, or `null` when unset. */
	project: string | null;
	/** Literal value at global scope, or `null` when unset. */
	global: string | null;
}

/**
 * Sentinel option always shown first in the picker. Selecting it clears
 * the override at the active scope.
 */
export const CLEAR_OPTION = "(clear override)";

export interface PickerState {
	/** Index into `rows` of the tier being edited. */
	rowIndex: number;
	/** Current filter text. */
	query: string;
	/** Cursor into the displayed option list (`[CLEAR, ...filtered]`). */
	cursor: number;
}

export interface ModelsState {
	rows: ModelRow[];
	cursor: number;
	/** Auth-configured `"provider/id"` specs, sorted and deduped. */
	available: string[];
	/** Present only while the picker overlay is open. */
	picker?: PickerState;
}

export interface ModelsInit {
	rows: ModelRow[];
	available: string[];
	cursor?: number;
}

function clampCursor(cursor: number, length: number): number {
	if (length === 0) return 0;
	if (cursor < 0) return 0;
	if (cursor >= length) return length - 1;
	return cursor;
}

/** Build the canonical six-row list from per-scope value lookups. */
export function buildModelRows(
	lookup: (
		set: ModelSet,
		tier: ModelTier,
		scope: "project" | "global",
	) => string | null,
): ModelRow[] {
	return MODEL_ROW_ORDER.map(({ set, tier }) => ({
		set,
		tier,
		project: lookup(set, tier, "project"),
		global: lookup(set, tier, "global"),
	}));
}

export function createModelsState(init: ModelsInit): ModelsState {
	return {
		rows: init.rows,
		available: init.available,
		cursor: clampCursor(init.cursor ?? 0, init.rows.length),
	};
}

export function currentModelRow(state: ModelsState): ModelRow | undefined {
	return state.rows[state.cursor];
}

/**
 * Effective (merged) value for a row: project wins over global, no
 * cross-set fallback. `null` when neither layer sets it.
 */
export function effectiveModel(row: ModelRow): string | null {
	return row.project ?? row.global;
}

/** Where the effective value comes from. */
export function effectiveModelSource(
	row: ModelRow,
): "project" | "global" | "default" {
	if (row.project !== null) return "project";
	if (row.global !== null) return "global";
	return "default";
}

export function modelsMoveDown(state: ModelsState): boolean {
	if (state.picker) return false;
	if (state.cursor >= state.rows.length - 1) return false;
	state.cursor += 1;
	return true;
}

export function modelsMoveUp(state: ModelsState): boolean {
	if (state.picker) return false;
	if (state.cursor <= 0) return false;
	state.cursor -= 1;
	return true;
}

/**
 * Options shown in the picker for the current query: the clear sentinel
 * first, then available specs filtered by case-insensitive substring.
 */
export function pickerOptions(state: ModelsState): string[] {
	if (!state.picker) return [];
	const q = state.picker.query.trim().toLowerCase();
	const matches = q
		? state.available.filter((s) => s.toLowerCase().includes(q))
		: state.available;
	return [CLEAR_OPTION, ...matches];
}

/** Open the picker for the row under the cursor. No-op if already open. */
export function openPicker(state: ModelsState): boolean {
	if (state.picker) return false;
	if (!currentModelRow(state)) return false;
	state.picker = { rowIndex: state.cursor, query: "", cursor: 0 };
	return true;
}

/** Close the picker without selecting. */
export function closePicker(state: ModelsState): boolean {
	if (!state.picker) return false;
	state.picker = undefined;
	return true;
}

export function pickerMoveDown(state: ModelsState): boolean {
	if (!state.picker) return false;
	const len = pickerOptions(state).length;
	if (state.picker.cursor >= len - 1) return false;
	state.picker.cursor += 1;
	return true;
}

export function pickerMoveUp(state: ModelsState): boolean {
	if (!state.picker) return false;
	if (state.picker.cursor <= 0) return false;
	state.picker.cursor -= 1;
	return true;
}

/** Append a character to the filter and clamp the cursor. */
export function pickerAppend(state: ModelsState, ch: string): boolean {
	if (!state.picker) return false;
	state.picker.query += ch;
	state.picker.cursor = clampCursor(
		state.picker.cursor,
		pickerOptions(state).length,
	);
	return true;
}

/** Delete the last filter character. Returns false when already empty. */
export function pickerBackspace(state: ModelsState): boolean {
	if (!state.picker) return false;
	if (state.picker.query.length === 0) return false;
	state.picker.query = state.picker.query.slice(0, -1);
	state.picker.cursor = clampCursor(
		state.picker.cursor,
		pickerOptions(state).length,
	);
	return true;
}

export type PickerSelection =
	| { type: "clear"; row: ModelRow }
	| { type: "set"; row: ModelRow; spec: string };

/**
 * Resolve the highlighted picker option into a selection, apply it to
 * the in-memory row at the active scope, and close the picker. Returns
 * the selection so the caller can persist it, or `undefined` if the
 * picker wasn't open.
 */
export function pickerSelect(
	state: ModelsState,
	scope: "project" | "global",
): PickerSelection | undefined {
	if (!state.picker) return undefined;
	const opts = pickerOptions(state);
	const choice = opts[state.picker.cursor];
	const row = state.rows[state.picker.rowIndex];
	state.picker = undefined;
	if (!row || choice === undefined) return undefined;

	if (choice === CLEAR_OPTION) {
		if (scope === "project") row.project = null;
		else row.global = null;
		return { type: "clear", row };
	}
	if (scope === "project") row.project = choice;
	else row.global = choice;
	return { type: "set", row, spec: choice };
}
