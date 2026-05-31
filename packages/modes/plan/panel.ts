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
 * The overlay is non-capturing, so the editor stays typable. It's a passive
 * at-a-glance display; pressing the plan-view shortcut (ctrl+shift+p) opens a
 * dedicated full-screen {@link PlanPanelComponent} for navigation.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import type { BoxFooter } from "../sidebar/box.js";
import { boxify } from "../sidebar/box.js";
import type { Plan } from "./schema.js";
import { WORKTREE_STATUSES } from "./schema.js";

// Re-exported for back-compat: the box renderer now lives in sidebar/box.ts so
// the plan panel and the overlay sidebar share one implementation.
export type { BoxFooter } from "../sidebar/box.js";
export { boxify };

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
 * Whether a phase reveals its task checklist: it owns a worktree
 * (active / needs-attention) or its id was explicitly expanded from the
 * focused panel. {@link phaseHeaderOffsets} mirrors this rule — keep them in
 * sync.
 */
function isPhaseExpanded(
	phase: Plan["phases"][number],
	expandedPhaseIds?: ReadonlySet<string>,
): boolean {
	return (
		WORKTREE_STATUSES.includes(phase.status) ||
		(expandedPhaseIds?.has(phase.id) ?? false)
	);
}

/**
 * Line index of each phase's header row within the list produced by
 * {@link buildTreeLines}, given the same expansion state. Used to keep the
 * selected phase inside the scroll window during keyboard navigation.
 */
export function phaseHeaderOffsets(
	plan: Plan,
	expandedPhaseIds?: ReadonlySet<string>,
): number[] {
	const offsets: number[] = [];
	let line = 0;
	for (const phase of plan.phases) {
		offsets.push(line);
		line += 1; // the phase header row
		if (isPhaseExpanded(phase, expandedPhaseIds)) {
			line += phase.tasks.length === 0 ? 1 : phase.tasks.length;
		}
	}
	return offsets;
}

/**
 * How a phase's concurrent driver is shown in the panel. The host derives this
 * (it owns the fs liveness check via `evaluateClaim`) and passes a per-phase map
 * into the renderer so `panel.ts` stays pure.
 *
 * - `self`: the local session drives this phase.
 * - `peer-live`: another session drives it and its claim is fresh.
 * - `peer-stale`: another session's claim has gone quiet (crashed/abandoned).
 */
export type PhaseDriverBadge = "self" | "peer-live" | "peer-stale";

/** Plain + styled forms of a driver badge, or null for no badge. */
function renderDriverBadge(
	theme: Theme,
	badge: PhaseDriverBadge | undefined,
): { plain: string; styled: string } | null {
	switch (badge) {
		case "self":
			return { plain: " ◆ self", styled: ` ${theme.fg("accent", "◆ self")}` };
		case "peer-live":
			return {
				plain: " ◆ peer·live",
				styled: ` ${theme.fg("warning", "◆ peer·live")}`,
			};
		case "peer-stale":
			return {
				plain: " ◆ peer·stale",
				styled: ` ${theme.fg("dim", "◆ peer·stale")}`,
			};
		default:
			return null;
	}
}

/**
 * Full phase list: every phase on one line as `<glyph> <title> [done/total]`,
 * with the tally right-aligned. A phase reveals its `☑`/`☐` task checklist when
 * it owns a worktree (active / needs-attention) or when its id is in
 * `expandedPhaseIds` (an explicit user expand from the focused panel). When
 * `selectedIndex` is provided, that phase's header carries a cursor bar and its
 * title is accented. `driverBadges` annotates phases driven by a concurrent
 * session (see {@link PhaseDriverBadge}).
 */
export function buildTreeLines(
	plan: Plan,
	theme: Theme,
	innerWidth: number,
	driverBadges?: ReadonlyMap<string, PhaseDriverBadge>,
	expandedPhaseIds?: ReadonlySet<string>,
	selectedIndex?: number,
): string[] {
	const lines: string[] = [];
	plan.phases.forEach((phase, idx) => {
		const glyph = STATUS_GLYPH[phase.status] ?? "○";
		const badge = renderDriverBadge(theme, driverBadges?.get(phase.id));
		const badgeW = badge ? visibleWidth(badge.plain) : 0;
		const tally = phaseTally(phase);
		const selected = selectedIndex === idx;
		const cursor = selected ? theme.fg("accent", "▌") : " ";
		const prefix = `${cursor}${glyph} `;
		const prefixW = 1 + visibleWidth(glyph) + 1;
		// Reserve a 1-col gutter on the right so the tally isn't glued to the border.
		const titleMax = Math.max(
			1,
			innerWidth - prefixW - tally.length - 2 - badgeW,
		);
		const title = truncateToWidth(phase.title, titleMax);
		const titleStyled = selected ? theme.fg("accent", title) : title;
		const pad = " ".repeat(
			Math.max(
				1,
				innerWidth - prefixW - visibleWidth(title) - badgeW - tally.length - 1,
			),
		);
		lines.push(
			`${prefix}${titleStyled}${badge?.styled ?? ""}${pad}${theme.fg("muted", tally)}`,
		);

		if (!isPhaseExpanded(phase, expandedPhaseIds)) return;

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
	});
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

/** Optional content embedded into the box's bottom border edge. */
export interface PlanPanelRenderState {
	theme: Theme;
	width: number;
	focused: boolean;
	scrollOffset: number;
	/** Terminal height in rows, used to size the scroll viewport. */
	termHeight: number;
	/** Phase ids explicitly expanded from the focused panel. */
	expandedPhaseIds?: ReadonlySet<string>;
	/** Index of the cursor phase; only honoured (rendered) when `focused`. */
	selectedIndex?: number;
	/** Per-phase concurrent-driver badges, keyed by phase id. */
	driverBadges?: ReadonlyMap<string, PhaseDriverBadge>;
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
 * Whether the selected phase can be attached to: it's driven by a concurrent
 * session and has a recorded session file to switch into.
 */
export function isPhaseAttachable(
	plan: Plan,
	selectedIndex: number | undefined,
	driverBadges: ReadonlyMap<string, PhaseDriverBadge> | undefined,
): boolean {
	if (selectedIndex === undefined) return false;
	const phase = plan.phases[selectedIndex];
	if (!phase?.sessionPath) return false;
	const badge = driverBadges?.get(phase.id);
	return badge === "peer-live" || badge === "peer-stale";
}

/** Focused footer hint, attach-aware when the cursor sits on a peer phase. */
function focusedHint(
	plan: Plan,
	selectedIndex: number | undefined,
	driverBadges: ReadonlyMap<string, PhaseDriverBadge> | undefined,
): string {
	return isPhaseAttachable(plan, selectedIndex, driverBadges)
		? "↑↓ move · ⏎ attach agent · Esc close"
		: "↑↓ move · → expand · Esc close";
}

/** Inputs for the pure body builder shared by the panel and the sidebar box. */
export interface PlanBodyArgs {
	theme: Theme;
	/** Inner width available for tree lines (border already accounted for). */
	contentWidth: number;
	/** Height budget for the scroll window (rows between borders). */
	maxBodyRows: number;
	focused: boolean;
	scrollOffset: number;
	expandedPhaseIds?: ReadonlySet<string>;
	selectedIndex?: number;
	driverBadges?: ReadonlyMap<string, PhaseDriverBadge>;
}

export interface PlanBodyResult {
	/** Windowed tree rows (no border). */
	rows: string[];
	/** Scroll indicator + key hint for the box's bottom edge. */
	footer: BoxFooter;
	scrollOffset: number;
	maxScroll: number;
	pageRows: number;
}

/**
 * Build the windowed tree rows plus a {@link BoxFooter}, *without* drawing a
 * border. Shared by {@link renderPlanPanel} (which wraps it in a titleless box)
 * and the sidebar Plan box (which wraps it in a titled box), so both surfaces
 * show an identical tree with the same scroll/hint affordances.
 */
export function planPanelBody(plan: Plan, args: PlanBodyArgs): PlanBodyResult {
	const full = buildTreeLines(
		plan,
		args.theme,
		args.contentWidth,
		args.driverBadges,
		args.expandedPhaseIds,
		args.focused ? args.selectedIndex : undefined,
	);
	const win = windowLines(
		full,
		args.scrollOffset,
		Math.max(1, args.maxBodyRows),
	);
	const hint = args.focused
		? focusedHint(plan, args.selectedIndex, args.driverBadges)
		: "^⇧P to open";
	const scroll =
		win.maxScroll > 0
			? `↑${win.clampedOffset} ↓${win.maxScroll - win.clampedOffset}`
			: undefined;
	return {
		rows: win.rows,
		footer: { scroll, hint },
		scrollOffset: win.clampedOffset,
		maxScroll: win.maxScroll,
		pageRows: win.rows.length,
	};
}

/**
 * Pure panel render. Always renders the full phase list (active phase expanded)
 * with a title-less border. Returns the clamped scroll state so the component
 * (and tests) can stay in sync without side effects here. A key hint is always
 * embedded into the bottom border edge (`^⇧P to open` when passive, navigation
 * keys when focused), so the focus toggle is discoverable without a body row.
 */
export function renderPlanPanel(
	plan: Plan,
	state: PlanPanelRenderState,
): PlanPanelRenderResult {
	const innerW = Math.max(1, state.width - 2);
	// Use nearly the whole viewport (minus a top margin) so the always-on panel
	// can show as much of the plan as fits. The hint lives on the bottom border
	// edge, so the body claims the full height between the two borders.
	const maxPanelRows = Math.max(MIN_PANEL_ROWS, state.termHeight - 2);
	const body = planPanelBody(plan, {
		theme: state.theme,
		contentWidth: innerW,
		maxBodyRows: Math.max(1, maxPanelRows - 2),
		focused: state.focused,
		scrollOffset: state.scrollOffset,
		expandedPhaseIds: state.expandedPhaseIds,
		selectedIndex: state.selectedIndex,
		driverBadges: state.driverBadges,
	});
	return {
		lines: boxify(state.theme, "", body.rows, state.width, body.footer),
		scrollOffset: body.scrollOffset,
		maxScroll: body.maxScroll,
		pageRows: body.pageRows,
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
	private readonly requestRender: () => void;
	private readonly onRequestUnfocus: () => void;
	private readonly onAttachPhase: ((phaseId: string) => void) | null;

	/** Passive by default; the focus shortcut routes input here. */
	focused = false;
	scrollOffset = 0;
	/** Cursor over `plan.phases` while focused. */
	selectedIndex = 0;
	/** Phases the user explicitly expanded (beyond the auto-expanded active one). */
	private readonly expandedPhaseIds = new Set<string>();
	/** Per-phase driver badges, supplied by the host (it owns fs liveness). */
	private driverBadges: ReadonlyMap<string, PhaseDriverBadge> = new Map();
	private termHeight = 24;
	private maxScroll = 0;
	private pageRows = 5;

	constructor(args: {
		plan: Plan | null;
		theme: Theme;
		requestRender: () => void;
		onRequestUnfocus: () => void;
		onAttachPhase?: (phaseId: string) => void;
	}) {
		this.plan = args.plan;
		this.theme = args.theme;
		this.requestRender = args.requestRender;
		this.onRequestUnfocus = args.onRequestUnfocus;
		this.onAttachPhase = args.onAttachPhase ?? null;
	}

	setPlan(plan: Plan | null): void {
		// Swapping to a *different* plan (e.g. the host reused this overlay for
		// another slug) must not carry over per-phase expand state: phase ids are
		// only unique within a plan, so stale ids could wrongly expand a
		// same-named phase. Reset the cursor too.
		if (plan?.slug !== this.plan?.slug) {
			this.expandedPhaseIds.clear();
			this.selectedIndex = 0;
		}
		this.plan = plan;
		const max = Math.max(0, (plan?.phases.length ?? 1) - 1);
		if (this.selectedIndex > max) this.selectedIndex = max;
		this.requestRender();
	}

	/** Replace the per-phase driver badges (host recomputes on plan reload). */
	setDriverBadges(badges: ReadonlyMap<string, PhaseDriverBadge>): void {
		this.driverBadges = badges;
		this.requestRender();
	}

	setViewportHeight(rows: number): void {
		this.termHeight = rows;
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		if (focused) {
			this.selectActivePhase();
			this.ensureSelectedVisible();
		} else {
			this.scrollOffset = 0;
		}
		this.requestRender();
	}

	/** Move the cursor onto the active phase (or the first phase) on focus. */
	private selectActivePhase(): void {
		if (!this.plan) return;
		const idx = this.plan.phases.findIndex((p) =>
			WORKTREE_STATUSES.includes(p.status),
		);
		this.selectedIndex = idx === -1 ? 0 : idx;
	}

	render(width: number): string[] {
		if (!this.plan || this.plan.phases.length === 0) return [];
		const result = renderPlanPanel(this.plan, {
			theme: this.theme,
			width,
			focused: this.focused,
			scrollOffset: this.scrollOffset,
			termHeight: this.termHeight,
			expandedPhaseIds: this.expandedPhaseIds,
			selectedIndex: this.selectedIndex,
			driverBadges: this.driverBadges,
		});
		this.scrollOffset = result.scrollOffset;
		this.maxScroll = result.maxScroll;
		this.pageRows = Math.max(1, result.pageRows);
		return result.lines;
	}

	/**
	 * Render just the windowed tree rows + footer (no border) for a host that
	 * draws its own box — e.g. the overlay sidebar's titled Plan box. Shares all
	 * view state (cursor/scroll/expansion) with {@link render}, so focus and
	 * navigation behave identically whichever surface paints the tree.
	 */
	renderBody(
		contentWidth: number,
		maxBodyRows: number,
	): { rows: string[]; footer: BoxFooter } {
		if (!this.plan || this.plan.phases.length === 0) {
			return { rows: [], footer: {} };
		}
		const body = planPanelBody(this.plan, {
			theme: this.theme,
			contentWidth: Math.max(1, contentWidth),
			maxBodyRows: Math.max(1, maxBodyRows),
			focused: this.focused,
			scrollOffset: this.scrollOffset,
			expandedPhaseIds: this.expandedPhaseIds,
			selectedIndex: this.selectedIndex,
			driverBadges: this.driverBadges,
		});
		this.scrollOffset = body.scrollOffset;
		this.maxScroll = body.maxScroll;
		this.pageRows = Math.max(1, body.pageRows);
		return { rows: body.rows, footer: body.footer };
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.onRequestUnfocus();
			return;
		}
		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, "down")) {
			this.moveSelection(1);
		} else if (matchesKey(data, "return")) {
			// ⏎ attaches to a peer-driven phase; otherwise it expands like →.
			if (!this.attachSelected()) this.toggleSelectedExpand();
		} else if (matchesKey(data, "right") || matchesKey(data, "space")) {
			this.toggleSelectedExpand();
		} else if (matchesKey(data, "left")) {
			this.collapseSelected();
		} else if (matchesKey(data, "pageUp")) {
			this.scrollBy(-this.pageRows);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollBy(this.pageRows);
		}
	}

	/**
	 * If the cursor sits on an attachable peer phase, hand it to the host's
	 * attach callback and report true. Otherwise a no-op returning false so the
	 * caller falls back to expand/collapse.
	 */
	private attachSelected(): boolean {
		if (!this.plan || !this.onAttachPhase) return false;
		if (!isPhaseAttachable(this.plan, this.selectedIndex, this.driverBadges)) {
			return false;
		}
		const id = this.selectedPhaseId();
		if (!id) return false;
		this.onAttachPhase(id);
		return true;
	}

	private moveSelection(delta: number): void {
		if (!this.plan) return;
		const last = this.plan.phases.length - 1;
		const next = Math.min(Math.max(0, this.selectedIndex + delta), last);
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.ensureSelectedVisible();
		this.requestRender();
	}

	private selectedPhaseId(): string | null {
		return this.plan?.phases[this.selectedIndex]?.id ?? null;
	}

	private toggleSelectedExpand(): void {
		const id = this.selectedPhaseId();
		if (!id) return;
		if (this.expandedPhaseIds.has(id)) this.expandedPhaseIds.delete(id);
		else this.expandedPhaseIds.add(id);
		this.ensureSelectedVisible();
		this.requestRender();
	}

	private collapseSelected(): void {
		const id = this.selectedPhaseId();
		if (!id || !this.expandedPhaseIds.has(id)) return;
		this.expandedPhaseIds.delete(id);
		this.requestRender();
	}

	/** Adjust the scroll window so the selected phase's header stays visible. */
	private ensureSelectedVisible(): void {
		if (!this.plan) return;
		const offsets = phaseHeaderOffsets(this.plan, this.expandedPhaseIds);
		const target = offsets[this.selectedIndex] ?? 0;
		if (target < this.scrollOffset) {
			this.scrollOffset = target;
		} else if (target > this.scrollOffset + this.pageRows - 1) {
			this.scrollOffset = target - this.pageRows + 1;
		}
		if (this.scrollOffset < 0) this.scrollOffset = 0;
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
