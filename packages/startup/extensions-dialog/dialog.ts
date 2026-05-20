/**
 * Interactive `/extensions` dialog. Lets the user flip
 * `extensionConfig.<name>.enabled` per scope (project / global) with a
 * tab-and-list UI. Every toggle writes to settings.json immediately
 * via `writeExtensionConfigKey` — Ctrl+C / Esc don't roll back; the
 * change is persistent.
 *
 * Render and state are split: `state.ts` holds the pure model, this
 * file owns the TUI bindings (key handling, layout, theme calls). The
 * pure model is exhaustively tested; this file is mostly mechanical
 * and best validated by running it.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { ExtensionMetadata } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { writeExtensionConfigKey } from "@vegardx/pi-extensions-shared/settings-writer.js";

import { buildRows } from "./build-rows.js";
import {
	createState,
	currentRow,
	cycleCurrent,
	type DialogState,
	type ExtensionRow,
	moveDown,
	moveUp,
	resetCurrent,
	type ScopedValue,
	setScope,
} from "./state.js";

const SCOPE_KEY = "enabled";

export interface ShowExtensionsDialogOptions {
	/** Extensions to display, typically the metadata registry. */
	declared: readonly ExtensionMetadata[];
	/** Override the agent dir for tests. */
	agentDir?: string;
}

/**
 * Open the dialog. Returns when the user dismisses it. Writes happen
 * incrementally as the user toggles, so the return value is just void
 * — there's no transaction to commit or roll back.
 */
export async function showExtensionsDialog(
	ctx: ExtensionContext,
	opts: ShowExtensionsDialogOptions,
): Promise<void> {
	if (!ctx.hasUI) return;

	const initialRows = buildRows({
		cwd: ctx.cwd,
		agentDir: opts.agentDir,
		declared: opts.declared,
	});

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const state = createState({ rows: initialRows });
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function persist(): void {
			const row = currentRow(state);
			if (!row) return;
			const value = state.scope === "project" ? row.project : row.global;
			try {
				writeExtensionConfigKey(
					state.scope,
					ctx.cwd,
					row.name,
					SCOPE_KEY,
					value,
					opts.agentDir,
				);
			} catch (err) {
				ctx.ui.notify(
					`Failed to write ${state.scope} settings: ${
						err instanceof Error ? err.message : String(err)
					}`,
					"error",
				);
			}
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.escape) || data === "q") {
				done(undefined);
				return;
			}
			if (matchesKey(data, Key.left)) {
				if (setScope(state, "project")) refresh();
				return;
			}
			if (matchesKey(data, Key.right)) {
				if (setScope(state, "global")) refresh();
				return;
			}
			if (data === "p") {
				if (setScope(state, "project")) refresh();
				return;
			}
			if (data === "g") {
				if (setScope(state, "global")) refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				if (moveUp(state)) refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				if (moveDown(state)) refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || data === " ") {
				cycleCurrent(state);
				persist();
				refresh();
				return;
			}
			if (data === "r") {
				if (resetCurrent(state)) {
					persist();
					refresh();
				}
				return;
			}
		}

		function render(width: number): string[] {
			if (cachedLines !== undefined && width === cachedWidth) {
				return cachedLines;
			}
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));
			renderHeader(state, theme, width, add);
			lines.push("");
			renderTabs(state, theme, width, add);
			lines.push("");
			renderTable(state, theme, width, add);
			lines.push("");
			renderDetail(state, theme, width, add);
			lines.push("");
			renderFooter(theme, width, add);
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
// Render helpers
// ---------------------------------------------------------------------------

function renderHeader(
	state: DialogState,
	theme: Theme,
	_width: number,
	add: (s: string) => void,
): void {
	const total = state.rows.length;
	const enabled = state.rows.filter((r) => r.effective).length;
	add(
		` ${theme.fg("accent", theme.bold("pi-extensions"))}  ${theme.fg(
			"muted",
			`· ${enabled} of ${total} loaded this session`,
		)}`,
	);
}

function renderTabs(
	state: DialogState,
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

function renderTable(
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
		const text = ` ${cursor} ${theme.fg(selected ? "text" : "text", name)}  ${projectCell}  ${globalCell}  ${effective}`;
		add(truncateToWidth(text, width));
	}
}

function renderDetail(
	state: DialogState,
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const row = currentRow(state);
	if (!row) return;
	if (row.doc) {
		const wrapped = wrap(row.doc, width - 4);
		for (const line of wrapped) {
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

function renderFooter(
	theme: Theme,
	width: number,
	add: (s: string) => void,
): void {
	const help =
		" ←/→ or p/g scope • ↑↓ select • space/enter cycle null→on→off→null • r reset • q/Esc close";
	add(truncateToWidth(theme.fg("dim", help), width));
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

function scopedCell(
	theme: Theme,
	value: ScopedValue,
	highlight: boolean,
): string {
	const text = pad(formatScoped(value), 9);
	if (highlight) {
		const colour = scopedColour(value);
		return theme.bg("selectedBg", theme.fg(colour, text));
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
	const tag = ` (${row.effectiveSource})`;
	return `${symbol}${theme.fg("muted", tag)}`;
}

function effectiveDescription(theme: Theme, row: ExtensionRow): string {
	const state = row.effective
		? theme.fg("success", "enabled")
		: theme.fg("dim", "disabled");
	return `${state} ${theme.fg("muted", `(via ${row.effectiveSource})`)}`;
}

function pad(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

/**
 * Cheap word-wrap for plain (un-coloured) detail text. Keeps the
 * detail block readable in narrow terminals; we don't bother handling
 * ANSI here because `row.doc` arrives as a plain string from the
 * extension metadata.
 */
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
