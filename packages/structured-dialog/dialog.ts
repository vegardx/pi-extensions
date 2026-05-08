/**
 * TUI dialog component. Uses `ctx.ui.custom()` to present the
 * structured dialog as either a fullscreen or overlay component.
 */

import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

import {
	buildResult,
	canSubmit,
	createState,
	currentItem,
	currentOptions,
	type DialogState,
	isSubmitTab,
	moveDown,
	moveUp,
	nextTab,
	prevTab,
	selectOption,
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

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string) {
				// Cancel
				if (matchesKey(data, Key.escape)) {
					done(buildResult(state, true));
					return;
				}

				// Tab navigation
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					if (nextTab(state)) refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					if (prevTab(state)) refresh();
					return;
				}

				// Submit tab: Enter to submit
				if (isSubmitTab(state)) {
					if (matchesKey(data, Key.enter) && canSubmit(state)) {
						done(buildResult(state, false));
					}
					return;
				}

				// Option navigation
				if (matchesKey(data, Key.up)) {
					if (moveUp(state)) refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					if (moveDown(state)) refresh();
					return;
				}

				// Select option
				if (matchesKey(data, Key.enter)) {
					if (selectOption(state)) refresh();
					return;
				}

				// Number keys for direct option selection
				const num = Number.parseInt(data, 10);
				if (num >= 1 && num <= currentOptions(state).length) {
					state.optionIndex = num - 1;
					if (selectOption(state)) refresh();
					return;
				}
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;
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
				const help =
					state.items.length > 1
						? " Tab/←→ navigate • ↑↓ select • Enter confirm • 1-9 quick-pick • Esc cancel"
						: " ↑↓ select • Enter confirm • 1-9 quick-pick • Esc cancel";
				add(theme.fg("dim", help));
				add(theme.fg("accent", "─".repeat(width)));

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
				const submitText = " ✓ Submit ";
				if (submitActive) {
					parts.push(theme.bg("selectedBg", theme.fg("text", submitText)));
				} else {
					parts.push(theme.fg(submitReady ? "success" : "dim", submitText));
				}
				lines.push(truncateToWidth(` ${parts.join("")}`, width));
			}

			function renderItemTab(
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

				// Preview pane
				if (item.preview) {
					renderPreview(item.preview, theme, width, lines);
					lines.push("");
				}

				// Options
				const opts = currentOptions(s);
				const existing = s.answers.get(item.id);
				if (existing) {
					add(`   ${theme.fg("success", `✓ Current: ${existing.label}`)}`);
					lines.push("");
				}
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === s.optionIndex;
					const prefix = selected ? theme.fg("accent", " > ") : "   ";
					const numKey = theme.fg("dim", `${i + 1}.`);
					const color = selected ? "accent" : "text";
					add(`${prefix}${numKey} ${theme.fg(color, opt.label)}`);
					if (opt.description) {
						add(`      ${theme.fg("muted", opt.description)}`);
					}
				}
			}

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
						add(
							`   ${theme.fg("success", "✓")} ${badge}${theme.fg("text", item.label)}: ${theme.fg("accent", answer.label)}`,
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

			function renderPreview(
				preview: {
					kind: string;
					content: string;
					language?: string;
					title?: string;
				},
				theme: Theme,
				width: number,
				lines: string[],
			) {
				const add = (str: string) => lines.push(truncateToWidth(str, width));
				const innerWidth = Math.max(20, width - 6);

				if (preview.title) {
					add(`   ${theme.fg("muted", `┌─ ${preview.title} ─`)}`);
				} else {
					add(`   ${theme.fg("muted", "┌─ preview ─")}`);
				}

				const previewLines = preview.content.split("\n");
				const maxLines = 12;
				const shown = previewLines.slice(0, maxLines);
				for (const line of shown) {
					const wrapped = wrapTextWithAnsi(line, innerWidth);
					for (const wl of wrapped) {
						add(`   ${theme.fg("muted", "│")} ${wl}`);
					}
				}
				if (previewLines.length > maxLines) {
					add(
						`   ${theme.fg("muted", "│")} ${theme.fg("dim", `… ${previewLines.length - maxLines} more lines`)}`,
					);
				}
				add(
					`   ${theme.fg("muted", `└${"─".repeat(Math.min(innerWidth, 40))}`)}`,
				);
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
				},
				handleInput,
			};
		},
		overlay ? { overlay: true } : undefined,
	);

	return result;
}
