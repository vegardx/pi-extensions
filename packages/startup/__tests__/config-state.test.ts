/**
 * Pure-state tests for the top-level `/config` controller: page
 * cycling and the project/global scope sync into the extensions
 * sub-state.
 */

import { describe, expect, it } from "vitest";
import {
	atTopRow,
	type ConfigInit,
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
	setPage,
	settingsInDetail,
	settingsMoveDown,
} from "../config-dialog/config-state.js";
import type { ExtensionRow } from "../config-dialog/extensions-state.js";
import type { KnobRow } from "../config-dialog/knobs-state.js";
import { buildModelRows } from "../config-dialog/models-state.js";

function extRows(): ExtensionRow[] {
	return [
		{
			name: "modes",
			dependsOn: [],
			integratesWith: [],
			project: null,
			global: true,
			effective: true,
			effectiveSource: "global",
		},
		{
			name: "webfetch",
			dependsOn: [],
			integratesWith: [],
			project: null,
			global: null,
			effective: false,
			effectiveSource: "default",
		},
	];
}

function knobRows(): KnobRow[] {
	return [
		{
			extName: "modes",
			key: "mode.default",
			type: "enum",
			enumValues: ["plan", "auto"],
			doc: "mode doc",
			project: null,
			global: "plan",
		},
		{
			extName: "modes",
			key: "review.enable",
			type: "boolean",
			doc: "review doc",
			project: null,
			global: null,
		},
		{
			extName: "webfetch",
			key: "timeoutMs",
			type: "number",
			doc: "timeout doc",
			project: null,
			global: null,
		},
	];
}

function init(overrides?: Partial<ConfigInit>): ConfigInit {
	return {
		extensionRows: extRows(),
		modelRows: buildModelRows(() => null),
		knobRows: knobRows(),
		availableModels: ["a/b"],
		contextFiles: [],
		...overrides,
	};
}

describe("config-state — pages", () => {
	it("defaults to the extensions page on the project scope", () => {
		const s = createConfigState(init());
		expect(s.page).toBe("extensions");
		expect(s.scope).toBe("project");
		expect(s.extensions.scope).toBe("project");
	});

	it("honours an explicit initial page", () => {
		const s = createConfigState(init({}));
		s.page = "extensions";
		const m = createConfigState({ ...init(), page: "models" });
		expect(m.page).toBe("models");
		expect(s.page).toBe("extensions");
	});

	it("nextPage cycles extensions → models → settings → context → extensions", () => {
		const s = createConfigState(init());
		nextPage(s);
		expect(s.page).toBe("models");
		nextPage(s);
		expect(s.page).toBe("settings");
		nextPage(s);
		expect(s.page).toBe("context");
		nextPage(s);
		expect(s.page).toBe("extensions");
	});

	it("prevPage cycles backwards with wraparound", () => {
		const s = createConfigState(init());
		prevPage(s);
		expect(s.page).toBe("context");
		prevPage(s);
		expect(s.page).toBe("settings");
		prevPage(s);
		expect(s.page).toBe("models");
	});

	it("setPage is a no-op when already on the page", () => {
		const s = createConfigState(init());
		expect(setPage(s, "extensions")).toBe(false);
		expect(setPage(s, "models")).toBe(true);
	});

	it("pageUsesScope is true for extensions/models, false for context", () => {
		expect(pageUsesScope("extensions")).toBe(true);
		expect(pageUsesScope("models")).toBe(true);
		expect(pageUsesScope("settings")).toBe(true);
		expect(pageUsesScope("context")).toBe(false);
	});
});

describe("config-state — scope sync", () => {
	it("setConfigScope updates both the top-level scope and the extensions sub-state", () => {
		const s = createConfigState(init());
		expect(setConfigScope(s, "global")).toBe(true);
		expect(s.scope).toBe("global");
		expect(s.extensions.scope).toBe("global");
	});

	it("setConfigScope is a no-op when unchanged", () => {
		const s = createConfigState(init());
		expect(setConfigScope(s, "project")).toBe(false);
	});
});

describe("config-state — focus zones", () => {
	it("defaults focus to the body so the dialog opens on the list", () => {
		const s = createConfigState(init());
		expect(s.focus).toBe("body");
	});

	it("honours an explicit initial focus", () => {
		const s = createConfigState({ ...init(), focus: "menu" });
		expect(s.focus).toBe("menu");
	});

	it("focusMenu / focusBody toggle and report whether they changed", () => {
		const s = createConfigState(init());
		expect(focusMenu(s)).toBe(true);
		expect(s.focus).toBe("menu");
		expect(focusMenu(s)).toBe(false);
		expect(focusBody(s)).toBe(true);
		expect(s.focus).toBe("body");
		expect(focusBody(s)).toBe(false);
	});

	it("arrow page nav from the menu cycles like next/prevPage with wraparound", () => {
		const s = createConfigState({ ...init(), focus: "menu" });
		nextPage(s);
		expect(s.page).toBe("models");
		prevPage(s);
		prevPage(s);
		expect(s.page).toBe("context");
	});
});

describe("config-state — atTopRow", () => {
	it("is true only when the active page's cursor sits on the first row", () => {
		const s = createConfigState(init());
		expect(atTopRow(s)).toBe(true);
		s.extensions.cursor = 1;
		expect(atTopRow(s)).toBe(false);
	});

	it("tracks the cursor of whichever page is active", () => {
		const s = createConfigState(init());
		s.extensions.cursor = 1;
		setPage(s, "models");
		expect(atTopRow(s)).toBe(true); // models cursor still 0
		s.models.cursor = 2;
		expect(atTopRow(s)).toBe(false);
		setPage(s, "context");
		expect(atTopRow(s)).toBe(true); // context cursor still 0
	});

	it("uses the settings selector cursor until an extension is open", () => {
		const s = createConfigState(init({ page: "settings" }));
		expect(atTopRow(s)).toBe(true);
		expect(settingsMoveDown(s)).toBe(true);
		expect(atTopRow(s)).toBe(false);
		expect(enterSettingsExtension(s)).toBe(true);
		expect(atTopRow(s)).toBe(true);
		s.knobs.cursor = 1;
		expect(atTopRow(s)).toBe(false);
	});
});

describe("config-state — settings drilldown", () => {
	it("builds one selector row per configurable extension", () => {
		const s = createConfigState(init());
		expect(s.settings.extensions).toEqual([
			{ name: "modes", doc: undefined, knobCount: 2 },
			{ name: "webfetch", doc: undefined, knobCount: 1 },
		]);
		expect(s.knobs.rows).toEqual([]);
	});

	it("enters and leaves the selected extension knob list", () => {
		const s = createConfigState(init({ page: "settings" }));
		expect(currentSettingsExtension(s)?.name).toBe("modes");
		expect(settingsInDetail(s)).toBe(false);
		expect(enterSettingsExtension(s)).toBe(true);
		expect(settingsInDetail(s)).toBe(true);
		expect(s.settings.selectedExtName).toBe("modes");
		expect(s.knobs.rows.map((r) => r.key)).toEqual([
			"mode.default",
			"review.enable",
		]);
		expect(leaveSettingsExtension(s)).toBe(true);
		expect(settingsInDetail(s)).toBe(false);
		expect(s.knobs.rows).toEqual([]);
	});
});
