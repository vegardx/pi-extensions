/**
 * Shared rounded-border box renderer. Extracted from the plan panel so both the
 * floating plan panel and the overlay sidebar draw identical boxes: a `╭─╮`
 * title edge (centred title, or a clean rule when titleless) and a `╰─╯` bottom
 * edge that can embed a left-aligned scroll indicator and a right-aligned key
 * hint without spending a body row.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export interface BoxFooter {
	/** Left-aligned scroll indicator (e.g. `↑2 ↓5`); shown only when overflowing. */
	scroll?: string;
	/** Right-aligned key hint (e.g. `^⇧O to focus`). */
	hint?: string;
}

/**
 * Draw a rounded border around body lines. With a non-empty `title`, it's
 * centered on the top edge; with an empty title the top edge is a clean run of
 * `─` (the panel deliberately carries no title). An optional `footer` embeds a
 * scroll indicator (left) and a key hint (right) into the bottom edge — the
 * same trick the title uses on the top edge — so hints cost no body row.
 */
export function boxify(
	theme: Theme,
	title: string,
	body: string[],
	width: number,
	footer?: BoxFooter,
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

	result.push(bottomEdge(theme, innerW, footer));
	return result;
}

/**
 * Build the bottom border line, embedding an optional left-aligned scroll
 * indicator and right-aligned hint between runs of `─`. Layout:
 * `╰─ <scroll> ──…── <hint> ─╯`. The hint is truncated before the scroll
 * indicator so the line never exceeds `innerW`.
 */
function bottomEdge(theme: Theme, innerW: number, footer?: BoxFooter): string {
	const plainBorder = (n: number) =>
		theme.fg("border", "─".repeat(Math.max(0, n)));
	if (!footer || (!footer.scroll && !footer.hint)) {
		return theme.fg("border", `╰${"─".repeat(innerW)}╯`);
	}

	const lead = 1;
	const trail = 1;
	// The hint (how to get in/out) takes priority over the scroll indicator: size
	// it against the full edge first, then show the scroll indicator only if the
	// leftover dash run can still spare room for it. On a tight 40-col panel the
	// exit hint stays intact and the scroll indicator yields.
	const hintBudget = innerW - lead - trail - 1 - 2;
	const rawHint = footer.hint ?? "";
	const hint =
		hintBudget < visibleWidth(rawHint)
			? truncateToWidth(rawHint, Math.max(0, hintBudget))
			: rawHint;
	const hintSeg = hint ? ` ${hint} ` : "";
	const hintW = visibleWidth(hintSeg);

	const rawScrollSeg = footer.scroll ? ` ${footer.scroll} ` : "";
	const rawScrollW = visibleWidth(rawScrollSeg);
	const fitsScroll = innerW - lead - trail - hintW - rawScrollW >= 1;
	const scrollSeg = fitsScroll ? rawScrollSeg : "";
	const scrollW = visibleWidth(scrollSeg);
	const mid = Math.max(1, innerW - lead - trail - scrollW - hintW);

	return (
		theme.fg("border", "╰") +
		plainBorder(lead) +
		(scrollSeg ? theme.fg("dim", scrollSeg) : "") +
		plainBorder(mid) +
		(hintSeg ? theme.fg("dim", hintSeg) : "") +
		plainBorder(trail) +
		theme.fg("border", "╯")
	);
}

/** Pad (or truncate) a possibly-styled line to exactly `width` cells. */
export function padTo(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w > width) return truncateToWidth(line, width);
	return line + " ".repeat(width - w);
}
