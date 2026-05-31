/**
 * Overlay sidebar shell — a non-capturing overlay anchored top-right that
 * stacks three bordered boxes: Info (top), Plan (middle), Notes (bottom). The
 * Info box is data-driven: the host pushes structured env facts (and, later,
 * sub-agent rows) via {@link setEnv}/{@link setAgents} and this component
 * formats them for the live width at render time, so content reflows on resize.
 * The Plan and Notes boxes take pre-rendered body lines via {@link setBody}
 * (filled by later phases). It deliberately paints over the conversation — the
 * show/hide toggle lets the user dismiss it when the full transcript is needed.
 *
 * Boxes are drawn with the shared {@link boxify} renderer so they match the
 * floating plan panel exactly.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { type AgentRow, renderAgentRows } from "./agents.js";
import { type BoxFooter, boxify } from "./box.js";
import { divider, renderEnvRows, type SidebarEnv } from "./info.js";

/** Pre-rendered body slots the host fills directly (Plan, Notes). */
export type SidebarSlot = "plan" | "notes";

/**
 * The overlay Component. Holds the Info box's structured data plus the two
 * pre-rendered body slots, and renders all three boxes top-to-bottom for a
 * given width. Pure render — the host pushes data/content via the setters and
 * each one requests a re-render.
 */
export class SidebarComponent implements Component {
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private env: SidebarEnv | null = null;
	private agents: AgentRow[] = [];
	private readonly bodies: Record<SidebarSlot, string[]> = {
		plan: [],
		notes: [],
	};
	private readonly footers: Partial<Record<SidebarSlot, BoxFooter>> = {};

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

	/** Replace a pre-rendered body slot (Plan/Notes); triggers a re-render. */
	setBody(slot: SidebarSlot, body: string[], footer?: BoxFooter): void {
		this.bodies[slot] = body;
		this.footers[slot] = footer;
		this.requestRender();
	}

	render(width: number): string[] {
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];
		lines.push(...boxify(this.theme, "Info", this.infoBody(innerW), width));
		lines.push(
			...boxify(
				this.theme,
				"Plan",
				this.bodyOr(innerW, "plan"),
				width,
				this.footers.plan,
			),
		);
		lines.push(
			...boxify(
				this.theme,
				"Notes",
				this.bodyOr(innerW, "notes"),
				width,
				this.footers.notes,
			),
		);
		return lines;
	}

	/** Theme/forced refresh hook required by the Component contract. */
	invalidate(): void {
		this.requestRender();
	}

	/** Env facts then, separated by a rule, the live sub-agent rows. */
	private infoBody(innerW: number): string[] {
		const env = renderEnvRows(this.theme, this.env, innerW);
		const agents = renderAgentRows(this.theme, this.agents, innerW);
		if (env.length === 0 && agents.length === 0)
			return [placeholder(this.theme)];
		if (env.length > 0 && agents.length > 0) {
			return [...env, divider(this.theme, innerW), ...agents];
		}
		return env.length > 0 ? env : agents;
	}

	private bodyOr(_innerW: number, slot: SidebarSlot): string[] {
		const body = this.bodies[slot];
		return body.length > 0 ? body : [placeholder(this.theme)];
	}
}

/** Dim filler so an unpopulated box still reads as a labelled, sized box. */
function placeholder(theme: Theme): string {
	return ` ${theme.fg("dim", "…")}`;
}
