/**
 * Pure renderers for the sidebar's Info box. The component holds structured
 * data (env + sub-agent rows) and calls these at render time with the box's
 * inner width, so content reflows on resize and the host only has to push fresh
 * data — never re-measure.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

/** Environment facts shown at the top of the Info box. */
export interface SidebarEnv {
	model: string | null;
	context: string | null;
	repo: string | null;
	branch: string | null;
}

const ENV_ROWS: ReadonlyArray<[label: string, key: keyof SidebarEnv]> = [
	["model", "model"],
	["context", "context"],
	["repo", "repo"],
	["branch", "branch"],
];

/** Widest label, so values align in a column. */
const LABEL_WIDTH = Math.max(...ENV_ROWS.map(([label]) => label.length));

/**
 * Render the env facts as ` <label> <value>` rows, label dim and right-padded
 * to a fixed column, value clipped to the remaining width. Null facts are
 * skipped (e.g. no model resolved yet, or a detached HEAD has no branch).
 */
export function renderEnvRows(
	theme: Theme,
	env: SidebarEnv | null,
	innerWidth: number,
): string[] {
	if (!env) return [];
	const out: string[] = [];
	for (const [label, key] of ENV_ROWS) {
		const value = env[key];
		if (!value) continue;
		const labelCell = theme.fg("dim", label.padEnd(LABEL_WIDTH));
		// ` ` + label + ` ` + value — clip the value to whatever's left.
		const room = Math.max(1, innerWidth - 1 - LABEL_WIDTH - 1);
		const val = truncateToWidth(value, room);
		out.push(` ${labelCell} ${val}`);
	}
	return out;
}

/** A dim section divider drawn between env rows and the sub-agent list. */
export function divider(theme: Theme, innerWidth: number): string {
	return theme.fg("border", "─".repeat(Math.max(1, innerWidth)));
}
