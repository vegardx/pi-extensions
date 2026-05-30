/**
 * Pure-state tests for the top-level `/config` controller: page
 * cycling and the project/global scope sync into the extensions
 * sub-state.
 */

import { describe, expect, it } from "vitest";
import {
	type ConfigInit,
	createConfigState,
	nextPage,
	pageUsesScope,
	prevPage,
	setConfigScope,
	setPage,
} from "../config-dialog/config-state.js";
import type { ExtensionRow } from "../config-dialog/extensions-state.js";
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
	];
}

function init(overrides?: Partial<ConfigInit>): ConfigInit {
	return {
		extensionRows: extRows(),
		modelRows: buildModelRows(() => null),
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

	it("nextPage cycles extensions → models → context → extensions", () => {
		const s = createConfigState(init());
		nextPage(s);
		expect(s.page).toBe("models");
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
