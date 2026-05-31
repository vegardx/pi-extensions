/**
 * Floating plan panel — a persistent, non-capturing overlay anchored to the
 * top-right corner in plan mode. Renders the phase/task tree as a glanceable
 * HUD that doesn't steal vertical space from the chat flow.
 *
 * Phase 1 scope: the component + a pure render path (compact summary and the
 * full tree). Expand/collapse toggling, focus, and scroll wiring land in a
 * later phase — the state fields exist here so that work is incremental.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

export interface PlanPanelRenderOptions {
	theme: Theme;
	/** Total overlay width in columns (including borders). */
	width: number;
	/** Session id of the local driver, for [peer] annotation. */
	selfSessionId?: string | null;
	/** When false, only the compact summary is shown. */
	expanded: boolean;
}

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
 * Render the inner body (no border) of the compact view: plan title with a
 * done/total tally, plus the active phase line when one exists.
 */
export function renderCompactBody(
	plan: Plan,
	opts: PlanPanelRenderOptions,
	innerWidth: number,
): string[] {
	const { theme } = opts;
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
 * Render the inner body (no border) of the expanded view: every phase with
 * its status glyph, and the task checklist for the active phase.
 */
export function renderExpandedBody(
	plan: Plan,
	opts: PlanPanelRenderOptions,
	innerWidth: number,
): string[] {
	const { theme, selfSessionId } = opts;
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

/**
 * Full panel render (border + body) for the given plan and state. Pure, so it
 * can be unit-tested without a live TUI.
 */
export function renderPlanPanel(
	plan: Plan,
	opts: PlanPanelRenderOptions,
): string[] {
	const innerW = Math.max(1, opts.width - 2);
	const body = opts.expanded
		? renderExpandedBody(plan, opts, innerW)
		: renderCompactBody(plan, opts, innerW);
	return boxify(opts.theme, "Plan", body, opts.width);
}

/**
 * The overlay Component. Holds view state and delegates rendering to the pure
 * functions above. The host supplies a fresh plan via {@link setPlan} whenever
 * the plan changes on disk.
 */
export class PlanPanelComponent implements Component {
	private plan: Plan | null;
	private readonly theme: Theme;
	private readonly selfSessionId: string | null;
	private readonly requestRender: () => void;

	/** Default to the full tree in Phase 1; the toggle lands in Phase 2. */
	expanded = true;
	scrollOffset = 0;

	constructor(args: {
		plan: Plan | null;
		theme: Theme;
		selfSessionId?: string | null;
		requestRender: () => void;
	}) {
		this.plan = args.plan;
		this.theme = args.theme;
		this.selfSessionId = args.selfSessionId ?? null;
		this.requestRender = args.requestRender;
	}

	setPlan(plan: Plan | null): void {
		this.plan = plan;
		this.requestRender();
	}

	render(width: number): string[] {
		if (!this.plan || this.plan.phases.length === 0) return [];
		return renderPlanPanel(this.plan, {
			theme: this.theme,
			width,
			selfSessionId: this.selfSessionId,
			expanded: this.expanded,
		});
	}

	invalidate(): void {}
}
