/**
 * Overlay sidebar shell — a non-capturing overlay anchored top-right that
 * stacks three bordered boxes: Info (top), Plan (middle), Notes (bottom). The
 * Info box is data-driven: the host pushes structured env facts and sub-agent
 * rows via {@link setEnv}/{@link setAgents} and this component formats them for
 * the live width at render time, so content reflows on resize. The Plan box
 * delegates to a shared {@link PlanPanelComponent} (via {@link setPlanView}) so
 * the tree, scroll, and navigation behave identically to the standalone plan
 * overlay. The Notes box takes pre-rendered body lines via {@link setBody}
 * (filled by a later phase).
 *
 * It deliberately paints over the conversation — the show/hide toggle lets the
 * user dismiss it when the full transcript is needed. Boxes are drawn with the
 * shared {@link boxify} renderer so they match the floating plan panel exactly.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { PlanPanelComponent } from "../plan/panel.js";
import { type AgentRow, renderAgentRows } from "./agents.js";
import { type BoxFooter, boxify } from "./box.js";
import { divider, renderEnvRows, type SidebarEnv } from "./info.js";
import { NOTES_EDIT_HINT, renderNotesBody } from "./notes.js";

/** Minimum rows the Plan box body keeps even when the viewport is tiny. */
const MIN_PLAN_ROWS = 3;
/** Fallback viewport height before the overlay reports its real height. */
const DEFAULT_VIEWPORT_ROWS = 24;

/**
 * The overlay Component. Holds the Info box's structured data, a shared plan
 * view for the Plan box, and the stored Notes text; renders all three boxes
 * top-to-bottom for a given width. The host pushes data/content via the setters
 * and each one requests a re-render.
 */
export class SidebarComponent implements Component {
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private env: SidebarEnv | null = null;
	private agents: AgentRow[] = [];
	private planView: PlanPanelComponent | null = null;
	private notes = "";
	private viewportHeight = DEFAULT_VIEWPORT_ROWS;

	constructor(args: { theme: Theme; requestRender: () => void }) {
		this.theme = args.theme;
		this.requestRender = args.requestRender;
	}

	/** Replace the Info box's environment facts (model/context/repo/branch). */
	setEnv(env: SidebarEnv | null): void {
		this.env = env;
		this.requestRender();
	}

	/** Replace the Info box's live sub-agent rows. */
	setAgents(rows: AgentRow[]): void {
		this.agents = rows;
		this.requestRender();
	}

	/** Attach the shared plan view that renders/navigates the Plan box. */
	setPlanView(panel: PlanPanelComponent | null): void {
		this.planView = panel;
		this.requestRender();
	}

	/** Replace the stored Notes text; wrapped/rendered at draw time. */
	setNotes(text: string): void {
		this.notes = text;
		this.requestRender();
	}

	/** Overlay viewport height in rows, used to budget the Plan box window. */
	setViewportHeight(rows: number): void {
		this.viewportHeight = rows > 0 ? rows : DEFAULT_VIEWPORT_ROWS;
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - 2);
		const info = boxify(this.theme, "Info", this.infoBody(innerW), width);
		const notesFooter: BoxFooter | undefined =
			this.notes.trim() === "" ? undefined : { hint: NOTES_EDIT_HINT };
		const notes = boxify(
			this.theme,
			"Notes",
			renderNotesBody(this.theme, this.notes, innerW),
			width,
			notesFooter,
		);

		// The Plan box claims whatever rows remain after Info and Notes.
		const planBudget = Math.max(
			MIN_PLAN_ROWS,
			this.viewportHeight - info.length - notes.length - 2,
		);
		const plan = this.planBox(width, innerW, planBudget);

		return [...info, ...plan, ...notes];
	}

	/** Theme/forced refresh hook required by the Component contract. */
	invalidate(): void {
		this.requestRender();
	}

	/** Env facts then, separated by a rule, the live sub-agent rows. */
	private infoBody(innerW: number): string[] {
		const env = renderEnvRows(this.theme, this.env, innerW);
		const agents = renderAgentRows(this.theme, this.agents, innerW);
		if (env.length === 0 && agents.length === 0) {
			return [placeholder(this.theme)];
		}
		if (env.length > 0 && agents.length > 0) {
			return [...env, divider(this.theme, innerW), ...agents];
		}
		return env.length > 0 ? env : agents;
	}

	/** Plan tree via the shared view, or a placeholder when there's no plan. */
	private planBox(width: number, innerW: number, maxRows: number): string[] {
		const view = this.planView;
		if (view) {
			const { rows, footer } = view.renderBody(innerW, maxRows);
			if (rows.length > 0) {
				return boxify(this.theme, "Plan", rows, width, footer);
			}
		}
		return boxify(this.theme, "Plan", [placeholder(this.theme)], width);
	}
}

/** Dim filler so an unpopulated box still reads as a labelled, sized box. */
function placeholder(theme: Theme): string {
	return ` ${theme.fg("dim", "…")}`;
}
