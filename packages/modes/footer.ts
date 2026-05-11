import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

/**
 * One styled-vs-visible pair for a right-side footer segment. `visible` is
 * the unstyled text used for width math; `styled` is the ANSI-coded form
 * actually emitted to the terminal. Both must represent the same content
 * so width math stays accurate.
 */
export interface FooterRightCandidate {
	visible: string;
	styled: string;
}

/**
 * Compose a single-line `left ⟨gap⟩ right` footer that never exceeds
 * `width`. Right-side candidates are tried in order from richest to
 * sparsest; the first one that fits with at least one column for the gap
 * is chosen. If even the sparsest doesn't fit, the line is truncated to
 * width as a final safety so pi-tui's strict width assertion never fires.
 *
 * Why: the previous renderer assumed the right-side label always fit and
 * appended it verbatim. When the usage/model label was wider than the
 * terminal (long model names, narrow / resized terminals), the returned
 * line exceeded `width` and crashed the process at `tui.js:974`.
 */
export function composeFooterLine(
	leftText: string,
	rightCandidates: FooterRightCandidate[],
	width: number,
): string {
	if (width <= 0) return "";

	// Empty sentinel guarantees at least one fitting candidate exists, so we
	// don't have to special-case "nothing fits" below.
	const candidates: FooterRightCandidate[] = [
		...rightCandidates,
		{ visible: "", styled: "" },
	];

	let chosen = candidates[candidates.length - 1] as FooterRightCandidate;
	for (const cand of candidates) {
		const cw = visibleWidth(cand.visible);
		// Reserve 1 column for the gap. The empty sentinel (cw=0) always
		// passes for any real width.
		if (cw === 0 || cw + 1 <= width) {
			chosen = cand;
			break;
		}
	}

	const rightWidth = visibleWidth(chosen.visible);
	const safeLeft = truncateToWidth(
		leftText,
		Math.max(0, width - rightWidth - (rightWidth === 0 ? 0 : 1)),
	);
	const leftWidth = visibleWidth(safeLeft);
	const gap =
		rightWidth === 0 ? 0 : Math.max(1, width - leftWidth - rightWidth);

	const line = safeLeft + " ".repeat(gap) + chosen.styled;
	return truncateToWidth(line, width);
}
