/**
 * Tests for the `ask` tool integration in modes.
 *
 * These tests exercise the exported types and the hydration contract.
 * Full integration tests (agent_end → dialog → sendMessage) require the
 * extension runtime and are covered by manual testing; here we test the
 * data shapes and the dialog construction logic.
 */

import type {
	DialogItem,
	DialogResult,
	QuestionsConfig,
} from "@vegardx/pi-questions";
import {
	buildResult,
	createState,
	moveDown,
	selectOption,
	setTextContent,
	submitText,
} from "@vegardx/pi-questions";
import type { PendingQuestion, QAPair } from "../index.js";

/**
 * Mirrors the logic in showAskDialog to build DialogItems from
 * PendingQuestions. Extracted here to test the mapping independently.
 */
function buildDialogItems(questions: PendingQuestion[]): DialogItem[] {
	return questions.map((q) => ({
		id: q.id,
		label:
			q.question.length > 30 ? `${q.question.slice(0, 27)}\u2026` : q.question,
		prompt: q.question,
		options: (q.options ?? []).map((opt, i) => ({
			value: String(i),
			label: opt,
		})),
		textInput: { placeholder: "Type your answer\u2026" },
		...(q.context
			? {
					preview: {
						kind: "code" as const,
						content: q.context,
						title: "Context",
					},
				}
			: {}),
	}));
}

/**
 * Mirrors the answer extraction logic from showAskDialog.
 */
function extractQAPairs(
	questions: PendingQuestion[],
	result: DialogResult,
): QAPair[] {
	return questions.map((q) => {
		const answer = result.answers.find((a) => a.id === q.id);
		const text = answer?.text ?? answer?.label ?? "(no answer)";
		return { question: q.question, answer: text };
	});
}

describe("ask tool: dialog item construction", () => {
	it("maps questions to DialogItems with textInput", () => {
		const questions: PendingQuestion[] = [
			{ id: "q-1", question: "Which framework?", options: ["React", "Vue"] },
			{ id: "q-2", question: "Open-ended question?" },
		];

		const items = buildDialogItems(questions);

		expect(items).toHaveLength(2);
		expect(items[0].id).toBe("q-1");
		expect(items[0].prompt).toBe("Which framework?");
		expect(items[0].options).toHaveLength(2);
		expect(items[0].options[0].label).toBe("React");
		expect(items[0].textInput).toBeDefined();
		expect(items[1].options).toHaveLength(0);
		expect(items[1].textInput).toBeDefined();
	});

	it("truncates long question labels", () => {
		const questions: PendingQuestion[] = [
			{
				id: "q-1",
				question:
					"This is a very long question that exceeds the thirty character limit",
			},
		];

		const items = buildDialogItems(questions);
		expect(items[0].label.length).toBeLessThanOrEqual(30);
		expect(items[0].label).toContain("\u2026");
	});

	it("includes preview when context is provided", () => {
		const questions: PendingQuestion[] = [
			{
				id: "q-1",
				question: "Is this correct?",
				context: 'const x = "hello";',
			},
		];

		const items = buildDialogItems(questions);
		expect(items[0].preview).toBeDefined();
		expect(items[0].preview?.kind).toBe("code");
		expect(items[0].preview?.content).toBe('const x = "hello";');
	});
});

describe("ask tool: answer extraction", () => {
	it("extracts text answers from dialog result", () => {
		const questions: PendingQuestion[] = [
			{ id: "q-1", question: "Which style?", options: ["A", "B"] },
			{ id: "q-2", question: "Why?" },
		];

		const items = buildDialogItems(questions);
		const config: QuestionsConfig = {
			title: "Questions",
			items,
			requireAll: true,
		};
		const state = createState(config);

		// Answer q-1 by selecting option "A"
		selectOption(state); // selects first option for q-1

		// Answer q-2 with free text
		setTextContent(state, "Because it's simpler");
		submitText(state);

		const result = buildResult(state, false);
		const pairs = extractQAPairs(questions, result);

		expect(pairs).toHaveLength(2);
		expect(pairs[0].question).toBe("Which style?");
		expect(pairs[0].answer).toBe("A"); // option label was pre-filled to text
		expect(pairs[1].question).toBe("Why?");
		expect(pairs[1].answer).toBe("Because it's simpler");
	});

	it("returns (no answer) for unanswered questions", () => {
		const questions: PendingQuestion[] = [
			{ id: "q-1", question: "Something?" },
		];

		const result: DialogResult = {
			items: buildDialogItems(questions),
			answers: [],
			cancelled: false,
		};

		const pairs = extractQAPairs(questions, result);
		expect(pairs[0].answer).toBe("(no answer)");
	});
});

describe("ask tool: full dialog flow with options + text override", () => {
	it("allows selecting an option then editing the text", () => {
		const questions: PendingQuestion[] = [
			{
				id: "q-1",
				question: "Naming convention?",
				options: ["camelCase", "snake_case"],
			},
		];

		const items = buildDialogItems(questions);
		const config: QuestionsConfig = {
			title: "Questions",
			items,
			requireAll: true,
		};
		const state = createState(config);

		// Move to second option and select it
		moveDown(state);
		selectOption(state); // selects "snake_case", auto-advances to submit

		// Go back and edit the text
		state.currentTab = 0;
		state.textFieldFocused = true;
		setTextContent(state, "snake_case, but camelCase for exports");
		submitText(state);

		const result = buildResult(state, false);
		const pairs = extractQAPairs(questions, result);

		expect(pairs[0].answer).toBe("snake_case, but camelCase for exports");
	});

	it("allows answering with only free text (no option selection)", () => {
		const questions: PendingQuestion[] = [
			{
				id: "q-1",
				question: "What's your preference?",
				options: ["Option A", "Option B"],
			},
		];

		const items = buildDialogItems(questions);
		const config: QuestionsConfig = {
			title: "Questions",
			items,
			requireAll: true,
		};
		const state = createState(config);

		// Skip options, go directly to text field
		moveDown(state); // option 0 → option 1
		moveDown(state); // option 1 → text field

		setTextContent(state, "Neither, I want Option C");
		submitText(state);

		const result = buildResult(state, false);
		const pairs = extractQAPairs(questions, result);

		expect(pairs[0].answer).toBe("Neither, I want Option C");
	});
});
