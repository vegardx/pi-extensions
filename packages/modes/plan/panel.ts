/**
 * Floating plan panel — a persistent, non-capturing overlay anchored to the
 * top-right corner in plan mode. Renders the phase/task tree as a glanceable
 * HUD that doesn't steal vertical space from the chat flow.
 *
 * Two render modes:
 *   - compact (default): plan title + done/total tally + active phase line.
 *   - expanded: the full phase tree with the active phase's task checklist,
 *     scrollable when it overflows the viewport.
 *
 * The overlay is non-capturing, so the editor stays typable while the panel is
 * merely expanded. Pressing the toggle a second time focuses it (input routes
 * to {@link PlanPanelComponent.handleInput}) so ↑/↓ scroll; Esc/q releases.
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

/** Phases that count toward the "done" tally in the compact summary. */
const DONE_STATUSES = new Set(["ready-to-ship", "shipped"]);

/** Fraction of terminal height the expanded panel may occupy. */
const PANEL_HEIGHT_FRACTION = 0.7;
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

/** Compact body: plan title with a done/total tally + the active phase line. */
export function buildCompactLines(
	plan: Plan,
	theme: Theme,
	innerWidth: number,
): string[] {
	const summary = summarisePlan(plan);
	const lines: string[] = [];

	const tally = `${summary.donePhases}/${summary.totalPhases}`;
	const titleText = truncateToWidth(
		plan.title || "Plan",
		Math.max(1, innerWidth - tally.length - 2),
	);
	const pad = " ".repeat(
		Math.max(1, innerWidth - 1 - visibleWidth(titleText) - tally.length),
	);
	lines.push(` ${titleText}${pad}${theme.fg("muted", tally)}`);

	if (summary.activeIndex !== null && summary.activeTitle) {
		const label = truncateToWidth(
			`● ${summary.activeTitle}`,
			Math.max(1, innerWidth - 2),
		);
		lines.push(` ${theme.fg("accent", label)}`);
	}
	return lines;
}

/**
 * Full expanded tree: every phase with its status glyph, and the task
 * checklist for any phase that owns a worktree (active / needs-attention).
 */
export function buildTreeLines(
	plan: Plan,
	theme: Theme,
	innerWidth: number,
	selfSessionId?: string | null,
): string[] {
	const lines: string[] = [];
	for (const phase of plan.phases) {
		const glyph = STATUS_GLYPH[phase.status] ?? "○";
		const peerSuffix =
			phase.driverSessionId && phase.driverSessionId !== selfSessionId
				? " [peer]"
				: "";
		const title = truncateToWidth(
			`${phase.title}${peerSuffix}`,
			Math.max(1, innerWidth - 3),
		);
		lines.push(` ${glyph} ${title}`);

		if (WORKTREE_STATUSES.includes(phase.status)) {
			if (phase.tasks.length === 0) {
				lines.push(
					`   ${theme.fg("muted", truncateToWidth("(no tasks)", innerWidth - 4))}`,
				);
			} else {
				for (const task of phase.tasks) {
					const box = task.done ? "☑" : "☐";
					const label = truncateToWidth(
						task.title,
						Math.max(1, innerWidth - 5),
					);
					lines.push(`   ${box} ${label}`);
				}
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

/** Draw a rounded border around body lines with a centered title. */
export function boxify(
	theme: Theme,
	title: string,
	body: string[],
	width: number,
): string[] {
	const innerW = Math.max(1, width - 2);
	const result: string[] = [];

	const titleStr = truncateToWidth(` ${title} `, innerW);
	const titleW = visibleWidth(titleStr);
	const left = "─".repeat(Math.floor((innerW - titleW) / 2));
	const right = "─".repeat(Math.max(0, innerW - titleW - left.length));
	result.push(
		theme.fg("border", `╭${left}`) +
			theme.fg("accent", titleStr) +
			theme.fg("border", `${right}╮`),
	);

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
	expanded: boolean;
	focused: boolean;
	scrollOffset: number;
	/** Terminal height in rows, used to size the scroll viewport. */
	termHeight: number;
	selfSessionId?: string | null;
	/**
	 * Controls which footer hint to show when expanded but not focused.
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
 * Pure panel render. Returns the bordered lines plus the clamped scroll state
 * so the component (and tests) can stay in sync without side effects here.
 */
export function renderPlanPanel(
	plan: Plan,
	state: PlanPanelRenderState,
): PlanPanelRenderResult {
	const innerW = Math.max(1, state.width - 2);
	const { theme } = state;

	if (!state.expanded) {
		const body = buildCompactLines(plan, theme, innerW);
		return {
			lines: boxify(theme, "Plan", body, state.width),
			scrollOffset: 0,
			maxScroll: 0,
			pageRows: body.length,
		};
	}

	const full = buildTreeLines(plan, theme, innerW, state.selfSessionId);
	const maxPanelRows = Math.max(
		MIN_PANEL_ROWS,
		Math.floor(state.termHeight * PANEL_HEIGHT_FRACTION),
	);
	// chrome: top + bottom border + footer line.
	const maxBody = Math.max(1, maxPanelRows - 3);
	const win = windowLines(full, state.scrollOffset, maxBody);

	const hint = state.focused
		? "↑↓ scroll · Esc back"
		: state.toggleMode === "focus"
			? "^⇧O closes"
			: "^⇧O scroll · again closes";
	const body = [...win.rows, footerLine(theme, win, hint, innerW)];
	const title = state.focused ? "Plan · scroll" : "Plan";

	return {
		lines: boxify(theme, title, body, state.width),
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
			expanded: this.expanded,
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
