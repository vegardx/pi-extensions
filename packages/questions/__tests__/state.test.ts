import {
	allAnswered,
	answeredCount,
	buildResult,
	canSubmit,
	createState,
	currentItem,
	currentOptions,
	goToTab,
	isSubmitTab,
	moveDown,
	moveUp,
	nextTab,
	prevTab,
	selectOption,
	totalTabs,
	unansweredItems,
} from "../state.js";
import type { QuestionsConfig } from "../types.js";

function twoItemConfig(): QuestionsConfig {
	return {
		title: "Test",
		items: [
			{
				id: "a",
				label: "Item A",
				prompt: "Choose for A",
				options: [
					{ value: "fix", label: "Fix" },
					{ value: "skip", label: "Skip" },
					{ value: "investigate", label: "Investigate" },
				],
			},
			{
				id: "b",
				label: "Item B",
				prompt: "Choose for B",
				options: [
					{ value: "fix", label: "Fix" },
					{ value: "skip", label: "Skip" },
				],
			},
		],
	};
}

describe("createState", () => {
	it("initialises at tab 0, option 0, no answers", () => {
		const state = createState(twoItemConfig());
		expect(state.currentTab).toBe(0);
		expect(state.optionIndex).toBe(0);
		expect(state.answers.size).toBe(0);
		expect(state.title).toBe("Test");
	});

	it("defaults title to 'Review' when not specified", () => {
		const { title: _, ...rest } = twoItemConfig();
		const state = createState(rest as QuestionsConfig);
		expect(state.title).toBe("Review");
	});
});

describe("totalTabs", () => {
	it("returns items.length + 1 (for submit tab)", () => {
		const state = createState(twoItemConfig());
		expect(totalTabs(state)).toBe(3);
	});
});

describe("tab navigation", () => {
	it("nextTab wraps around", () => {
		const state = createState(twoItemConfig());
		expect(state.currentTab).toBe(0);
		nextTab(state);
		expect(state.currentTab).toBe(1);
		nextTab(state);
		expect(state.currentTab).toBe(2); // submit
		nextTab(state);
		expect(state.currentTab).toBe(0); // wrapped
	});

	it("prevTab wraps around", () => {
		const state = createState(twoItemConfig());
		prevTab(state);
		expect(state.currentTab).toBe(2); // wrapped to submit
		prevTab(state);
		expect(state.currentTab).toBe(1);
	});

	it("resets optionIndex on tab change", () => {
		const state = createState(twoItemConfig());
		moveDown(state);
		expect(state.optionIndex).toBe(1);
		nextTab(state);
		expect(state.optionIndex).toBe(0);
	});

	it("goToTab navigates directly", () => {
		const state = createState(twoItemConfig());
		goToTab(state, 2);
		expect(isSubmitTab(state)).toBe(true);
	});

	it("goToTab returns false for out-of-range", () => {
		const state = createState(twoItemConfig());
		expect(goToTab(state, 5)).toBe(false);
		expect(goToTab(state, -1)).toBe(false);
	});

	it("goToTab returns false for same tab", () => {
		const state = createState(twoItemConfig());
		expect(goToTab(state, 0)).toBe(false);
	});
});

describe("option navigation", () => {
	it("moveDown increments optionIndex", () => {
		const state = createState(twoItemConfig());
		expect(moveDown(state)).toBe(true);
		expect(state.optionIndex).toBe(1);
	});

	it("moveDown returns false at bottom", () => {
		const state = createState(twoItemConfig());
		moveDown(state);
		moveDown(state);
		expect(moveDown(state)).toBe(false);
		expect(state.optionIndex).toBe(2);
	});

	it("moveUp decrements optionIndex", () => {
		const state = createState(twoItemConfig());
		moveDown(state);
		expect(moveUp(state)).toBe(true);
		expect(state.optionIndex).toBe(0);
	});

	it("moveUp returns false at top", () => {
		const state = createState(twoItemConfig());
		expect(moveUp(state)).toBe(false);
	});
});

describe("selectOption", () => {
	it("records the answer and advances to next unanswered", () => {
		const state = createState(twoItemConfig());
		selectOption(state);
		expect(state.answers.has("a")).toBe(true);
		expect(state.answers.get("a")?.value).toBe("fix");
		expect(state.currentTab).toBe(1); // advanced to item B
	});

	it("advances to submit tab when all answered", () => {
		const state = createState(twoItemConfig());
		selectOption(state); // answers A, goes to B
		selectOption(state); // answers B, goes to submit
		expect(isSubmitTab(state)).toBe(true);
	});

	it("selects the option at current optionIndex", () => {
		const state = createState(twoItemConfig());
		moveDown(state); // optionIndex = 1 (Skip)
		selectOption(state);
		expect(state.answers.get("a")?.value).toBe("skip");
	});

	it("returns false on submit tab (no item)", () => {
		const state = createState(twoItemConfig());
		goToTab(state, 2);
		expect(selectOption(state)).toBe(false);
	});

	it("allows re-answering an item", () => {
		const state = createState(twoItemConfig());
		selectOption(state); // fix for A
		goToTab(state, 0);
		moveDown(state); // Skip
		selectOption(state);
		expect(state.answers.get("a")?.value).toBe("skip");
	});

	// --- finding #5: auto-advance searches from index 0, not from currentTab+1 ---
	it("auto-advances to an earlier unanswered tab after out-of-order answering", () => {
		// Three items: answer C (idx 2) first by jumping there directly.
		// The old code (idx > currentTab) would then skip A and B since they
		// come before tab 2. The fix searches from 0.
		const config = {
			items: [
				{
					id: "a",
					label: "A",
					prompt: "?",
					options: [{ value: "y", label: "Yes" }],
				},
				{
					id: "b",
					label: "B",
					prompt: "?",
					options: [{ value: "y", label: "Yes" }],
				},
				{
					id: "c",
					label: "C",
					prompt: "?",
					options: [{ value: "y", label: "Yes" }],
				},
			],
		};
		const state = createState(config);
		goToTab(state, 2); // jump to C
		selectOption(state); // answer C — next unanswered from 0 should be A (idx 0)
		expect(state.currentTab).toBe(0); // must find A, not advance to submit
	});
});

describe("answer tracking", () => {
	it("allAnswered is false when items remain", () => {
		const state = createState(twoItemConfig());
		selectOption(state);
		expect(allAnswered(state)).toBe(false);
	});

	it("allAnswered is true when all items answered", () => {
		const state = createState(twoItemConfig());
		selectOption(state);
		selectOption(state);
		expect(allAnswered(state)).toBe(true);
	});

	it("answeredCount tracks answers", () => {
		const state = createState(twoItemConfig());
		expect(answeredCount(state)).toBe(0);
		selectOption(state);
		expect(answeredCount(state)).toBe(1);
	});

	it("unansweredItems returns items without answers", () => {
		const state = createState(twoItemConfig());
		selectOption(state);
		const remaining = unansweredItems(state);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].id).toBe("b");
	});
});

describe("canSubmit", () => {
	it("always true when requireAll is false (default)", () => {
		const state = createState(twoItemConfig());
		expect(canSubmit(state)).toBe(true);
	});

	it("false when requireAll and not all answered", () => {
		const state = createState({ ...twoItemConfig(), requireAll: true });
		expect(canSubmit(state)).toBe(false);
		selectOption(state);
		expect(canSubmit(state)).toBe(false);
		selectOption(state);
		expect(canSubmit(state)).toBe(true);
	});
});

describe("buildResult", () => {
	it("returns cancelled=true with empty answers on cancel", () => {
		const state = createState(twoItemConfig());
		const result = buildResult(state, true);
		expect(result.cancelled).toBe(true);
		expect(result.answers).toHaveLength(0);
		expect(result.items).toHaveLength(2);
	});

	it("returns all answers on submit", () => {
		const state = createState(twoItemConfig());
		selectOption(state);
		moveDown(state);
		selectOption(state);
		const result = buildResult(state, false);
		expect(result.cancelled).toBe(false);
		expect(result.answers).toHaveLength(2);
		expect(result.answers[0]).toEqual({
			id: "a",
			value: "fix",
			label: "Fix",
		});
		expect(result.answers[1]).toEqual({
			id: "b",
			value: "skip",
			label: "Skip",
		});
	});

	it("returns partial answers when not all answered", () => {
		const state = createState(twoItemConfig());
		selectOption(state);
		const result = buildResult(state, false);
		expect(result.answers).toHaveLength(1);
	});
});

describe("currentItem / currentOptions", () => {
	it("returns correct item for current tab", () => {
		const state = createState(twoItemConfig());
		expect(currentItem(state)?.id).toBe("a");
		nextTab(state);
		expect(currentItem(state)?.id).toBe("b");
	});

	it("returns undefined on submit tab", () => {
		const state = createState(twoItemConfig());
		goToTab(state, 2);
		expect(currentItem(state)).toBeUndefined();
		expect(currentOptions(state)).toEqual([]);
	});
});
