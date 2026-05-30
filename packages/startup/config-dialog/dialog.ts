/**
 * Interactive `/config` dialog — a three-page panel over the settings
 * this monorepo cares about:
 *
 *   - **Extensions**: flip `extensionConfig.<name>.enabled` per scope.
 *   - **Models**: set `backgroundModels.<set>.<tier>` per scope via a
 *     filterable model picker.
 *   - **Context**: read-only list of the AGENTS.md / CLAUDE.md files
 *     pi loads for this session.
 *
 * Pages share the project / global scope tabs (Extensions and Models
 * write to the same two settings.json files; Context is scope-agnostic
 * and read-only). Every write lands in settings.json immediately —
 * Esc / Ctrl+C don't roll back.
 *
 * Render and state are split: `config-state.ts`, `extensions-state.ts`,
 * and `models-state.ts` hold the pure, exhaustively-tested models; this
 * file owns the TUI bindings (key handling, layout, theme calls).
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { ExtensionMetadata } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import {
	writeBackgroundModel,
	writeExtensionConfigKey,
} from "@vegardx/pi-extensions-shared/settings-writer.js";
import type { ContextFileInfo } from "../index.js";

import { buildRows, readModelRows } from "./build-rows.js";
import {
	type ConfigPage,
	type ConfigState,
	createConfigState,
	nextPage,
	pageUsesScope,
	prevPage,
	setConfigScope,
} from "./config-state.js";
import {
	currentRow,
	cycleCurrent,
	type DialogState,
	type ExtensionRow,
	moveDown,
	moveUp,
	resetCurrent,
	type ScopedValue,
} from "./extensions-state.js";
import {
	closePicker,
	currentModelRow,
	effectiveModel,
	effectiveModelSource,
	type ModelRow,
	type ModelsState,
	modelsMoveDown,
	modelsMoveUp,
	openPicker,
	pickerAppend,
	pickerBackspace,
	pickerMoveDown,
	pickerMoveUp,
	pickerOptions,
	pickerSelect,
} from "./models-state.js";

const ENABLED_KEY = "enabled";

export interface ShowConfigDialogOptions {
	/** Extensions to display, typically the metadata registry. */
	declared: readonly ExtensionMetadata[];
	/** Context files pi loads for this session (discovered by the caller). */
	contextFiles: ContextFileInfo[];
	/** Auth-configured `"provider/id"` specs for the model picker. */
	availableModels: string[];
	/** Page to open on. Defaults to "extensions". */
	initialPage?: ConfigPage;
	/** Override the agent dir for tests. */
	agentDir?: string;
}

/**
 * Open the dialog. Returns when the user dismisses it. Writes happen
 * incrementally as the user edits, so there's nothing to commit or roll
 * back — the return value is void.
 */
export async function showConfigDialog(
	ctx: ExtensionContext,
	opts: ShowConfigDialogOptions,
): Promise<void> {
	if (!ctx.hasUI) return;

	const extensionRows = buildRows({
		cwd: ctx.cwd,
		agentDir: opts.agentDir,
		declared: opts.declared,
	});
	const modelRows = readModelRows({ cwd: ctx.cwd, agentDir: opts.agentDir });

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const state = createConfigState({
			extensionRows,
			modelRows,
			availableModels: opts.availableModels,
			contextFiles: opts.contextFiles,
			page: opts.initialPage,
		});
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function persistExtension(): void {
			const row = currentRow(state.extensions);
			if (!row) return;
			const value = state.scope === "project" ? row.project : row.global;
			try {
				writeExtensionConfigKey(
					state.scope,
					ctx.cwd,
					row.name,
					ENABLED_KEY,
					value,
					opts.agentDir,
				);
			} catch (err) {
				notifyError(ctx, state.scope, err);
			}
		}

		function persistModel(row: ModelRow): void {
			const value = state.scope === "project" ? row.project : row.global;
			try {
				writeBackgroundModel(
					state.scope,
					ctx.cwd,
					row.set,
					row.tier,
					value,
					opts.agentDir,
				);
			} catch (err) {
				notifyError(ctx, state.scope, err);
			}
		}

		function handlePickerInput(data: string): void {
			const ms = state.models;
			if (matchesKey(data, Key.escape)) {
				if (closePicker(ms)) refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (pickerMoveUp(ms)) refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (pickerMoveDown(ms)) refresh();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				if (pickerBackspace(ms)) refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const sel = pickerSelect(ms, state.scope);
				if (sel) persistModel(sel.row);
				refresh();
				return;
			}
			const ch = printableChar(data);
			if (ch) {
				if (pickerAppend(ms, ch)) refresh();
			}
		}

		function handleInput(data: string): void {
			// Picker overlay swallows all input (including p/g/q) so the
			// user can type a filter freely.
			if (state.page === "models" && state.models.picker) {
				handlePickerInput(data);
				return;
			}

			if (matchesKey(data, Key.escape) || data === "q") {
				done(undefined);
				return;
			}
			if (matchesKey(data, Key.tab)) {
				nextPage(state);
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab"))) {
				prevPage(state);
				refresh();
				return;
			}

			if (pageUsesScope(state.page)) {
				if (matchesKey(data, Key.left) || data === "p") {
					if (setConfigScope(state, "project")) refresh();
					return;
				}
				if (matchesKey(data, Key.right) || data === "g") {
					if (setConfigScope(state, "global")) refresh();
					return;
				}
			}

			if (matchesKey(data, Key.up)) {
				if (pageMoveUp(state)) refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (pageMoveDown(state)) refresh();
				return;
			}

			if (state.page === "extensions") {
				if (matchesKey(data, Key.enter) || data === " ") {
					cycleCurrent(state.extensions);
					persistExtension();
					refresh();
					return;
				}
				if (data === "r") {
					if (resetCurrent(state.extensions)) {
						persistExtension();
						refresh();
					}
					return;
				}
			} else if (state.page === "models") {
				if (matchesKey(data, Key.enter) || data === " ") {
					if (openPicker(state.models)) refresh();
					return;
				}
				if (data === "r") {
					if (clearCurrentModel(state)) {
						const row = currentModelRow(state.models);
						if (row) persistModel(row);
						refresh();
					}
					return;
				}
			}
		}

		function render(width: number): string[] {
			if (cachedLines !== undefined && width === cachedWidth) {
				return cachedLines;
			}
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));
			renderHeader(state, theme, add);
			lines.push("");
			renderPageTabs(state, theme, width, add);
			lines.push("");
			if (pageUsesScope(state.page)) {
				renderScopeTabs(state, theme, width, add);
				lines.push("");
			}

			if (state.page === "extensions") {
				renderExtensionsTable(state.extensions, theme, width, add);
				lines.push("");
				renderExtensionDetail(state.extensions, theme, width, add);
			} else if (state.page === "models") {
				if (state.models.picker) {
					renderPicker(state.models, theme, width, add);
				} else {
					renderModelsTable(state, theme, width, add);
				}
			} else {
				renderContext(state.context.files, theme, width, add);
			}

			lines.push("");
			renderFooter(state, theme, width, add);
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
				cachedWidth = -1;
			},
			handleInput,
		};
	});
}

// ---------------------------------------------------------------------------
// Page-aware navigation
// ---------------------------------------------------------------------------

function pageMoveUp(state: ConfigState): boolean {
	if (state.page === "extensions") return moveUp(state.extensions);
	if (state.page === "models") return modelsMoveUp(state.models);
	return contextMoveUp(state);
}

function pageMoveDown(state: ConfigState): boolean {
	if (state.page === "extensions") return moveDown(state.extensions);
	if (state.page === "models") return modelsMoveDown(state.models);
	return contextMoveDown(state);
}

function contextMoveUp(state: ConfigState): boolean {
	if (state.context.cursor <= 0) return false;
	state.context.cursor -= 1;
	return true;
}

function contextMoveDown(state: ConfigState): boolean {
	if (state.context.cursor >= state.context.files.length - 1) return false;
	state.context.cursor += 1;
	return true;
}

/** Clear the active-scope value of the current model row in memory. */
function clearCurrentModel(state: ConfigState): boolean {
	const row = currentModelRow(state.models);
	if (!row) return false;
	const current = state.scope === "project" ? row.project : row.global;
	if (current === null) return false;
	if (state.scope === "project") row.project = null;
	else row.global = null;
	return true;
}

function notifyError(ctx: ExtensionContext, scope: string, err: unknown): void {
	ctx.ui.notify(
		`Failed to write ${scope} settings: ${
			err instanceof Error ? err.message : String(err)
		}`,
		"error",
	);
}

/**
 * Extract a single printable character from terminal input, if any.
 * Handles both raw bytes (legacy terminals) and Kitty CSI-u sequences.
 */
function printableChar(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty) return kitty;
	if (data.length === 1 && data >= " " && data !== "\x7f") return data;
	return undefined;
}

// ---------------------------------------------------------------------------
// Render helpers — chrome
// ---------------------------------------------------------------------------

function renderHeader(
	state: ConfigState,
	theme: Theme,
	add: (s: string) => void,
): void {
	const total = state.extensions.rows.length;
	const enabled = state.extensions.rows.filter((r) => r.effective).length;
	add(
		` ${theme.fg("accent", theme.bold("pi config"))}  ${theme.fg(
			"muted",
			`· ${enabled} of ${total} extensions loaded this session`,
		)}`,
	);
}

function renderPageTabs(
	state: ConfigState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const tab = (label: string, page: ConfigPage) => {
		const text = ` ${label} `;
		return state.page === page
			? theme.bg("selectedBg", theme.fg("text", text))
			: theme.fg("muted", text);
	};
	add(
		truncateToWidth(
			` ${tab("Extensions", "extensions")} ${theme.fg("dim", "·")} ${tab(
				"Models",
				"models",
			)} ${theme.fg("dim", "·")} ${tab("Context", "context")}  ${theme.fg(
				"dim",
				"Tab to switch",
			)}`,
			width,
		),
	);
}

function renderScopeTabs(
	state: ConfigState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const tab = (label: string, active: boolean) => {
		const text = ` ${label} `;
		return active
			? theme.bg("selectedBg", theme.fg("text", text))
			: theme.fg("muted", text);
	};
	const project = tab(
		"Project (./.pi/settings.json)",
		state.scope === "project",
	);
	const global = tab(
		"Global  (~/.pi/agent/settings.json)",
		state.scope === "global",
	);
	add(
		truncateToWidth(
			` ${project} ${theme.fg("dim", "·")} ${global}  ${theme.fg(
				"dim",
				"←/→ or p/g to switch",
			)}`,
			width,
		),
	);
}

function renderFooter(
	state: ConfigState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	let help: string;
	if (state.page === "models" && state.models.picker) {
		help = " type to filter • ↑↓ select • enter set • esc cancel";
	} else if (state.page === "extensions") {
		help =
			" Tab page • ←/→ scope • ↑↓ select • space/enter cycle • r reset • q/Esc close";
	} else if (state.page === "models") {
		help =
			" Tab page • ←/→ scope • ↑↓ select • enter pick model • r clear • q/Esc close";
	} else {
		help = " Tab page • ↑↓ scroll • q/Esc close";
	}
	add(truncateToWidth(theme.fg("dim", help), width));
	if (state.page !== "context") {
		add(
			truncateToWidth(
				theme.fg(
					"dim",
					" changes write to settings.json immediately · effects take a session restart",
				),
				width,
			),
		);
	}
}

// ---------------------------------------------------------------------------
// Render helpers — Extensions page
// ---------------------------------------------------------------------------

function renderExtensionsTable(
	state: DialogState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	if (state.rows.length === 0) {
		add(`  ${theme.fg("dim", "(no extensions declared)")}`);
		return;
	}
	const nameWidth = Math.max(8, ...state.rows.map((r) => visibleWidth(r.name)));
	const header = `  ${pad("extension", nameWidth)}  ${pad("project", 9)}  ${pad("global", 9)}  effective`;
	add(theme.fg("muted", header));
	for (let i = 0; i < state.rows.length; i++) {
		const row = state.rows[i];
		const selected = i === state.cursor;
		const cursor = selected ? theme.fg("accent", "▸") : " ";
		const name = pad(row.name, nameWidth);
		const projectCell = scopedCell(
			theme,
			row.project,
			state.scope === "project" && selected,
		);
		const globalCell = scopedCell(
			theme,
			row.global,
			state.scope === "global" && selected,
		);
		const effective = effectiveCell(theme, row);
		const text = ` ${cursor} ${theme.fg("text", name)}  ${projectCell}  ${globalCell}  ${effective}`;
		add(truncateToWidth(text, width));
	}
}

function renderExtensionDetail(
	state: DialogState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const row = currentRow(state);
	if (!row) return;
	if (row.doc) {
		for (const line of wrap(row.doc, width - 4)) {
			add(`  ${theme.fg("muted", line)}`);
		}
	}
	if (row.dependsOn.length > 0) {
		add(
			`  ${theme.fg("muted", "dependsOn:")}      ${row.dependsOn.join(", ")}`,
		);
	}
	if (row.integratesWith.length > 0) {
		add(
			`  ${theme.fg("muted", "integratesWith:")} ${row.integratesWith.join(", ")}`,
		);
	}
	add(
		`  ${theme.fg("muted", "effective:")}      ${effectiveDescription(theme, row)}`,
	);
}

function scopedCell(
	theme: Theme,
	value: ScopedValue,
	highlight: boolean,
): string {
	const text = pad(formatScoped(value), 9);
	if (highlight) {
		return theme.bg("selectedBg", theme.fg(scopedColour(value), text));
	}
	return theme.fg(scopedColour(value), text);
}

function scopedColour(value: ScopedValue): "success" | "warning" | "dim" {
	if (value === true) return "success";
	if (value === false) return "warning";
	return "dim";
}

function formatScoped(value: ScopedValue): string {
	if (value === true) return "● on";
	if (value === false) return "○ off";
	return "—";
}

function effectiveCell(theme: Theme, row: ExtensionRow): string {
	const symbol = row.effective
		? theme.fg("success", "● enabled")
		: theme.fg("dim", "○ disabled");
	return `${symbol}${theme.fg("muted", ` (${row.effectiveSource})`)}`;
}

function effectiveDescription(theme: Theme, row: ExtensionRow): string {
	const s = row.effective
		? theme.fg("success", "enabled")
		: theme.fg("dim", "disabled");
	return `${s} ${theme.fg("muted", `(via ${row.effectiveSource})`)}`;
}

// ---------------------------------------------------------------------------
// Render helpers — Models page
// ---------------------------------------------------------------------------

function renderModelsTable(
	state: ConfigState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const ms = state.models;
	if (ms.available.length === 0) {
		// Still show the rows below so current values are visible; the
		// picker just won't have anything to choose from.
		add(
			`  ${theme.fg("warning", "No auth-configured models found — run /login or configure models.json.")}`,
		);
	}
	const labelWidth = Math.max(
		12,
		...ms.rows.map((r) => visibleWidth(`${r.set}.${r.tier}`)),
	);
	const header = `  ${pad("tier", labelWidth)}  ${pad("project", 22)}  ${pad("global", 22)}  effective`;
	add(theme.fg("muted", header));
	for (let i = 0; i < ms.rows.length; i++) {
		const row = ms.rows[i];
		const selected = i === ms.cursor;
		const cursor = selected ? theme.fg("accent", "▸") : " ";
		const label = pad(`${row.set}.${row.tier}`, labelWidth);
		const projectCell = modelCell(
			theme,
			row.project,
			state.scope === "project" && selected,
		);
		const globalCell = modelCell(
			theme,
			row.global,
			state.scope === "global" && selected,
		);
		const eff = effectiveModel(row);
		const effText =
			eff === null
				? theme.fg("dim", "—")
				: `${theme.fg("text", eff)} ${theme.fg(
						"muted",
						`(${effectiveModelSource(row)})`,
					)}`;
		const text = ` ${cursor} ${theme.fg("text", label)}  ${projectCell}  ${globalCell}  ${effText}`;
		add(truncateToWidth(text, width));
	}
}

function modelCell(
	theme: Theme,
	value: string | null,
	highlight: boolean,
): string {
	const text = pad(value ?? "—", 22);
	const colour = value === null ? "dim" : "success";
	if (highlight) {
		return theme.bg("selectedBg", theme.fg(colour, text));
	}
	return theme.fg(colour, text);
}

function renderPicker(
	ms: ModelsState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const row = ms.rows[ms.picker?.rowIndex ?? 0];
	const label = row ? `${row.set}.${row.tier}` : "?";
	add(
		`  ${theme.fg("accent", `Set model for ${label}`)}  ${theme.fg(
			"muted",
			"(no provider/secondary fallback — literal value)",
		)}`,
	);
	const query = ms.picker?.query ?? "";
	add(
		`  ${theme.fg("muted", "filter:")} ${theme.fg("text", query || " ")}${theme.fg("dim", "▏")}`,
	);
	const opts = pickerOptions(ms);
	const cursor = ms.picker?.cursor ?? 0;
	const MAX = 12;
	const start = Math.min(
		Math.max(0, cursor - Math.floor(MAX / 2)),
		Math.max(0, opts.length - MAX),
	);
	const shown = opts.slice(start, start + MAX);
	shown.forEach((opt, idx) => {
		const i = start + idx;
		const selected = i === cursor;
		const marker = selected ? theme.fg("accent", "▸") : " ";
		const body = selected
			? theme.bg("selectedBg", theme.fg("text", ` ${pad(opt, width - 6)}`))
			: theme.fg("text", ` ${opt}`);
		add(truncateToWidth(` ${marker}${body}`, width));
	});
	if (opts.length > shown.length) {
		add(
			`  ${theme.fg("dim", `… ${opts.length - shown.length} more (type to filter)`)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Render helpers — Context page
// ---------------------------------------------------------------------------

function renderContext(
	files: ContextFileInfo[],
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	if (files.length === 0) {
		add(`  ${theme.fg("dim", "(no context files found)")}`);
		return;
	}
	const total = files.reduce((s, f) => s + f.tokens, 0);
	const totalStr =
		total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
	add(
		theme.fg(
			"muted",
			`  ${files.length} file${files.length === 1 ? "" : "s"} · ${totalStr} tokens · order: global → project`,
		),
	);
	for (const f of files) {
		const scope = pad(f.scope, 7);
		const meta = theme.fg("muted", `(${f.tokens} tok · ${f.lines} lines)`);
		add(
			truncateToWidth(
				`  ${theme.fg("dim", scope)}  ${theme.fg("text", f.displayPath)}  ${meta}`,
				width,
			),
		);
	}
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

function wrap(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (!current) {
			current = word;
			continue;
		}
		if (visibleWidth(current) + 1 + visibleWidth(word) <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}
