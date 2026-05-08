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
}

export function createState(config: StructuredDialogConfig): DialogState {
	return {
		items: config.items,
		currentTab: 0,
		optionIndex: 0,
		answers: new Map(),
		requireAll: config.requireAll ?? false,
		title: config.title ?? "Review",
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
	return true;
}

export function prevTab(state: DialogState): boolean {
	const total = totalTabs(state);
	const next = (state.currentTab - 1 + total) % total;
	if (next === state.currentTab) return false;
	state.currentTab = next;
	state.optionIndex = 0;
	return true;
}

export function moveUp(state: DialogState): boolean {
	if (state.optionIndex <= 0) return false;
	state.optionIndex--;
	return true;
}

export function moveDown(state: DialogState): boolean {
	const opts = currentOptions(state);
	if (state.optionIndex >= opts.length - 1) return false;
	state.optionIndex++;
	return true;
}

export function selectOption(state: DialogState): boolean {
	const item = currentItem(state);
	const opts = currentOptions(state);
	const opt = opts[state.optionIndex];
	if (!item || !opt) return false;
	state.answers.set(item.id, {
		id: item.id,
		value: opt.value,
		label: opt.label,
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
	return true;
}

export function goToTab(state: DialogState, tabIndex: number): boolean {
	const total = totalTabs(state);
	if (tabIndex < 0 || tabIndex >= total) return false;
	if (tabIndex === state.currentTab) return false;
	state.currentTab = tabIndex;
	state.optionIndex = 0;
	return true;
}

export function buildResult(
	state: DialogState,
	cancelled: boolean,
): DialogResult {
	return {
		items: state.items,
		answers: [...state.answers.values()],
		cancelled,
	};
}
