/**
 * Pure state machine for the structured dialog. No TUI imports —
 * fully testable in isolation. The TUI component delegates all
 * state transitions here.
 */

import type {
	DialogAnswer,
	DialogItem,
	DialogOption,
	DialogResult,
	StructuredDialogConfig,
} from "./types.js";

export interface DialogState {
	items: DialogItem[];
	/** Index into `items` for the active tab. `items.length` = submit tab. */
	currentTab: number;
	/** Index into the current item's options list. */
	optionIndex: number;
	/** Answers keyed by item id. */
	answers: Map<string, DialogAnswer>;
	/** Whether all items must be answered before submit. */
	requireAll: boolean;
	/** Title for the dialog. */
	title: string;
	/**
	 * Whether focus is in the text input field (vs. the options list).
	 * Only meaningful when the current item has `textInput`.
	 */
	textFieldFocused: boolean;
	/** Per-item text input content, keyed by item id. */
	textContent: Map<string, string>;
}

export function createState(config: StructuredDialogConfig): DialogState {
	const textContent = new Map<string, string>();
	for (const item of config.items) {
		if (item.textInput?.prefill) {
			textContent.set(item.id, item.textInput.prefill);
		}
	}
	return {
		items: config.items,
		currentTab: 0,
		optionIndex: 0,
		answers: new Map(),
		requireAll: config.requireAll ?? false,
		title: config.title ?? "Review",
		textFieldFocused: false,
		textContent,
	};
}

export function totalTabs(state: DialogState): number {
	return state.items.length + 1; // items + submit
}

export function isSubmitTab(state: DialogState): boolean {
	return state.currentTab === state.items.length;
}

export function currentItem(state: DialogState): DialogItem | undefined {
	return state.items[state.currentTab];
}

export function currentOptions(state: DialogState): DialogOption[] {
	const item = currentItem(state);
	return item?.options ?? [];
}

export function allAnswered(state: DialogState): boolean {
	return state.items.every((item) => state.answers.has(item.id));
}

export function canSubmit(state: DialogState): boolean {
	if (state.requireAll) return allAnswered(state);
	return true;
}

export function unansweredItems(state: DialogState): DialogItem[] {
	return state.items.filter((item) => !state.answers.has(item.id));
}

export function answeredCount(state: DialogState): number {
	return state.answers.size;
}

// ---- Actions (mutate in place, return whether state changed) -----------

export function nextTab(state: DialogState): boolean {
	const total = totalTabs(state);
	const next = (state.currentTab + 1) % total;
	if (next === state.currentTab) return false;
	state.currentTab = next;
	state.optionIndex = 0;
	state.textFieldFocused = false;
	return true;
}

export function prevTab(state: DialogState): boolean {
	const total = totalTabs(state);
	const next = (state.currentTab - 1 + total) % total;
	if (next === state.currentTab) return false;
	state.currentTab = next;
	state.optionIndex = 0;
	state.textFieldFocused = false;
	return true;
}

export function moveUp(state: DialogState): boolean {
	if (state.textFieldFocused) {
		// Move from text field back to last option (or stay if no options).
		const opts = currentOptions(state);
		if (opts.length > 0) {
			state.textFieldFocused = false;
			state.optionIndex = opts.length - 1;
			return true;
		}
		return false;
	}
	if (state.optionIndex <= 0) return false;
	state.optionIndex--;
	return true;
}

export function moveDown(state: DialogState): boolean {
	const item = currentItem(state);
	const opts = currentOptions(state);
	if (state.textFieldFocused) return false; // Already at bottom.
	if (state.optionIndex >= opts.length - 1) {
		// At last option — if item has text input, move focus there.
		if (item?.textInput) {
			state.textFieldFocused = true;
			return true;
		}
		return false;
	}
	state.optionIndex++;
	return true;
}

export function selectOption(state: DialogState): boolean {
	const item = currentItem(state);
	const opts = currentOptions(state);
	const opt = opts[state.optionIndex];
	if (!item || !opt) return false;

	// Pre-fill the text field with the option label if item has textInput.
	if (item.textInput) {
		state.textContent.set(item.id, opt.label);
	}

	state.answers.set(item.id, {
		id: item.id,
		value: opt.value,
		label: opt.label,
		text: item.textInput ? opt.label : undefined,
	});
	// Auto-advance to next unanswered tab or submit
	const nextUnanswered = state.items.findIndex(
		(it, idx) => idx > state.currentTab && !state.answers.has(it.id),
	);
	if (nextUnanswered >= 0) {
		state.currentTab = nextUnanswered;
	} else {
		state.currentTab = state.items.length; // submit tab
	}
	state.optionIndex = 0;
	state.textFieldFocused = false;
	return true;
}

export function goToTab(state: DialogState, tabIndex: number): boolean {
	const total = totalTabs(state);
	if (tabIndex < 0 || tabIndex >= total) return false;
	if (tabIndex === state.currentTab) return false;
	state.currentTab = tabIndex;
	state.optionIndex = 0;
	state.textFieldFocused = false;
	return true;
}

export function buildResult(
	state: DialogState,
	cancelled: boolean,
): DialogResult {
	// Merge text content into answers for items that have textInput.
	const answers: DialogAnswer[] = [...state.answers.values()].map((a) => {
		const item = state.items.find((it) => it.id === a.id);
		if (item?.textInput) {
			return { ...a, text: state.textContent.get(a.id) ?? a.text };
		}
		return a;
	});
	return {
		items: state.items,
		answers,
		cancelled,
	};
}

// ---- Text input helpers ---------------------------------------------------

/** Whether the text field is currently focused. */
export function isTextFieldFocused(state: DialogState): boolean {
	return state.textFieldFocused;
}

/** Get the current text content for a given item. */
export function getTextContent(state: DialogState, itemId: string): string {
	return state.textContent.get(itemId) ?? "";
}

/** Set the text content for the current item. */
export function setTextContent(state: DialogState, text: string): boolean {
	const item = currentItem(state);
	if (!item?.textInput) return false;
	state.textContent.set(item.id, text);
	return true;
}

/**
 * Submit the text field as the answer for the current item.
 * Records the answer and auto-advances to the next unanswered tab.
 */
export function submitText(state: DialogState): boolean {
	const item = currentItem(state);
	if (!item?.textInput) return false;
	const text = state.textContent.get(item.id) ?? "";
	if (text.trim().length === 0) return false; // Don't submit empty.

	state.answers.set(item.id, {
		id: item.id,
		value: "", // No option selected — pure text answer.
		label: text.length > 50 ? `${text.slice(0, 47)}…` : text,
		text,
	});

	// Auto-advance.
	const nextUnanswered = state.items.findIndex(
		(it, idx) => idx > state.currentTab && !state.answers.has(it.id),
	);
	if (nextUnanswered >= 0) {
		state.currentTab = nextUnanswered;
	} else {
		state.currentTab = state.items.length; // submit tab
	}
	state.optionIndex = 0;
	state.textFieldFocused = false;
	return true;
}

/**
 * Whether the current item has a text input field.
 * Useful for the renderer to decide whether to show the text area.
 */
export function hasTextInput(state: DialogState): boolean {
	const item = currentItem(state);
	return !!item?.textInput;
}
