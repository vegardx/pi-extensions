/**
 * Pure state model for the `/extensions` interactive dialog.
 *
 * The dialog presents two scope tabs (project, global), a list of all
 * declared extensions, and per-scope tri-state values:
 *
 *   - `true`   → key is `true` in this scope's settings.json
 *   - `false`  → key is `false` in this scope's settings.json
 *   - `null`   → key is unset in this scope (no override)
 *
 * Toggling cycles `null → true → false → null` (so the natural first
 * tap on an unset extension turns it on; tap again to force off; tap
 * again to clear). The "effective" column is computed from
 * env > project > global > default(false) and stays read-only.
 *
 * This file has zero TUI / I/O dependencies so the state transitions
 * are exhaustively unit-testable.
 */

export type DialogScope = "project" | "global";

export type ScopedValue = boolean | null;

/**
 * Where the currently-loaded effective value came from. `env` and
 * `default` aren't writable from the dialog (env is a runtime override
 * outside settings.json; default is the absence of any override). We
 * still display them so the user can see why an extension is on or
 * off this session.
 */
export type EffectiveSource = "env" | "project" | "global" | "default";

export interface ExtensionRow {
	/** Extension identifier — `extensionConfig.<name>`. */
	name: string;
	/** Optional one-line doc. */
	doc?: string;
	/** Hard `dependsOn` declarations. */
	dependsOn: readonly string[];
	/** Soft `integratesWith` declarations. */
	integratesWith: readonly string[];
	/** Value at project scope (or `null` if unset). */
	project: ScopedValue;
	/** Value at global scope (or `null` if unset). */
	global: ScopedValue;
	/** The runtime effective value at session start. */
	effective: boolean;
	/** Where the effective value came from. */
	effectiveSource: EffectiveSource;
}

export interface DialogState {
	scope: DialogScope;
	rows: ExtensionRow[];
	cursor: number;
}

export interface DialogInit {
	rows: ExtensionRow[];
	scope?: DialogScope;
	cursor?: number;
}

/** Build a fresh dialog state from a row snapshot. */
export function createState(init: DialogInit): DialogState {
	return {
		scope: init.scope ?? "project",
		rows: init.rows,
		cursor: clampCursor(init.cursor ?? 0, init.rows.length),
	};
}

function clampCursor(cursor: number, length: number): number {
	if (length === 0) return 0;
	if (cursor < 0) return 0;
	if (cursor >= length) return length - 1;
	return cursor;
}

/** Returns the row under the cursor, or `undefined` if the list is empty. */
export function currentRow(state: DialogState): ExtensionRow | undefined {
	return state.rows[state.cursor];
}

/** Returns the value of the row at `<index>` for the active scope. */
export function valueAt(state: DialogState, index: number): ScopedValue {
	const row = state.rows[index];
	if (!row) return null;
	return state.scope === "project" ? row.project : row.global;
}

export function moveDown(state: DialogState): boolean {
	if (state.cursor >= state.rows.length - 1) return false;
	state.cursor += 1;
	return true;
}

export function moveUp(state: DialogState): boolean {
	if (state.cursor <= 0) return false;
	state.cursor -= 1;
	return true;
}

export function setScope(state: DialogState, scope: DialogScope): boolean {
	if (state.scope === scope) return false;
	state.scope = scope;
	return true;
}

/**
 * Cycle the value at the current scope: `null → true → false → null`.
 * Returns the new value. Mutates `state` in place; callers persist
 * the change to settings.json themselves.
 */
export function cycleCurrent(state: DialogState): ScopedValue {
	const row = currentRow(state);
	if (!row) return null;
	const current = state.scope === "project" ? row.project : row.global;
	const next = nextValue(current);
	if (state.scope === "project") row.project = next;
	else row.global = next;
	return next;
}

/**
 * Reset (clear) the value at the current scope. Returns `true` if a
 * value was cleared, `false` if it was already unset.
 */
export function resetCurrent(state: DialogState): boolean {
	const row = currentRow(state);
	if (!row) return false;
	const current = state.scope === "project" ? row.project : row.global;
	if (current === null) return false;
	if (state.scope === "project") row.project = null;
	else row.global = null;
	return true;
}

function nextValue(current: ScopedValue): ScopedValue {
	if (current === null) return true;
	if (current === true) return false;
	return null;
}
