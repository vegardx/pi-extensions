/**
 * Interactive `/config` dialog — a four-page panel over the settings
 * this monorepo cares about:
 *
 *   - **Extensions**: flip `extensionConfig.<name>.enabled` per scope.
 *   - **Models**: set `backgroundModels.<set>.<tier>` per scope via a
 *     filterable model picker.
 *   - **Settings**: edit every declared `extensionConfig.<ext>.<key>`
 *     knob per scope — booleans cycle, enum/model open a picker,
 *     string/number/string[] use a text-input overlay.
 *   - **Context**: read-only list of the AGENTS.md / CLAUDE.md files
 *     pi loads for this session.
 *
 * Pages share the project / global scope tabs (Extensions, Models and
 * Settings write to the same two settings.json files; Context is
 * scope-agnostic and read-only). Every write lands in settings.json
 * immediately — Esc / Ctrl+C don't roll back.
 *
 * Render and state are split: `config-state.ts`, `extensions-state.ts`,
 * `models-state.ts`, and `knobs-state.ts` hold the pure, exhaustively-
 * tested models; this file owns the TUI bindings (key handling, layout,
 * theme calls).
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

import { buildRows, readKnobRows, readModelRows } from "./build-rows.js";
import {
	atTopRow,
	type ConfigPage,
	type ConfigState,
	createConfigState,
	currentSettingsExtension,
	enterSettingsExtension,
	focusBody,
	focusMenu,
	leaveSettingsExtension,
	nextPage,
	pageUsesScope,
	prevPage,
	setConfigScope,
	settingsInDetail,
	settingsMoveDown,
	settingsMoveUp,
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
	closeOverlay as closeKnobOverlay,
	currentKnob,
	editCurrent as editKnob,
	effectiveKnob,
	inputAppend,
	inputBackspace,
	inputCommit,
	inputMoveLeft,
	inputMoveRight,
	isModelKey,
	type KnobRow,
	type KnobsState,
	type ScopedValue as KnobValue,
	pickerAppend as knobPickerAppend,
	pickerBackspace as knobPickerBackspace,
	pickerMoveDown as knobPickerMoveDown,
	pickerMoveUp as knobPickerMoveUp,
	pickerOptions as knobPickerOptions,
	pickerSelect as knobPickerSelect,
	scopeValue as knobScopeValue,
	knobsMoveDown,
	knobsMoveUp,
	resetCurrent as resetKnob,
} from "./knobs-state.js";
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
	const knobRows = readKnobRows({
		cwd: ctx.cwd,
		agentDir: opts.agentDir,
		declared: opts.declared,
	});

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const state = createConfigState({
			extensionRows,
			modelRows,
			knobRows,
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

		function persistKnob(row: KnobRow): void {
			const value = knobScopeValue(row, state.scope);
			try {
				writeExtensionConfigKey(
					state.scope,
					ctx.cwd,
					row.extName,
					row.key,
					value as boolean | string | number | string[] | null,
					opts.agentDir,
				);
			} catch (err) {
				notifyError(ctx, state.scope, err);
			}
		}

		function handleKnobOverlayInput(data: string): void {
			const ks = state.knobs;
			const overlay = ks.overlay;
			if (!overlay) return;
			if (matchesKey(data, Key.escape)) {
				if (closeKnobOverlay(ks)) refresh();
				return;
			}
			if (overlay.kind === "picker") {
				if (matchesKey(data, Key.up)) {
					if (knobPickerMoveUp(ks)) refresh();
				} else if (matchesKey(data, Key.down)) {
					if (knobPickerMoveDown(ks)) refresh();
				} else if (matchesKey(data, Key.backspace)) {
					if (knobPickerBackspace(ks)) refresh();
				} else if (matchesKey(data, Key.enter)) {
					const sel = knobPickerSelect(ks, state.scope);
					if (sel) persistKnob(sel.row);
					refresh();
				} else {
					const ch = printableChar(data);
					if (ch && knobPickerAppend(ks, ch)) refresh();
				}
				return;
			}
			// text input overlay
			if (matchesKey(data, Key.left)) {
				if (inputMoveLeft(ks)) refresh();
			} else if (matchesKey(data, Key.right)) {
				if (inputMoveRight(ks)) refresh();
			} else if (matchesKey(data, Key.backspace)) {
				if (inputBackspace(ks)) refresh();
			} else if (matchesKey(data, Key.enter)) {
				const res = inputCommit(ks, state.scope);
				if (res?.type === "set") persistKnob(res.row);
				refresh();
			} else {
				const ch = printableChar(data);
				if (ch && inputAppend(ks, ch)) refresh();
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
			// Picker overlay swallows all input (including q) so the user
			// can type a filter freely.
			if (state.page === "models" && state.models.picker) {
				handlePickerInput(data);
				return;
			}
			if (state.page === "settings" && state.knobs.overlay) {
				handleKnobOverlayInput(data);
				return;
			}

			if (state.page === "settings" && settingsInDetail(state)) {
				if (matchesKey(data, Key.escape)) {
					if (leaveSettingsExtension(state)) refresh();
					return;
				}
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			if (data === "q") {
				done(undefined);
				return;
			}

			// Tab/Shift+Tab switch pages from either zone (kept as aliases
			// for the arrow-driven menu navigation).
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

			if (state.focus === "menu") {
				handleMenuInput(data);
				return;
			}
			handleBodyInput(data);
		}

		// Menu zone: arrows switch page, down/enter drop into the body.
		function handleMenuInput(data: string): void {
			if (matchesKey(data, Key.left)) {
				prevPage(state);
				refresh();
				return;
			}
			if (matchesKey(data, Key.right)) {
				nextPage(state);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
				if (focusBody(state)) refresh();
			}
		}

		// Body zone: up/down move rows (up off the top row pops to the
		// menu), left/right flip the project/global column.
		function handleBodyInput(data: string): void {
			if (matchesKey(data, Key.up)) {
				if (atTopRow(state)) {
					if (focusMenu(state)) refresh();
				} else if (pageMoveUp(state)) {
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (pageMoveDown(state)) refresh();
				return;
			}

			if (
				pageUsesScope(state.page) &&
				!(state.page === "settings" && !settingsInDetail(state))
			) {
				if (matchesKey(data, Key.left)) {
					if (
						state.page === "settings" &&
						settingsInDetail(state) &&
						state.scope === "project"
					) {
						if (leaveSettingsExtension(state)) refresh();
					} else if (setConfigScope(state, "project")) refresh();
					return;
				}
				if (matchesKey(data, Key.right)) {
					if (setConfigScope(state, "global")) refresh();
					return;
				}
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
			} else if (state.page === "settings") {
				if (!settingsInDetail(state)) {
					if (
						matchesKey(data, Key.enter) ||
						matchesKey(data, Key.right) ||
						data === " "
					) {
						if (enterSettingsExtension(state)) refresh();
						return;
					}
					return;
				}
				if (matchesKey(data, Key.left)) {
					if (leaveSettingsExtension(state)) refresh();
					return;
				}
				if (matchesKey(data, Key.enter) || data === " ") {
					const outcome = editKnob(state.knobs, state.scope);
					if (outcome.type === "cycled") persistKnob(outcome.row);
					refresh();
					return;
				}
				if (data === "r") {
					const res = resetKnob(state.knobs, state.scope);
					if (res) {
						persistKnob(res.row);
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

			if (state.page === "extensions") {
				renderExtensionsTable(
					state.extensions,
					state.focus === "body",
					theme,
					width,
					add,
				);
				lines.push("");
				renderExtensionDetail(state.extensions, theme, width, add);
			} else if (state.page === "models") {
				if (state.models.picker) {
					renderPicker(state.models, theme, width, add);
				} else {
					renderModelsTable(state, theme, width, add);
				}
			} else if (state.page === "settings") {
				if (state.knobs.overlay?.kind === "picker") {
					renderKnobPicker(state.knobs, theme, width, add);
				} else if (!settingsInDetail(state)) {
					renderSettingsExtensionSelector(state, theme, width, add);
				} else {
					renderKnobsTable(state, theme, width, add);
					lines.push("");
					if (state.knobs.overlay?.kind === "input") {
						renderKnobInput(state.knobs, theme, width, add);
					} else {
						renderKnobDetail(state.knobs, theme, width, add);
					}
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
	if (state.page === "settings") {
		return settingsInDetail(state)
			? knobsMoveUp(state.knobs)
			: settingsMoveUp(state);
	}
	return contextMoveUp(state);
}

function pageMoveDown(state: ConfigState): boolean {
	if (state.page === "extensions") return moveDown(state.extensions);
	if (state.page === "models") return modelsMoveDown(state.models);
	if (state.page === "settings") {
		return settingsInDetail(state)
			? knobsMoveDown(state.knobs)
			: settingsMoveDown(state);
	}
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
	const menuFocused = state.focus === "menu";
	const tab = (label: string, page: ConfigPage) => {
		const active = state.page === page;
		const text = active && menuFocused ? `▸${label} ` : ` ${label} `;
		if (active) {
			// Brighter (text fg) when the menu owns focus; muted-but-marked
			// when focus is in the body so the active page is still legible.
			return menuFocused
				? theme.bg("selectedBg", theme.bold(theme.fg("text", text)))
				: theme.bg("selectedBg", theme.fg("text", text));
		}
		return theme.fg("muted", text);
	};
	const hint = menuFocused ? "←/→ switch page · ↓ enter" : "↑ to focus menu";
	const dot = theme.fg("dim", "·");
	add(
		truncateToWidth(
			` ${tab("Extensions", "extensions")} ${dot} ${tab("Models", "models")} ${dot} ${tab("Settings", "settings")} ${dot} ${tab("Context", "context")}  ${theme.fg(
				"dim",
				hint,
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
	} else if (
		state.page === "settings" &&
		state.knobs.overlay?.kind === "picker"
	) {
		help = " type to filter • ↑↓ select • enter set • esc cancel";
	} else if (
		state.page === "settings" &&
		state.knobs.overlay?.kind === "input"
	) {
		help = " type a value • ←/→ caret • enter commit • esc cancel";
	} else if (state.focus === "menu") {
		help = " ←/→ switch page • ↓ enter list • q/Esc close";
	} else if (state.page === "extensions") {
		help =
			" ↑↓ rows • ←/→ project/global • space/enter cycle • r reset • Tab page • q/Esc close";
	} else if (state.page === "models") {
		help =
			" ↑↓ rows • ←/→ project/global • enter pick model • r clear • Tab page • q/Esc close";
	} else if (state.page === "settings" && !settingsInDetail(state)) {
		help = " ↑↓ extensions • enter open options • Tab page • q/Esc close";
	} else if (state.page === "settings") {
		help =
			" ↑↓ rows • ←/→ project/global • space/enter edit • r reset • Esc back • Tab page • q close";
	} else {
		help = " ↑↓ scroll • Tab page • q/Esc close";
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
	bodyFocused: boolean,
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
		const selected = bodyFocused && i === state.cursor;
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
	if (value === true) return "true";
	if (value === false) return "false";
	return "undef";
}

function effectiveCell(theme: Theme, row: ExtensionRow): string {
	const label = row.effective
		? theme.fg("success", "true")
		: theme.fg("dim", "false");
	return `${label}${theme.fg("muted", ` (${row.effectiveSource})`)}`;
}

function effectiveDescription(theme: Theme, row: ExtensionRow): string {
	const s = row.effective
		? theme.fg("success", "true")
		: theme.fg("dim", "false");
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
	const bodyFocused = state.focus === "body";
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
		const selected = bodyFocused && i === ms.cursor;
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
// Render helpers — Settings page
// ---------------------------------------------------------------------------

function formatKnobValue(value: KnobValue): string {
	if (value === null) return "—";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) return `[${value.join(", ")}]`;
	return String(value);
}

function knobColour(value: KnobValue): "success" | "warning" | "dim" {
	if (value === null) return "dim";
	if (value === false) return "warning";
	return "success";
}

function knobCell(theme: Theme, value: KnobValue, highlight: boolean): string {
	const text = pad(formatKnobValue(value), 16);
	if (highlight)
		return theme.bg("selectedBg", theme.fg(knobColour(value), text));
	return theme.fg(knobColour(value), text);
}

function renderSettingsExtensionSelector(
	state: ConfigState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const rows = state.settings.extensions;
	const bodyFocused = state.focus === "body";
	if (rows.length === 0) {
		add(`  ${theme.fg("dim", "(no configurable knobs declared)")}`);
		return;
	}
	add(`  ${theme.fg("accent", "Select extension to configure")}`);
	add("");
	const nameWidth = Math.max(9, ...rows.map((r) => visibleWidth(r.name)));
	const header = `  ${pad("extension", nameWidth)}  options`;
	add(theme.fg("muted", header));
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const selected = bodyFocused && i === state.settings.cursor;
		const cursor = selected ? theme.fg("accent", "▸") : " ";
		const name = pad(row.name, nameWidth);
		add(
			truncateToWidth(
				` ${cursor} ${theme.fg("text", name)}  ${theme.fg("muted", String(row.knobCount))}`,
				width,
			),
		);
	}
	const row = currentSettingsExtension(state);
	if (row?.doc) {
		add("");
		add(`  ${theme.fg("accent", row.name)}`);
		for (const line of wrap(row.doc, width - 4)) {
			add(`  ${theme.fg("muted", line)}`);
		}
	}
}

function renderKnobsTable(
	state: ConfigState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const ks = state.knobs;
	const bodyFocused = state.focus === "body";
	const extName = state.settings.selectedExtName ?? "?";
	add(`  ${theme.fg("accent", `Settings › ${extName}`)}`);
	add("");
	if (ks.rows.length === 0) {
		add(`  ${theme.fg("dim", "(no configurable knobs declared)")}`);
		return;
	}
	const keyWidth = Math.min(
		30,
		Math.max(8, ...ks.rows.map((r) => visibleWidth(r.key))),
	);
	const header = `    ${pad("key", keyWidth)}  ${pad("project", 16)}  ${pad("global", 16)}  effective`;
	add(theme.fg("muted", header));
	for (let i = 0; i < ks.rows.length; i++) {
		const row = ks.rows[i];
		const selected = bodyFocused && i === ks.cursor;
		const cursor = selected ? theme.fg("accent", "▸") : " ";
		const key = pad(row.key, keyWidth);
		const projectCell = knobCell(
			theme,
			row.project,
			state.scope === "project" && selected,
		);
		const globalCell = knobCell(
			theme,
			row.global,
			state.scope === "global" && selected,
		);
		const eff = effectiveKnob(row);
		const effText =
			eff.value === null
				? theme.fg("dim", "—")
				: `${theme.fg("text", formatKnobValue(eff.value))} ${theme.fg(
						"muted",
						`(${eff.source})`,
					)}`;
		add(
			truncateToWidth(
				` ${cursor} ${theme.fg("text", key)}  ${projectCell}  ${globalCell}  ${effText}`,
				width,
			),
		);
	}
}

function renderKnobDetail(
	ks: KnobsState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const row = currentKnob(ks);
	if (!row) return;
	add(`  ${theme.fg("accent", row.key)} ${theme.fg("muted", `· ${row.type}`)}`);
	for (const line of wrap(row.doc, width - 4)) {
		add(`  ${theme.fg("muted", line)}`);
	}
	if ((row.type === "enum" || row.type === "string[]") && row.enumValues) {
		add(`  ${theme.fg("muted", "choices:")}   ${row.enumValues.join(", ")}`);
	} else if (isModelKey(row.key)) {
		add(
			`  ${theme.fg("muted", "choices:")}   ${theme.fg("dim", `${ks.availableModels.length} configured models (filterable)`)}`,
		);
	}
	if (row.default !== undefined) {
		add(
			`  ${theme.fg("muted", "default:")}   ${formatKnobValue(row.default as KnobValue)}`,
		);
	}
	const eff = effectiveKnob(row);
	add(
		`  ${theme.fg("muted", "effective:")} ${formatKnobValue(eff.value)} ${theme.fg("muted", `(via ${eff.source})`)}`,
	);
}

function renderKnobInput(
	ks: KnobsState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	if (ks.overlay?.kind !== "input") return;
	const o = ks.overlay;
	const row = ks.rows[o.rowIndex];
	const label = row ? `${row.extName}.${row.key}` : "?";
	add(
		`  ${theme.fg("accent", `Set ${label}`)} ${theme.fg("muted", `(${row?.type ?? ""})`)}`,
	);
	if (row?.type === "string[]") {
		add(`  ${theme.fg("dim", "comma/space-separated; empty = []")}`);
	}
	const before = o.buffer.slice(0, o.caret);
	const after = o.buffer.slice(o.caret);
	add(
		truncateToWidth(
			`  ${theme.fg("muted", "value:")} ${theme.fg("text", before)}${theme.fg("accent", "▏")}${theme.fg("text", after)}`,
			width,
		),
	);
	if (o.error) add(`  ${theme.fg("warning", o.error)}`);
}

function renderKnobPicker(
	ks: KnobsState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	if (ks.overlay?.kind !== "picker") return;
	const o = ks.overlay;
	const row = ks.rows[o.rowIndex];
	const label = row ? `${row.extName}.${row.key}` : "?";
	add(`  ${theme.fg("accent", `Set ${label}`)}`);
	add(
		`  ${theme.fg("muted", "filter:")} ${theme.fg("text", o.query || " ")}${theme.fg("dim", "▏")}`,
	);
	const opts = knobPickerOptions(ks);
	const MAX = 12;
	const start = Math.min(
		Math.max(0, o.cursor - Math.floor(MAX / 2)),
		Math.max(0, opts.length - MAX),
	);
	const shown = opts.slice(start, start + MAX);
	shown.forEach((opt, idx) => {
		const i = start + idx;
		const selected = i === o.cursor;
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
