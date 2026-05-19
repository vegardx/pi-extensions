import {
	buildResult,
	createState,
	getTextContent,
	goToTab,
	hasTextInput,
	isTextFieldFocused,
	moveDown,
	moveUp,
	nextTab,
	selectOption,
	setTextContent,
	submitText,
} from "../state.js";
import type { QuestionsConfig } from "../types.js";

function textInputConfig(): QuestionsConfig {
	return {
		title: "Questions",
		requireAll: true,
		items: [
			{
				id: "q1",
				label: "Naming",
				prompt: "Which naming convention?",
				options: [
					{ value: "camel", label: "camelCase" },
					{ value: "snake", label: "snake_case" },
				],
				textInput: { placeholder: "Type your preference…" },
			},
			{
				id: "q2",
				label: "Error handling",
				prompt: "How should errors be surfaced?",
				options: [{ value: "throw", label: "Throw exceptions" }],
				textInput: {},
			},
		],
	};
}

function textOnlyConfig(): QuestionsConfig {
	return {
		title: "Open question",
		items: [
			{
				id: "open",
				label: "Thoughts",
				prompt: "What do you think?",
				options: [],
				textInput: { prefill: "I think…" },
			},
		],
	};
}

describe("textInput: createState", () => {
	it("initialises textContent from prefill", () => {
		const state = createState(textOnlyConfig());
		expect(getTextContent(state, "open")).toBe("I think…");
	});

	it("initialises textContent as empty when no prefill", () => {
		const state = createState(textInputConfig());
		expect(getTextContent(state, "q1")).toBe("");
		expect(getTextContent(state, "q2")).toBe("");
	});

	it("starts with textFieldFocused=false", () => {
		const state = createState(textInputConfig());
		expect(isTextFieldFocused(state)).toBe(false);
	});
});

describe("textInput: focus navigation", () => {
	it("moveDown past last option focuses text field", () => {
		const state = createState(textInputConfig());
		moveDown(state); // optionIndex 0 → 1
		moveDown(state); // past last option → text field
		expect(isTextFieldFocused(state)).toBe(true);
	});

	it("moveDown returns false when already in text field", () => {
		const state = createState(textInputConfig());
		moveDown(state);
		moveDown(state);
		expect(moveDown(state)).toBe(false);
	});

	it("moveUp from text field returns to last option", () => {
		const state = createState(textInputConfig());
		moveDown(state);
		moveDown(state);
		expect(isTextFieldFocused(state)).toBe(true);
		moveUp(state);
		expect(isTextFieldFocused(state)).toBe(false);
		expect(state.optionIndex).toBe(1); // last option
	});

	it("text field focus resets on tab change", () => {
		const state = createState(textInputConfig());
		moveDown(state);
		moveDown(state);
		expect(isTextFieldFocused(state)).toBe(true);
		nextTab(state);
		expect(isTextFieldFocused(state)).toBe(false);
	});

	it("text field focus resets on goToTab", () => {
		const state = createState(textInputConfig());
		moveDown(state);
		moveDown(state);
		goToTab(state, 1);
		expect(isTextFieldFocused(state)).toBe(false);
	});

	it("moveDown goes directly to text field when no options", () => {
		const state = createState(textOnlyConfig());
		expect(moveDown(state)).toBe(true);
		expect(isTextFieldFocused(state)).toBe(true);
	});

	it("moveUp from text field with no options returns false", () => {
		const state = createState(textOnlyConfig());
		moveDown(state); // into text field
		expect(moveUp(state)).toBe(false);
		expect(isTextFieldFocused(state)).toBe(true);
	});
});

describe("textInput: hasTextInput", () => {
	it("returns true for items with textInput", () => {
		const state = createState(textInputConfig());
		expect(hasTextInput(state)).toBe(true);
	});

	it("returns false on submit tab", () => {
		const state = createState(textInputConfig());
		goToTab(state, 2);
		expect(hasTextInput(state)).toBe(false);
	});
});

describe("textInput: setTextContent / getTextContent", () => {
	it("sets and gets text for current item", () => {
		const state = createState(textInputConfig());
		setTextContent(state, "hello");
		expect(getTextContent(state, "q1")).toBe("hello");
	});

	it("returns false when item has no textInput", () => {
		const config: QuestionsConfig = {
			title: "No text",
			items: [
				{
					id: "x",
					label: "X",
					prompt: "Pick",
					options: [{ value: "a", label: "A" }],
				},
			],
		};
		const state = createState(config);
		expect(setTextContent(state, "hello")).toBe(false);
	});
});

describe("textInput: selectOption pre-fills text", () => {
	it("pre-fills text content with option label", () => {
		const state = createState(textInputConfig());
		selectOption(state); // selects "camelCase" for q1
		expect(getTextContent(state, "q1")).toBe("camelCase");
	});

	it("includes text in the answer", () => {
		const state = createState(textInputConfig());
		selectOption(state);
		const answer = state.answers.get("q1");
		expect(answer?.text).toBe("camelCase");
		expect(answer?.value).toBe("camel");
	});
});

describe("textInput: submitText", () => {
	it("submits non-empty text and advances", () => {
		const state = createState(textInputConfig());
		setTextContent(state, "PascalCase");
		const result = submitText(state);
		expect(result).toBe(true);
		expect(state.answers.get("q1")?.text).toBe("PascalCase");
		expect(state.answers.get("q1")?.value).toBe("");
		expect(state.currentTab).toBe(1); // advanced to q2
	});

	it("refuses to submit empty text", () => {
		const state = createState(textInputConfig());
		expect(submitText(state)).toBe(false);
		expect(state.answers.has("q1")).toBe(false);
	});

	it("refuses to submit whitespace-only text", () => {
		const state = createState(textInputConfig());
		setTextContent(state, "   ");
		expect(submitText(state)).toBe(false);
	});

	it("advances to submit tab when all answered", () => {
		const state = createState(textInputConfig());
		setTextContent(state, "camelCase");
		submitText(state); // answers q1, advances to q2
		setTextContent(state, "Return errors");
		submitText(state); // answers q2, advances to submit
		expect(state.currentTab).toBe(2); // submit tab
	});

	it("truncates long text in label", () => {
		const state = createState(textInputConfig());
		const long = "a".repeat(100);
		setTextContent(state, long);
		submitText(state);
		const answer = state.answers.get("q1");
		expect(answer?.label.length).toBeLessThanOrEqual(50);
		expect(answer?.text).toBe(long);
	});
});

describe("textInput: buildResult includes text", () => {
	it("includes text from textContent map in answers", () => {
		const state = createState(textInputConfig());
		// Select option (pre-fills text), then manually edit text.
		selectOption(state); // answers q1 with "camelCase"
		goToTab(state, 0); // go back
		setTextContent(state, "camelCase but flexible");
		// Build result — should use textContent, not stale answer.text.
		const result = buildResult(state, false);
		const q1 = result.answers.find((a) => a.id === "q1");
		expect(q1?.text).toBe("camelCase but flexible");
	});

	it("preserves text from submitText in buildResult", () => {
		const state = createState(textInputConfig());
		setTextContent(state, "my custom answer");
		submitText(state);
		const result = buildResult(state, false);
		const q1 = result.answers.find((a) => a.id === "q1");
		expect(q1?.text).toBe("my custom answer");
	});
});
