/**
 * Overlay sidebar shell — a non-capturing overlay anchored top-right that
 * stacks three bordered boxes: Info (top), Plan (middle), Notes (bottom). This
 * is the shell only: each box's content is supplied by the host via the setters
 * below and filled in by later phases (env + sub-agents, the plan tree, and the
 * editable notes field). It deliberately paints over the conversation — the
 * show/hide toggle lets the user dismiss it when the full transcript is needed.
 *
 * Boxes are drawn with the shared {@link boxify} renderer so they match the
 * floating plan panel exactly.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { type BoxFooter, boxify } from "./box.js";

export interface SidebarBox {
	title: string;
	/** Pre-styled body lines; rendered as-is (padded/clipped to the box width). */
	body: string[];
	footer?: BoxFooter;
}

/** Identifies which of the three stacked boxes a setter targets. */
export type SidebarSlot = "info" | "plan" | "notes";

const DEFAULT_BOXES: Record<SidebarSlot, SidebarBox> = {
	info: { title: "Info", body: [] },
	plan: { title: "Plan", body: [] },
	notes: { title: "Notes", body: [] },
};

/**
 * The overlay Component. Holds the three boxes' content and renders them
 * top-to-bottom for a given width. Pure render — the host pushes content via
 * {@link setBox} whenever the underlying state changes and calls
 * {@link requestRender} for it.
 */
export class SidebarComponent implements Component {
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly boxes: Record<SidebarSlot, SidebarBox> = {
		info: { ...DEFAULT_BOXES.info, body: [] },
		plan: { ...DEFAULT_BOXES.plan, body: [] },
		notes: { ...DEFAULT_BOXES.notes, body: [] },
	};

	constructor(args: { theme: Theme; requestRender: () => void }) {
		this.theme = args.theme;
		this.requestRender = args.requestRender;
	}

	/** Replace a box's body (and optional footer); triggers a re-render. */
	setBox(slot: SidebarSlot, body: string[], footer?: BoxFooter): void {
		this.boxes[slot].body = body;
		this.boxes[slot].footer = footer;
		this.requestRender();
	}

	render(width: number): string[] {
		const order: SidebarSlot[] = ["info", "plan", "notes"];
		const lines: string[] = [];
		for (const slot of order) {
			const box = this.boxes[slot];
			const body = box.body.length > 0 ? box.body : [placeholder(this.theme)];
			lines.push(...boxify(this.theme, box.title, body, width, box.footer));
		}
		return lines;
	}

	/** Theme/forced refresh hook required by the Component contract. */
	invalidate(): void {
		this.requestRender();
	}
}

/** Dim filler so an unpopulated box still reads as a labelled, sized box. */
function placeholder(theme: Theme): string {
	return ` ${theme.fg("dim", "…")}`;
}
