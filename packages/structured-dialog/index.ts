/**
 * Structured dialog — a generic tabbed TUI component for presenting
 * N items with per-item action choices, optional preview panes, and
 * a submit tab. Designed for use with `ctx.ui.custom()`.
 *
 * Usage:
 *
 * ```ts
 * import { showStructuredDialog } from "@vegardx/pi-structured-dialog";
 *
 * const result = await showStructuredDialog(ctx, {
 *   title: "Review findings",
 *   items: [...],
 * });
 * ```
 */

export { showStructuredDialog } from "./dialog.js";
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
	StructuredDialogConfig,
} from "./types.js";
