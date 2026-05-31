/**
 * Pure renderer for the Info box's live sub-agent list. The host aggregates
 * explore tasks, research runs, fleet workers, and peer phase drivers into a
 * flat {@link AgentRow}[] and pushes it to the sidebar; this formats each as a
 * status-coloured ` <glyph> <label> — <detail>` line, clipped to the box width.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type AgentKind = "explore" | "research" | "fleet" | "peer";

export type AgentStatus =
	| "queued"
	| "running"
	| "done"
	| "error"
	| "timeout"
	| "live"
	| "stale";

export interface AgentRow {
	kind: AgentKind;
	/** Short identifier/title (e.g. explore id, chain id, phase title). */
	label: string;
	status: AgentStatus;
	/** Last activity / tool summary; shown after an em dash when it fits. */
	detail?: string;
}

const KIND_GLYPH: Record<AgentKind, string> = {
	explore: "🔍",
	research: "🌐",
	fleet: "🛠",
	peer: "👥",
};

const STATUS_GLYPH: Record<AgentStatus, string> = {
	queued: "⌛",
	running: "⏳",
	done: "🟢",
	error: "❌",
	timeout: "⏱",
	live: "🟢",
	stale: "🟡",
};

const STATUS_COLOR: Record<AgentStatus, ThemeColor> = {
	queued: "muted",
	running: "accent",
	done: "success",
	error: "error",
	timeout: "warning",
	live: "success",
	stale: "warning",
};

/**
 * Render one line per agent row, clipped to `innerWidth`. Returns `[]` when
 * there are no rows so the caller can decide whether to show a divider/header.
 */
export function renderAgentRows(
	theme: Theme,
	rows: ReadonlyArray<AgentRow>,
	innerWidth: number,
): string[] {
	const out: string[] = [];
	for (const row of rows) {
		const glyph = `${KIND_GLYPH[row.kind]}${STATUS_GLYPH[row.status]}`;
		const head = ` ${glyph} `;
		const room = Math.max(1, innerWidth - visibleWidth(head));
		const label = theme.fg(STATUS_COLOR[row.status], row.label);
		let text = label;
		if (row.detail) {
			// Append the detail only if the label plus a separator leaves room.
			const sep = " — ";
			const used = visibleWidth(row.label) + sep.length;
			if (used + 1 < room) {
				const detail = truncateToWidth(row.detail, room - used);
				text = `${label}${theme.fg("dim", sep)}${theme.fg("muted", detail)}`;
			}
		}
		out.push(head + truncateToWidth(text, room));
	}
	return out;
}
