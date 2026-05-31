/**
 * Floating plan panel — a persistent, non-capturing overlay anchored to the
 * top-right corner. It's always mounted whenever a plan exists, regardless of
 * mode (plan / auto / ask / hack), and auto-hides only on terminals too narrow
 * to carry it alongside the chat column.
 *
 * The default view is the full phase list: every phase on one line as
 * `<glyph> <title> [done/total]`, where the tally counts that phase's tasks.
 * The active phase auto-expands its `☑`/`☐` checklist beneath it. The border
 * carries no title — just the box edge.
 *
 * The overlay is non-capturing, so the editor stays typable. Focusing it
 * (via the toggle shortcut) routes input to {@link PlanPanelComponent.handleInput}
 * so ↑/↓ scroll the list; Esc/q releases focus back to the editor.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { Plan } from "./schema.js";
import { WORKTREE_STATUSES } from "./schema.js";

/** Glyphs shown next to a phase for each status. */
export const STATUS_GLYPH: Record<string, string> = {
	planned: "○",
	active: "●",
	"in-review": "➜",
	"needs-attention": "!",
	"ready-to-ship": "✓",
	shipped: "✔",
	abandoned: "✗",
};

/** Phases that count toward the "done" tally in the overall summary. */
const DONE_STATUSES = new Set(["ready-to-ship", "shipped"]);

/** Floor so the panel is usable even on short terminals. */
const MIN_PANEL_ROWS = 6;

export interface PlanSummary {
	donePhases: number;
	totalPhases: number;
	activeIndex: number | null;
	activeTitle: string | null;
}

/**
 * Derive the compact-summary numbers from a plan. `activeIndex` is 1-based
 * across all phases; abandoned phases still occupy a slot so the index lines
 * up with what the user sees in the tree.
 */
export function summarisePlan(plan: Plan): PlanSummary {
	let done = 0;
	let activeIndex: number | null = null;
	let activeTitle: string | null = null;
	plan.phases.forEach((phase, i) => {
		if (DONE_STATUSES.has(phase.status)) done++;
		if (activeIndex === null && WORKTREE_STATUSES.includes(phase.status)) {
			activeIndex = i + 1;
			activeTitle = phase.title;
		}
	});
	return {
		donePhases: done,
		totalPhases: plan.phases.length,
		activeIndex,
		activeTitle,
	};
}

/**
 * Per-phase task tally `[done/total]`, counting every task on the phase
 * (deliverable or not) so it matches what the expanded checklist displays.
 */
function phaseTally(phase: Plan["phases"][number]): string {
	const done = phase.tasks.filter((t) => t.done).length;
	return `[${done}/${phase.tasks.length}]`;
}

/**
 * Full phase list: every phase on one line as `<glyph> <title> [done/total]`,
 * with the tally right-aligned. A phase reveals its `☑`/`☐` task checklist when
 * it owns a worktree (active / needs-attention) or when its id is in
 * `expandedPhaseIds` (an explicit user expand from the focused panel).
 */
export function buildTreeLines(
	plan: Plan,
	theme: Theme,
	innerWidth: number,
	selfSessionId?: string | null,
	expandedPhaseIds?: ReadonlySet<string>,
): string[] {
	const lines: string[] = [];
	for (const phase of plan.phases) {
		const glyph = STATUS_GLYPH[phase.status] ?? "○";
		const peerSuffix =
			phase.driverSessionId && phase.driverSessionId !== selfSessionId
				? " [peer]"
				: "";
		const tally = phaseTally(phase);
		const prefix = ` ${glyph} `;
		const prefixW = visibleWidth(prefix);
		// Reserve a 1-col gutter on the right so the tally isn't glued to the border.
		const titleMax = Math.max(1, innerWidth - prefixW - tally.length - 2);
		const title = truncateToWidth(`${phase.title}${peerSuffix}`, titleMax);
		const pad = " ".repeat(
			Math.max(
				1,
				innerWidth - prefixW - visibleWidth(title) - tally.length - 1,
			),
		);
		lines.push(`${prefix}${title}${pad}${theme.fg("muted", tally)}`);

		const expanded =
			WORKTREE_STATUSES.includes(phase.status) ||
			(expandedPhaseIds?.has(phase.id) ?? false);
		if (!expanded) continue;

		if (phase.tasks.length === 0) {
			lines.push(
				`   ${theme.fg("muted", truncateToWidth("(no tasks)", innerWidth - 4))}`,
			);
		} else {
			for (const task of phase.tasks) {
				const box = task.done ? "☑" : "☐";
				const label = truncateToWidth(task.title, Math.max(1, innerWidth - 5));
				lines.push(`   ${box} ${label}`);
			}
		}
	}
	return lines;
}

export interface ScrollWindow {
	rows: string[];
	/** Largest valid scroll offset for this content/viewport. */
	maxScroll: number;
	/** `offset` clamped into `[0, maxScroll]`. */
	clampedOffset: number;
	atTop: boolean;
	atBottom: boolean;
}

/**
 * Slice `lines` to a `maxRows` window starting at `offset`, clamping the offset
 * so it can never scroll past the content. Pure, so scroll math is unit-testable
 * without a live TUI.
 */
export function windowLines(
	lines: string[],
	offset: number,
	maxRows: number,
): ScrollWindow {
	const rows = Math.max(1, maxRows);
	if (lines.length <= rows) {
		return {
			rows: lines,
			maxScroll: 0,
			clampedOffset: 0,
			atTop: true,
			atBottom: true,
		};
	}
	const maxScroll = lines.length - rows;
	const clamped = Math.min(Math.max(0, offset), maxScroll);
	return {
		rows: lines.slice(clamped, clamped + rows),
		maxScroll,
		clampedOffset: clamped,
		atTop: clamped === 0,
		atBottom: clamped >= maxScroll,
	};
}

/**
 * Draw a rounded border around body lines. With a non-empty `title`, it's
 * centered on the top edge; with an empty title the top edge is a clean run of
 * `─` (the panel deliberately carries no title).
 */
export function boxify(
	theme: Theme,
	title: string,
	body: string[],
	width: number,
): string[] {
	const innerW = Math.max(1, width - 2);
	const result: string[] = [];

	if (title) {
		const titleStr = truncateToWidth(` ${title} `, innerW);
		const titleW = visibleWidth(titleStr);
		const left = "─".repeat(Math.floor((innerW - titleW) / 2));
		const right = "─".repeat(Math.max(0, innerW - titleW - left.length));
		result.push(
			theme.fg("border", `╭${left}`) +
				theme.fg("accent", titleStr) +
				theme.fg("border", `${right}╮`),
		);
	} else {
		result.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
	}

	for (const line of body) {
		const padded = padTo(line, innerW);
		result.push(theme.fg("border", "│") + padded + theme.fg("border", "│"));
	}

	result.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
	return result;
}

/** Pad (or truncate) a possibly-styled line to exactly `width` cells. */
function padTo(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w > width) return truncateToWidth(line, width);
	return line + " ".repeat(width - w);
}

/** Build the footer line: scroll position (when overflowing) + a key hint. */
function footerLine(
	theme: Theme,
	win: ScrollWindow,
	hint: string,
	innerWidth: number,
): string {
	const scroll =
		win.maxScroll > 0
			? `↑${win.clampedOffset} ↓${win.maxScroll - win.clampedOffset}`
			: "";
	const hintW = visibleWidth(hint);
	const scrollW = visibleWidth(scroll);
	const gap = Math.max(1, innerWidth - 1 - scrollW - hintW);
	const left = scroll ? ` ${theme.fg("dim", scroll)}` : " ";
	return `${left}${" ".repeat(gap)}${theme.fg("dim", hint)}`;
}

export interface PlanPanelRenderState {
	theme: Theme;
	width: number;
	focused: boolean;
	scrollOffset: number;
	/** Terminal height in rows, used to size the scroll viewport. */
	termHeight: number;
	selfSessionId?: string | null;
	/** Phase ids explicitly expanded from the focused panel (phase 2). */
	expandedPhaseIds?: ReadonlySet<string>;
	/**
	 * Controls which footer hint to show when overflowing but not focused.
	 * `cycle` (default): next ^⇧O focuses for scroll.
	 * `focus`: next ^⇧O collapses.
	 */
	toggleMode?: "cycle" | "focus";
}

export interface PlanPanelRenderResult {
	lines: string[];
	/** Clamped scroll offset — the host should store this back. */
	scrollOffset: number;
	maxScroll: number;
	/** Body rows visible in the expanded window (for page scrolling). */
	pageRows: number;
}

/**
 * Pure panel render. Always renders the full phase list (active phase expanded)
 * with a title-less border. Returns the clamped scroll state so the component
 * (and tests) can stay in sync without side effects here. A footer hint line is
 * appended only when focused or when the list overflows the viewport.
 */
export function renderPlanPanel(
	plan: Plan,
	state: PlanPanelRenderState,
): PlanPanelRenderResult {
	const innerW = Math.max(1, state.width - 2);
	const { theme } = state;

	const full = buildTreeLines(
		plan,
		theme,
		innerW,
		state.selfSessionId,
		state.expandedPhaseIds,
	);

	// Use nearly the whole viewport (minus a top margin) so the always-on panel
	// can show as much of the plan as fits.
	const maxPanelRows = Math.max(MIN_PANEL_ROWS, state.termHeight - 2);
	// chrome without a footer: top + bottom border.
	const noFooterBody = Math.max(1, maxPanelRows - 2);
	const overflow = full.length > noFooterBody;
	const showFooter = state.focused || overflow;
	// With a footer, reserve one more row for it.
	const maxBody = showFooter ? Math.max(1, maxPanelRows - 3) : noFooterBody;
	const win = windowLines(full, state.scrollOffset, maxBody);

	let body = win.rows;
	if (showFooter) {
		const hint = state.focused
			? "↑↓ scroll · Esc back"
			: state.toggleMode === "focus"
				? "^⇧O closes"
				: "^⇧O to scroll";
		body = [...win.rows, footerLine(theme, win, hint, innerW)];
	}

	return {
		lines: boxify(theme, "", body, state.width),
		scrollOffset: win.clampedOffset,
		maxScroll: win.maxScroll,
		pageRows: win.rows.length,
	};
}

/**
 * The overlay Component. Holds view state and delegates rendering to the pure
 * functions above. The host supplies a fresh plan via {@link setPlan} whenever
 * the plan changes on disk, and a terminal height via {@link setViewportHeight}
 * from the overlay's `visible` callback.
 */
export class PlanPanelComponent implements Component {
	private plan: Plan | null;
	private readonly theme: Theme;
	private readonly selfSessionId: string | null;
	private readonly requestRender: () => void;
	private readonly onRequestUnfocus: () => void;

	/** Compact by default; the toggle shortcut expands it. */
	expanded = false;
	focused = false;
	scrollOffset = 0;
	private termHeight = 24;
	private toggleMode: "cycle" | "focus" = "cycle";
	private maxScroll = 0;
	private pageRows = 5;

	constructor(args: {
		plan: Plan | null;
		theme: Theme;
		selfSessionId?: string | null;
		requestRender: () => void;
		onRequestUnfocus: () => void;
	}) {
		this.plan = args.plan;
		this.theme = args.theme;
		this.selfSessionId = args.selfSessionId ?? null;
		this.requestRender = args.requestRender;
		this.onRequestUnfocus = args.onRequestUnfocus;
	}

	setPlan(plan: Plan | null): void {
		this.plan = plan;
		this.requestRender();
	}

	setViewportHeight(rows: number): void {
		this.termHeight = rows;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		if (!expanded) this.scrollOffset = 0;
		this.requestRender();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.requestRender();
	}

	setToggleMode(mode: "cycle" | "focus"): void {
		this.toggleMode = mode;
	}

	render(width: number): string[] {
		if (!this.plan || this.plan.phases.length === 0) return [];
		const result = renderPlanPanel(this.plan, {
			theme: this.theme,
			width,
			focused: this.focused,
			scrollOffset: this.scrollOffset,
			termHeight: this.termHeight,
			selfSessionId: this.selfSessionId,
			toggleMode: this.toggleMode,
		});
		this.scrollOffset = result.scrollOffset;
		this.maxScroll = result.maxScroll;
		this.pageRows = Math.max(1, result.pageRows);
		return result.lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onRequestUnfocus();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollBy(-1);
		} else if (matchesKey(data, "down")) {
			this.scrollBy(1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollBy(-this.pageRows);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollBy(this.pageRows);
		}
	}

	private scrollBy(delta: number): void {
		const next = Math.min(
			Math.max(0, this.scrollOffset + delta),
			this.maxScroll,
		);
		if (next !== this.scrollOffset) {
			this.scrollOffset = next;
			this.requestRender();
		}
	}

	invalidate(): void {}
}
