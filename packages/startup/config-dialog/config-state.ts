/**
 * Pure state model for the top-level `/config` dialog, composing three
 * pages — Extensions, Models, Context — behind a single scope toggle.
 *
 * The Extensions and Models pages share the project / global scope (the
 * scope maps 1:1 onto the two settings.json files both pages write).
 * The Context page is read-only and scope-agnostic.
 *
 * Navigation uses a two-zone focus model (`menu` / `body`): the page
 * menu and the project/global columns are both driven by the arrow
 * keys at different focus depths, so there is no dedicated scope tab
 * bar. `←/→` in the body switch the focused column; that column is the
 * active scope. The canonical scope still lives here and is mirrored
 * into the extensions sub-state so the existing (tested)
 * extensions-state functions, which read `state.scope` internally, keep
 * working unchanged.
 *
 * No TUI / I/O — page and scope transitions are unit-testable.
 */

import type { ContextFileInfo } from "../index.js";
import {
	createState as createExtensionsState,
	type DialogScope,
	type ExtensionRow,
	type DialogState as ExtensionsState,
	setScope as setExtensionsScope,
} from "./extensions-state.js";
import {
	createModelsState,
	type ModelRow,
	type ModelsState,
} from "./models-state.js";

export type ConfigPage = "extensions" | "models" | "context";

/**
 * Which zone owns keyboard input. The page menu (`menu`) and the table
 * body (`body`) form a two-zone focus model: `←/→` switch page in the
 * menu, `↓` drops into the body; `↑` from the body's top row returns to
 * the menu. This lets one arrow vocabulary drive both the top-level menu
 * and the project/global columns without a second tab bar.
 */
export type ConfigFocus = "menu" | "body";

/** Page order for Tab cycling. */
export const PAGE_ORDER: readonly ConfigPage[] = [
	"extensions",
	"models",
	"context",
];

export interface ContextPageState {
	files: ContextFileInfo[];
	cursor: number;
}

export interface ConfigState {
	page: ConfigPage;
	focus: ConfigFocus;
	scope: DialogScope;
	extensions: ExtensionsState;
	models: ModelsState;
	context: ContextPageState;
}

export interface ConfigInit {
	extensionRows: ExtensionRow[];
	modelRows: ModelRow[];
	availableModels: string[];
	contextFiles: ContextFileInfo[];
	page?: ConfigPage;
	focus?: ConfigFocus;
	scope?: DialogScope;
}

export function createConfigState(init: ConfigInit): ConfigState {
	const scope = init.scope ?? "project";
	const extensions = createExtensionsState({ rows: init.extensionRows, scope });
	return {
		page: init.page ?? "extensions",
		focus: init.focus ?? "body",
		scope,
		extensions,
		models: createModelsState({
			rows: init.modelRows,
			available: init.availableModels,
		}),
		context: {
			files: init.contextFiles,
			cursor: 0,
		},
	};
}

/** Switch to a specific page. Returns false if already there. */
export function setPage(state: ConfigState, page: ConfigPage): boolean {
	if (state.page === page) return false;
	state.page = page;
	return true;
}

/** Advance to the next page (Tab), wrapping around. */
export function nextPage(state: ConfigState): boolean {
	const idx = PAGE_ORDER.indexOf(state.page);
	state.page = PAGE_ORDER[(idx + 1) % PAGE_ORDER.length];
	return true;
}

/** Step to the previous page (Shift+Tab), wrapping around. */
export function prevPage(state: ConfigState): boolean {
	const idx = PAGE_ORDER.indexOf(state.page);
	state.page = PAGE_ORDER[(idx - 1 + PAGE_ORDER.length) % PAGE_ORDER.length];
	return true;
}

/**
 * Set the active scope, keeping the extensions sub-state in sync so its
 * scope-reading functions operate on the same layer. No-op when the
 * scope is unchanged.
 */
export function setConfigScope(
	state: ConfigState,
	scope: DialogScope,
): boolean {
	if (state.scope === scope) return false;
	state.scope = scope;
	setExtensionsScope(state.extensions, scope);
	return true;
}

/** Whether the active page exposes the project / global scope tabs. */
export function pageUsesScope(page: ConfigPage): boolean {
	return page === "extensions" || page === "models";
}

/** Move keyboard focus to the page menu. Returns false if already there. */
export function focusMenu(state: ConfigState): boolean {
	if (state.focus === "menu") return false;
	state.focus = "menu";
	return true;
}

/** Move keyboard focus into the table body. Returns false if already there. */
export function focusBody(state: ConfigState): boolean {
	if (state.focus === "body") return false;
	state.focus = "body";
	return true;
}

/**
 * Whether the body cursor sits on the first row of the active page. Used
 * by the body zone to decide when `↑` should pop focus back to the menu
 * instead of moving the cursor.
 */
export function atTopRow(state: ConfigState): boolean {
	if (state.page === "extensions") return state.extensions.cursor <= 0;
	if (state.page === "models") return state.models.cursor <= 0;
	return state.context.cursor <= 0;
}
