/**
 * Unit tests for per-option preview pane in questions (#157).
 *
 * Tests the resolveRightPaneContent pure helper which drives the
 * right-pane content selection. No pi host or Theme needed.
 */

import { type RightPaneContent, resolveRightPaneContent } from "../dialog.js";
import type { DialogItem, DialogOption, DialogPreview } from "../types.js";

const ITEM_PREVIEW: DialogPreview = {
	kind: "text",
	content: "item-level content",
	title: "item",
};

const OPT_PREVIEW: DialogPreview = {
	kind: "text",
	content: "option-level content",
	title: "option",
};

function item(preview?: DialogPreview): Pick<DialogItem, "preview"> {
	return { preview };
}

function opt(
	fields: Partial<Pick<DialogOption, "preview" | "pros" | "cons">>,
): Pick<DialogOption, "preview" | "pros" | "cons"> {
	return fields;
}

describe("resolveRightPaneContent", () => {
	it("(a) option with pros+cons → proscons pane", () => {
		const result = resolveRightPaneContent(
			item(),
			opt({ pros: ["fast"], cons: ["costly"] }),
		);
		expect(result).toEqual<RightPaneContent>({
			kind: "proscons",
			pros: ["fast"],
			cons: ["costly"],
		});
	});

	it("(a) pros only (no cons) → proscons pane", () => {
		const result = resolveRightPaneContent(item(), opt({ pros: ["easy"] }));
		expect(result).toMatchObject({
			kind: "proscons",
			pros: ["easy"],
			cons: [],
		});
	});

	it("(a) cons only (no pros) → proscons pane", () => {
		const result = resolveRightPaneContent(item(), opt({ cons: ["risky"] }));
		expect(result).toMatchObject({
			kind: "proscons",
			pros: [],
			cons: ["risky"],
		});
	});

	it("(b) option preview overrides item preview", () => {
		const result = resolveRightPaneContent(
			item(ITEM_PREVIEW),
			opt({ preview: OPT_PREVIEW }),
		);
		expect(result).toEqual<RightPaneContent>({
			kind: "preview",
			preview: OPT_PREVIEW,
		});
	});

	it("(b) option preview wins over option pros/cons too", () => {
		// preview takes priority over proscons even when both are present
		const result = resolveRightPaneContent(
			item(),
			opt({ preview: OPT_PREVIEW, pros: ["x"], cons: ["y"] }),
		);
		expect(result).toMatchObject({ kind: "preview", preview: OPT_PREVIEW });
	});

	it("(c) item-level fallback when option has no per-option content", () => {
		const result = resolveRightPaneContent(item(ITEM_PREVIEW), opt({}));
		expect(result).toEqual<RightPaneContent>({
			kind: "preview",
			preview: ITEM_PREVIEW,
		});
	});

	it("(c) item-level fallback when currOpt is undefined (no options)", () => {
		const result = resolveRightPaneContent(item(ITEM_PREVIEW), undefined);
		expect(result).toEqual<RightPaneContent>({
			kind: "preview",
			preview: ITEM_PREVIEW,
		});
	});

	it("none — neither option nor item has right-pane content", () => {
		const result = resolveRightPaneContent(item(), undefined);
		expect(result).toEqual<RightPaneContent>({ kind: "none" });
	});

	it("none — option has empty pros/cons arrays", () => {
		const result = resolveRightPaneContent(item(), opt({ pros: [], cons: [] }));
		expect(result).toEqual<RightPaneContent>({ kind: "none" });
	});
});
