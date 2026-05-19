/**
 * Questions — a tabbed multi-question prompt with options, optional
 * text input, optional per-option preview, and a submit tab. Mirrors
 * Claude Code's AskUserQuestion shape. Designed for use with
 * `ctx.ui.custom()`.
 *
 * Usage:
 *
 * ```ts
 * import { showQuestions } from "@vegardx/pi-questions";
 *
 * const result = await showQuestions(ctx, {
 *   title: "Review findings",
 *   items: [...],
 * });
 * ```
 */

export { showQuestions } from "./dialog.js";
export {
	allAnswered,
	answeredCount,
	buildResult,
	canSubmit,
	createState,
	currentItem,
	currentOptions,
	type DialogState,
	getTextContent,
	goToTab,
	hasTextInput,
	isSubmitTab,
	isTextFieldFocused,
	moveDown,
	moveUp,
	nextTab,
	prevTab,
	selectOption,
	setTextContent,
	submitText,
	totalTabs,
	unansweredItems,
} from "./state.js";
export type {
	DialogAnswer,
	DialogItem,
	DialogOption,
	DialogPreview,
	DialogResult,
	DialogTextInput,
	QuestionsConfig,
} from "./types.js";
