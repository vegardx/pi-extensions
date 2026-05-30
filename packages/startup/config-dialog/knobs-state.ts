/**
 * Pure state model for the `/config` Settings page — editing typed
 * `extensionConfig.<ext>.<key>` knobs per scope (project / global).
 *
 * Mirrors `models-state.ts`: zero TUI / I/O, every transition is
 * unit-testable. The dialog builds the rows (joining each declared
 * extension's `configSchema` against the raw project + global settings
 * via `readExtensionConfigKey`) and owns persistence; this module only
 * tracks selection, the in-memory per-scope values, and the edit overlay.
 *
 * Rows are knob-only and ordered by extension then key. Section headers
 * (one per extension) are a render concern derived from `extName`
 * transitions, so the cursor naturally only ever lands on a knob.
 *
 * Editing dispatches on the knob `type`:
 *   - boolean        → tri-state cycle in place (null → true → false → null)
 *   - enum           → picker over `enumValues` + clear sentinel
 *   - model key      → picker over the session's models + clear sentinel
 *   - string/number  → text-input overlay (number validated on commit)
 *   - string[]       → text-input overlay, comma/space-separated → array
 *                      (validated against `enumValues` when present)
 *
 * `reset` clears the active-scope value (→ null / unset).
 */

export type KnobType = "string" | "string[]" | "number" | "boolean" | "enum";

/**
 * A value at one scope. `null` means "unset at this layer". Note `false`
 * and `[]` are real values distinct from `null`, matching the writer's
 * delete-vs-empty semantics.
 */
export type ScopedValue = string | number | string[] | boolean | null;

export type Scope = "project" | "global";
export type ValueSource = "project" | "global" | "default";

export interface KnobRow {
	extName: string;
	key: string;
	type: KnobType;
	enumValues?: readonly string[];
	/** Schema default (the literal shown when neither layer overrides). */
	default?: unknown;
	doc: string;
	project: ScopedValue;
	global: ScopedValue;
}

/** Sentinel shown first in enum/model pickers; selecting it clears the scope. */
export const CLEAR_OPTION = "(clear override)";

/** Picker overlay for enum and model knobs. */
export interface KnobPicker {
	kind: "picker";
	rowIndex: number;
	/** Candidate values (without the clear sentinel). */
	options: readonly string[];
	query: string;
	cursor: number;
}

/** Free-text overlay for string / number / string[] knobs. */
export interface KnobInput {
	kind: "input";
	rowIndex: number;
	buffer: string;
	/** Caret index into `buffer` (0..buffer.length). */
	caret: number;
	/** Set when the last commit attempt failed validation. */
	error?: string;
}

export type KnobOverlay = KnobPicker | KnobInput;

export interface KnobsState {
	rows: KnobRow[];
	cursor: number;
	/** Auth-configured `"provider/id"` specs for model-knob pickers. */
	availableModels: string[];
	/** Present only while an edit overlay is open. */
	overlay?: KnobOverlay;
}

export interface KnobsInit {
	rows: KnobRow[];
	availableModels?: string[];
	cursor?: number;
}

function clampCursor(cursor: number, length: number): number {
	if (length <= 0) return 0;
	if (cursor < 0) return 0;
	if (cursor >= length) return length - 1;
	return cursor;
}

/** A knob whose value is a `"provider/id"` model spec, picked from a list. */
export function isModelKey(key: string): boolean {
	return key === "model" || key.endsWith(".model");
}

export function createKnobsState(init: KnobsInit): KnobsState {
	return {
		rows: init.rows,
		availableModels: init.availableModels ?? [],
		cursor: clampCursor(init.cursor ?? 0, init.rows.length),
	};
}

export function currentKnob(state: KnobsState): KnobRow | undefined {
	return state.rows[state.cursor];
}

/** Per-scope value for a row. */
export function scopeValue(row: KnobRow, scope: Scope): ScopedValue {
	return scope === "project" ? row.project : row.global;
}

/**
 * Effective value + source: project wins over global, falling back to
 * the schema default. `null` layer values are "unset" and skip down.
 */
export function effectiveKnob(row: KnobRow): {
	value: ScopedValue;
	source: ValueSource;
} {
	if (row.project !== null) return { value: row.project, source: "project" };
	if (row.global !== null) return { value: row.global, source: "global" };
	return { value: (row.default as ScopedValue) ?? null, source: "default" };
}

function setScopeValue(row: KnobRow, scope: Scope, value: ScopedValue): void {
	if (scope === "project") row.project = value;
	else row.global = value;
}

// ---- Navigation -----------------------------------------------------------

export function knobsMoveDown(state: KnobsState): boolean {
	if (state.overlay) return false;
	if (state.cursor >= state.rows.length - 1) return false;
	state.cursor += 1;
	return true;
}

export function knobsMoveUp(state: KnobsState): boolean {
	if (state.overlay) return false;
	if (state.cursor <= 0) return false;
	state.cursor -= 1;
	return true;
}

// ---- Editing entry point --------------------------------------------------

/**
 * Outcome of starting an edit on the current knob:
 *   - `cycled`  — a boolean was toggled in place; persist `value` now.
 *   - `overlay` — a picker/input opened; wait for select/commit.
 *   - `none`    — nothing to edit (empty list).
 */
export type EditOutcome =
	| { type: "cycled"; row: KnobRow; value: ScopedValue }
	| { type: "overlay" }
	| { type: "none" };

function nextBool(current: ScopedValue): ScopedValue {
	if (current === null) return true;
	if (current === true) return false;
	return null;
}

/** Render a scope value as editable text for the input overlay. */
function valueToBuffer(value: ScopedValue): string {
	if (value === null) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

/**
 * Begin editing the current knob at `scope`. Booleans cycle immediately;
 * enum/model open a picker; string/number/string[] open a text input
 * pre-filled with the current scope value.
 */
export function editCurrent(state: KnobsState, scope: Scope): EditOutcome {
	if (state.overlay) return { type: "overlay" };
	const row = currentKnob(state);
	if (!row) return { type: "none" };

	if (row.type === "boolean") {
		const value = nextBool(scopeValue(row, scope));
		setScopeValue(row, scope, value);
		return { type: "cycled", row, value };
	}

	if (row.type === "enum" || (row.type === "string" && isModelKey(row.key))) {
		// Only a string-typed model key opens the model picker; a mis-declared
		// non-string knob that happens to end in `.model` falls through to the
		// text input rather than receiving a string spec it can't hold.
		const options =
			row.type === "enum"
				? [...(row.enumValues ?? [])]
				: [...state.availableModels];
		state.overlay = {
			kind: "picker",
			rowIndex: state.cursor,
			options,
			query: "",
			cursor: 0,
		};
		return { type: "overlay" };
	}

	// string / number / string[]
	state.overlay = {
		kind: "input",
		rowIndex: state.cursor,
		buffer: valueToBuffer(scopeValue(row, scope)),
		caret: valueToBuffer(scopeValue(row, scope)).length,
	};
	return { type: "overlay" };
}

/** Clear the active-scope value of the current knob (→ unset). */
export function resetCurrent(
	state: KnobsState,
	scope: Scope,
): { row: KnobRow } | false {
	if (state.overlay) return false;
	const row = currentKnob(state);
	if (!row) return false;
	if (scopeValue(row, scope) === null) return false;
	setScopeValue(row, scope, null);
	return { row };
}

/** Close any open overlay without committing. */
export function closeOverlay(state: KnobsState): boolean {
	if (!state.overlay) return false;
	state.overlay = undefined;
	return true;
}

// ---- Picker overlay (enum / model) ----------------------------------------

/** Options for the open picker: clear sentinel first, then filtered options. */
export function pickerOptions(state: KnobsState): string[] {
	if (state.overlay?.kind !== "picker") return [];
	const q = state.overlay.query.trim().toLowerCase();
	const matches = q
		? state.overlay.options.filter((o) => o.toLowerCase().includes(q))
		: [...state.overlay.options];
	return [CLEAR_OPTION, ...matches];
}

export function pickerMoveDown(state: KnobsState): boolean {
	if (state.overlay?.kind !== "picker") return false;
	if (state.overlay.cursor >= pickerOptions(state).length - 1) return false;
	state.overlay.cursor += 1;
	return true;
}

export function pickerMoveUp(state: KnobsState): boolean {
	if (state.overlay?.kind !== "picker") return false;
	if (state.overlay.cursor <= 0) return false;
	state.overlay.cursor -= 1;
	return true;
}

export function pickerAppend(state: KnobsState, ch: string): boolean {
	if (state.overlay?.kind !== "picker") return false;
	state.overlay.query += ch;
	state.overlay.cursor = clampCursor(
		state.overlay.cursor,
		pickerOptions(state).length,
	);
	return true;
}

export function pickerBackspace(state: KnobsState): boolean {
	if (state.overlay?.kind !== "picker") return false;
	if (state.overlay.query.length === 0) return false;
	state.overlay.query = state.overlay.query.slice(0, -1);
	state.overlay.cursor = clampCursor(
		state.overlay.cursor,
		pickerOptions(state).length,
	);
	return true;
}

export type Selection =
	| { type: "clear"; row: KnobRow }
	| { type: "set"; row: KnobRow; value: string };

/**
 * Apply the highlighted picker option to the row at `scope`, close the
 * overlay, and return the selection for the caller to persist.
 */
export function pickerSelect(
	state: KnobsState,
	scope: Scope,
): Selection | undefined {
	if (state.overlay?.kind !== "picker") return undefined;
	const opts = pickerOptions(state);
	const choice = opts[state.overlay.cursor];
	const row = state.rows[state.overlay.rowIndex];
	state.overlay = undefined;
	if (!row || choice === undefined) return undefined;

	if (choice === CLEAR_OPTION) {
		setScopeValue(row, scope, null);
		return { type: "clear", row };
	}
	setScopeValue(row, scope, choice);
	return { type: "set", row, value: choice };
}

// ---- Input overlay (string / number / string[]) ---------------------------

export function inputAppend(state: KnobsState, text: string): boolean {
	if (state.overlay?.kind !== "input") return false;
	const o = state.overlay;
	o.buffer = o.buffer.slice(0, o.caret) + text + o.buffer.slice(o.caret);
	o.caret += text.length;
	o.error = undefined;
	return true;
}

export function inputBackspace(state: KnobsState): boolean {
	if (state.overlay?.kind !== "input") return false;
	const o = state.overlay;
	if (o.caret === 0) return false;
	o.buffer = o.buffer.slice(0, o.caret - 1) + o.buffer.slice(o.caret);
	o.caret -= 1;
	o.error = undefined;
	return true;
}

export function inputMoveLeft(state: KnobsState): boolean {
	if (state.overlay?.kind !== "input") return false;
	if (state.overlay.caret <= 0) return false;
	state.overlay.caret -= 1;
	return true;
}

export function inputMoveRight(state: KnobsState): boolean {
	if (state.overlay?.kind !== "input") return false;
	if (state.overlay.caret >= state.overlay.buffer.length) return false;
	state.overlay.caret += 1;
	return true;
}

/** Parse comma/space-separated tokens into a deduped, trimmed list. */
function parseList(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of raw.split(/[\s,]+/)) {
		const trimmed = token.trim();
		if (trimmed.length > 0 && !seen.has(trimmed)) {
			seen.add(trimmed);
			out.push(trimmed);
		}
	}
	return out;
}

export type CommitResult =
	| { type: "set"; row: KnobRow; value: ScopedValue }
	| { type: "invalid"; error: string };

/**
 * Validate + parse the input buffer for the current knob type and apply
 * it at `scope`. On success closes the overlay and returns the value to
 * persist; on failure leaves the overlay open with `error` set and
 * returns `{ type: "invalid" }`.
 *
 * - number : must parse to a finite number (empty → use `reset` to clear).
 * - string[] : comma/space tokens; when `enumValues` is set every token
 *   must be a member; empty buffer → `[]` (explicitly empty).
 * - string : the buffer verbatim (empty string is a valid value).
 */
export function inputCommit(
	state: KnobsState,
	scope: Scope,
): CommitResult | undefined {
	if (state.overlay?.kind !== "input") return undefined;
	const o = state.overlay;
	const row = state.rows[o.rowIndex];
	if (!row) {
		state.overlay = undefined;
		return undefined;
	}
	const raw = o.buffer.trim();

	let value: ScopedValue;
	if (row.type === "number") {
		if (raw.length === 0) {
			o.error = "enter a number (or Esc to cancel)";
			return { type: "invalid", error: o.error };
		}
		const n = Number(raw);
		if (!Number.isFinite(n)) {
			o.error = `"${raw}" is not a number`;
			return { type: "invalid", error: o.error };
		}
		value = n;
	} else if (row.type === "string[]") {
		const list = parseList(o.buffer);
		if (row.enumValues) {
			const allowed = new Set(row.enumValues);
			const bad = list.find((v) => !allowed.has(v));
			if (bad !== undefined) {
				o.error = `"${bad}" is not one of: ${row.enumValues.join(", ")}`;
				return { type: "invalid", error: o.error };
			}
		}
		value = list;
	} else {
		// string: empty string is a meaningful value (e.g. titlePrefix "").
		value = o.buffer;
	}

	setScopeValue(row, scope, value);
	state.overlay = undefined;
	return { type: "set", row, value };
}

// ---- Row building ---------------------------------------------------------

export interface KnobSchema {
	extName: string;
	key: string;
	type: KnobType;
	enumValues?: readonly string[];
	default?: unknown;
	doc: string;
}

/**
 * Build the knob rows from declared schemas, joining each against the
 * per-scope raw value via `lookup`. Pure: `lookup` is the I/O seam the
 * dialog wires to `readExtensionConfigKey`. Rows keep the given schema
 * order (the dialog sorts/groups by extension upstream).
 */
export function buildKnobRows(
	schemas: readonly KnobSchema[],
	lookup: (extName: string, key: string, scope: Scope) => ScopedValue,
): KnobRow[] {
	return schemas.map((s) => ({
		extName: s.extName,
		key: s.key,
		type: s.type,
		enumValues: s.enumValues,
		default: s.default,
		doc: s.doc,
		project: lookup(s.extName, s.key, "project"),
		global: lookup(s.extName, s.key, "global"),
	}));
}
