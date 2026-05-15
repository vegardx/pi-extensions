/**
 * TUI dialog component. Uses `ctx.ui.custom()` to present the
 * structured dialog as either a fullscreen or overlay component.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import {
	buildResult,
	canSubmit,
	createState,
	currentItem,
	currentOptions,
	type DialogState,
	getTextContent,
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
	unansweredItems,
} from "./state.js";
import type { DialogResult, StructuredDialogConfig } from "./types.js";

/**
 * Show the structured dialog and return the user's decisions.
 * Blocks until the user submits or cancels.
 */
export async function showStructuredDialog(
	ctx: ExtensionContext,
	config: StructuredDialogConfig,
): Promise<DialogResult> {
	if (!ctx.hasUI) {
		// Non-interactive fallback — return cancelled.
		return { items: config.items, answers: [], cancelled: true };
	}

	const mode = config.mode ?? "fullscreen";
	const overlay = mode === "overlay";

	const result = await ctx.ui.custom<DialogResult>(
		(tui, theme, _kb, done) => {
			const state = createState(config);
			let cachedLines: string[] | undefined;
			// Track the width that produced cachedLines so a resize invalidates
			// the cache automatically without needing an explicit refresh().
			let cachedWidth = -1;

			// Cursor position for text field (character index).
			let cursorPos = 0;

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function initCursorForCurrentItem() {
				const item = currentItem(state);
				if (item) {
					const text = getTextContent(state, item.id);
					cursorPos = text.length;
				}
			}

			function handleInput(data: string) {
				// Cancel
				if (matchesKey(data, Key.escape)) {
					done(buildResult(state, true));
					return;
				}

				// Tab navigation (←→ always switch question tabs)
				if (matchesKey(data, Key.right)) {
					if (nextTab(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.left)) {
					if (prevTab(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}

				// Submit tab: Enter to submit
				if (isSubmitTab(state)) {
					if (matchesKey(data, Key.enter) && canSubmit(state)) {
						done(buildResult(state, false));
					}
					return;
				}

				// When text field is focused, handle text editing.
				if (isTextFieldFocused(state)) {
					handleTextInput(data);
					return;
				}

				// Option navigation
				if (matchesKey(data, Key.up)) {
					if (moveUp(state)) refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (moveDown(state)) {
						// If we just moved into the text field, init cursor.
						if (isTextFieldFocused(state)) {
							initCursorForCurrentItem();
						}
						refresh();
					}
					return;
				}

				// Tab key: jump to text field if present, else next question
				if (matchesKey(data, Key.tab)) {
					if (hasTextInput(state) && !isTextFieldFocused(state)) {
						state.textFieldFocused = true;
						initCursorForCurrentItem();
						refresh();
					} else if (nextTab(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.shift("tab"))) {
					if (prevTab(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}

				// Select option (Enter)
				if (matchesKey(data, Key.enter)) {
					if (selectOption(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}

				// Number keys for direct option selection
				const num = Number.parseInt(data, 10);
				if (num >= 1 && num <= currentOptions(state).length) {
					state.optionIndex = num - 1;
					if (selectOption(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}
			}

			function handleTextInput(data: string) {
				const item = currentItem(state);
				if (!item) return;
				const text = getTextContent(state, item.id);

				// Navigate back to options
				if (matchesKey(data, Key.up)) {
					if (moveUp(state)) refresh();
					return;
				}

				// Submit text answer on Enter
				if (matchesKey(data, Key.enter)) {
					if (submitText(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}

				// Tab: advance to next question
				if (matchesKey(data, Key.tab)) {
					if (text.trim().length > 0) {
						submitText(state);
					}
					if (nextTab(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}
				if (matchesKey(data, Key.shift("tab"))) {
					if (text.trim().length > 0) {
						submitText(state);
					}
					if (prevTab(state)) {
						initCursorForCurrentItem();
						refresh();
					}
					return;
				}

				// Backspace
				if (matchesKey(data, Key.backspace)) {
					if (cursorPos > 0) {
						const updated =
							text.slice(0, cursorPos - 1) + text.slice(cursorPos);
						setTextContent(state, updated);
						cursorPos--;
						refresh();
					}
					return;
				}

				// Delete
				if (matchesKey(data, Key.delete)) {
					if (cursorPos < text.length) {
						const updated =
							text.slice(0, cursorPos) + text.slice(cursorPos + 1);
						setTextContent(state, updated);
						refresh();
					}
					return;
				}

				// Home / Ctrl+A
				if (data === "\x01" || matchesKey(data, Key.home)) {
					if (cursorPos !== 0) {
						cursorPos = 0;
						refresh();
					}
					return;
				}

				// End / Ctrl+E
				if (data === "\x05" || matchesKey(data, Key.end)) {
					if (cursorPos !== text.length) {
						cursorPos = text.length;
						refresh();
					}
					return;
				}

				// Printable characters — insert at cursor.
				if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") {
					const updated =
						text.slice(0, cursorPos) + data + text.slice(cursorPos);
					setTextContent(state, updated);
					cursorPos += data.length;
					refresh();
					return;
				}
			}

			function render(width: number): string[] {
				if (cachedLines !== undefined && width === cachedWidth)
					return cachedLines;
				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));

				// Top border
				add(theme.fg("accent", "─".repeat(width)));

				// Title
				if (state.title) {
					add(` ${theme.fg("accent", theme.bold(state.title))}`);
					lines.push("");
				}

				// Tab bar
				renderTabBar(state, theme, width, lines);
				lines.push("");

				// Content
				if (isSubmitTab(state)) {
					renderSubmitTab(state, theme, width, lines);
				} else {
					renderItemTab(state, theme, width, lines);
				}

				// Footer
				lines.push("");
				const tfFocused = isTextFieldFocused(state);
				let help: string;
				if (isSubmitTab(state)) {
					help = " ←→ questions • Enter submit • Esc cancel";
				} else if (tfFocused) {
					help = " ←→ questions • ↑ options • Enter submit answer • Esc cancel";
				} else {
					const hasText = hasTextInput(state);
					help = hasText
						? " ←→ questions • ↑↓ select • Enter confirm • Tab text field • Esc cancel"
						: " ←→ questions • ↑↓ select • Enter confirm • 1-9 quick-pick • Esc cancel";
				}
				add(theme.fg("dim", help));
				add(theme.fg("accent", "─".repeat(width)));

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			}

			function renderTabBar(
				s: DialogState,
				theme: Theme,
				width: number,
				lines: string[],
			) {
				const parts: string[] = [];
				for (let i = 0; i < s.items.length; i++) {
					const item = s.items[i];
					const isActive = i === s.currentTab;
					const isAnswered = s.answers.has(item.id);
					const badge = item.badge ? `${item.badge} ` : "";
					const icon = isAnswered ? "✓" : "○";
					const text = ` ${icon} ${badge}${item.label} `;
					if (isActive) {
						parts.push(theme.bg("selectedBg", theme.fg("text", text)));
					} else {
						const color = isAnswered ? "success" : "muted";
						parts.push(theme.fg(color, text));
					}
					parts.push(" ");
				}
				// Submit tab
				const submitActive = isSubmitTab(s);
				const submitReady = canSubmit(s);
				const submitLabel = " ✓ Submit ";
				if (submitActive) {
					parts.push(theme.bg("selectedBg", theme.fg("text", submitLabel)));
				} else {
					parts.push(theme.fg(submitReady ? "success" : "dim", submitLabel));
				}
				lines.push(truncateToWidth(` ${parts.join("")}`, width));
			}

			// ---- Item tab rendering ------------------------------------------

			function renderItemTab(
				s: DialogState,
				theme: Theme,
				width: number,
				lines: string[],
			) {
				const item = currentItem(s);
				if (!item) return;

				if (item.preview) {
					renderSplitLayout(s, theme, width, lines);
				} else {
					renderSingleColumnLayout(s, theme, width, lines);
				}
			}

			/** Full-width layout when no preview is present. */
			function renderSingleColumnLayout(
				s: DialogState,
				theme: Theme,
				width: number,
				lines: string[],
			) {
				const item = currentItem(s);
				if (!item) return;
				const add = (str: string) => lines.push(truncateToWidth(str, width));

				// Badge + prompt
				if (item.badge) {
					add(
						` ${theme.fg("warning", `[${item.badge}]`)} ${theme.fg("text", item.prompt)}`,
					);
				} else {
					add(` ${theme.fg("text", item.prompt)}`);
				}
				lines.push("");

				// Metadata
				if (item.metadata && item.metadata.length > 0) {
					for (const m of item.metadata) {
						add(
							`   ${theme.fg("muted", `${m.key}:`)} ${theme.fg("text", m.value)}`,
						);
					}
					lines.push("");
				}

				renderOptionsAndTextField(s, theme, width, lines);
			}

			/** Split layout: left = question+options, right = preview. */
			function renderSplitLayout(
				s: DialogState,
				theme: Theme,
				width: number,
				lines: string[],
			) {
				const item = currentItem(s);
				if (!item?.preview) return;

				// Divide width: left ~55%, separator 3 chars, right ~45%.
				const sepStr = " │ ";
				const sepWidth = 3;
				const usable = width - sepWidth - 2; // 2 for outer margins
				const leftWidth = Math.max(20, Math.floor(usable * 0.55));
				const rightWidth = Math.max(20, usable - leftWidth);

				// ---- Build left pane ----
				const leftLines: string[] = [];
				const addLeft = (str: string) =>
					leftLines.push(truncateToWidth(str, leftWidth));

				if (item.badge) {
					addLeft(
						`${theme.fg("warning", `[${item.badge}]`)} ${theme.fg("text", item.prompt)}`,
					);
				} else {
					addLeft(theme.fg("text", item.prompt));
				}
				leftLines.push("");

				if (item.metadata && item.metadata.length > 0) {
					for (const m of item.metadata) {
						addLeft(
							`  ${theme.fg("muted", `${m.key}:`)} ${theme.fg("text", m.value)}`,
						);
					}
					leftLines.push("");
				}

				renderOptionsAndTextField(s, theme, leftWidth, leftLines);

				// ---- Build right pane (preview with proper box) ----
				const rightLines: string[] = [];
				const preview = item.preview;
				const previewInner = rightWidth - 4; // 2 for border + 2 padding
				const title = preview.title ?? "preview";

				// Top border
				const topLabel = `─ ${title} `;
				const topPad = Math.max(0, rightWidth - 2 - visibleWidth(topLabel));
				rightLines.push(
					theme.fg("muted", `┌${topLabel}${"─".repeat(topPad)}┐`),
				);

				// Content lines
				const previewContentLines = preview.content.split("\n");
				const maxPreviewLines = 20;
				const shown = previewContentLines.slice(0, maxPreviewLines);
				for (const pLine of shown) {
					const wrapped = wrapTextWithAnsi(pLine, previewInner);
					for (const wl of wrapped) {
						const pad = Math.max(0, previewInner - visibleWidth(wl));
						rightLines.push(
							`${theme.fg("muted", "│")} ${wl}${" ".repeat(pad)} ${theme.fg("muted", "│")}`,
						);
					}
				}
				if (previewContentLines.length > maxPreviewLines) {
					const moreLabel = `… ${previewContentLines.length - maxPreviewLines} more lines`;
					const morePad = Math.max(0, previewInner - visibleWidth(moreLabel));
					rightLines.push(
						`${theme.fg("muted", "│")} ${theme.fg("dim", moreLabel)}${" ".repeat(morePad)} ${theme.fg("muted", "│")}`,
					);
				}

				// Bottom border
				rightLines.push(theme.fg("muted", `└${"─".repeat(rightWidth - 2)}┘`));

				// ---- Zip left and right panes ----
				const totalLines = Math.max(leftLines.length, rightLines.length);
				for (let i = 0; i < totalLines; i++) {
					const left = leftLines[i] ?? "";
					const right = rightLines[i] ?? "";
					const leftPad = Math.max(0, leftWidth - visibleWidth(left));
					lines.push(
						truncateToWidth(
							` ${left}${" ".repeat(leftPad)}${theme.fg("muted", sepStr)}${right}`,
							width,
						),
					);
				}
			}

			/** Render options list + text field (used by both layouts). */
			function renderOptionsAndTextField(
				s: DialogState,
				theme: Theme,
				maxWidth: number,
				lines: string[],
			) {
				const item = currentItem(s);
				if (!item) return;
				const add = (str: string) => lines.push(truncateToWidth(str, maxWidth));

				const opts = currentOptions(s);
				const existing = s.answers.get(item.id);
				if (existing && !s.textFieldFocused) {
					add(`  ${theme.fg("success", `✓ Current: ${existing.label}`)}`);
					lines.push("");
				}
				const tfFocused = isTextFieldFocused(s);
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = !tfFocused && i === s.optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const numKey = theme.fg("dim", `${i + 1}.`);
					const color = selected ? "accent" : "text";
					add(`${prefix}${numKey} ${theme.fg(color, opt.label)}`);
					if (opt.description) {
						add(`     ${theme.fg("muted", opt.description)}`);
					}
				}

				// Text input field
				if (item.textInput) {
					lines.push("");
					const textVal = getTextContent(s, item.id);
					const innerWidth = Math.max(10, maxWidth - 4);
					const borderChar = tfFocused ? "accent" : "muted";

					add(`  ${theme.fg(borderChar, `┌${"─".repeat(innerWidth)}┐`)}`);

					let displayText: string;
					if (tfFocused) {
						const before = textVal.slice(0, cursorPos);
						const after = textVal.slice(cursorPos);
						displayText = before + CURSOR_MARKER + after;
					} else {
						displayText =
							textVal ||
							theme.fg(
								"dim",
								item.textInput.placeholder ?? "Type your answer…",
							);
					}

					const textLines = wrapTextWithAnsi(displayText, innerWidth - 2);
					const minLines = 1;
					const shownLines = Math.max(minLines, textLines.length);
					for (let i = 0; i < shownLines; i++) {
						const line = textLines[i] ?? "";
						const pad = innerWidth - 2 - visibleWidth(line);
						add(
							`  ${theme.fg(borderChar, "│")} ${line}${" ".repeat(Math.max(0, pad))} ${theme.fg(borderChar, "│")}`,
						);
					}

					add(`  ${theme.fg(borderChar, `└${"─".repeat(innerWidth)}┘`)}`);
				}
			}

			// ---- Submit tab --------------------------------------------------

			function renderSubmitTab(
				s: DialogState,
				theme: Theme,
				width: number,
				lines: string[],
			) {
				const add = (str: string) => lines.push(truncateToWidth(str, width));

				add(` ${theme.fg("accent", theme.bold("Summary"))}`);
				lines.push("");

				for (const item of s.items) {
					const answer = s.answers.get(item.id);
					const badge = item.badge
						? `${theme.fg("warning", `[${item.badge}]`)} `
						: "";
					if (answer) {
						const label =
							answer.text && answer.text !== answer.label
								? answer.text.length > 60
									? `${answer.text.slice(0, 57)}…`
									: answer.text
								: answer.label;
						add(
							`   ${theme.fg("success", "✓")} ${badge}${theme.fg("text", item.label)}: ${theme.fg("accent", label)}`,
						);
					} else {
						add(
							`   ${theme.fg("dim", "○")} ${badge}${theme.fg("muted", item.label)}: ${theme.fg("dim", "(unanswered)")}`,
						);
					}
				}

				lines.push("");
				const answered = s.answers.size;
				const total = s.items.length;
				add(`   ${theme.fg("muted", `${answered}/${total} answered`)}`);

				if (!canSubmit(s)) {
					const missing = unansweredItems(s)
						.map((it) => it.label)
						.join(", ");
					lines.push("");
					add(`   ${theme.fg("warning", `⚠ Required: ${missing}`)}`);
				} else {
					lines.push("");
					add(`   ${theme.fg("success", "Press Enter to submit")}`);
				}
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
					cachedWidth = -1;
				},
				handleInput,
			};
		},
		overlay ? { overlay: true } : undefined,
	);

	return result;
}
