import { visibleWidth } from "@mariozechner/pi-tui";
import { composeFooterLine, type FooterRightCandidate } from "../footer.js";

const ANSI_MUTED = "\x1b[38;2;128;128;128m";
const ANSI_RESET = "\x1b[39m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_UNBOLD = "\x1b[22m";

function muted(s: string): string {
	return `${ANSI_MUTED}${s}${ANSI_RESET}`;
}

function bold(s: string): string {
	return `${ANSI_BOLD}${s}${ANSI_UNBOLD}`;
}

describe("composeFooterLine", () => {
	it("fits left + gap + richest right when everything fits", () => {
		const line = composeFooterLine(
			"~/repo (main)",
			[{ visible: "ctx | model | auto", styled: muted("ctx | model | auto") }],
			60,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(line).toContain("~/repo (main)");
		expect(line).toContain("ctx | model | auto");
	});

	it("never returns a line wider than the terminal when right side overflows", () => {
		// Reproduces the user crash: right-side label wider than terminal.
		const longRight =
			"sys 5k · sum 2k · work 58k · 65k/250k · (1000k) | Claude Opus 4.7 (EU) | auto";
		const line = composeFooterLine(
			"~/repo (main)",
			[{ visible: longRight, styled: muted(longRight) }],
			77,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(77);
	});

	it("falls back to a sparser candidate when the richest doesn't fit", () => {
		const usage = "ctx-very-long-label";
		const label = "auto";
		const candidates: FooterRightCandidate[] = [
			{
				visible: `${usage} | ${label}`,
				styled: muted(usage) + " | " + bold(label),
			},
			{ visible: label, styled: bold(label) },
		];
		// Width fits "auto" but not the full usage label.
		const line = composeFooterLine("left", candidates, 12);
		expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		expect(line).toContain("auto");
		expect(line).not.toContain("ctx-very-long-label");
	});

	it("truncates when even the sparsest candidate is wider than width", () => {
		// Every candidate is wider than the available width — line must still
		// fit, even at the cost of cutting the mode label.
		const line = composeFooterLine(
			"left",
			[{ visible: "verylongmode", styled: bold("verylongmode") }],
			4,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(4);
	});

	it("returns empty string at non-positive width", () => {
		expect(composeFooterLine("anything", [], 0)).toBe("");
		expect(composeFooterLine("anything", [], -5)).toBe("");
	});

	it("renders left-only when no right candidates are provided", () => {
		const line = composeFooterLine("~/repo (main)", [], 40);
		expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(line).toContain("~/repo (main)");
	});

	it("preserves at least one column of gap when the right side is non-empty", () => {
		// Left content longer than the budget should be truncated so the
		// chosen right candidate plus a 1-col gap still fits.
		const line = composeFooterLine(
			"a".repeat(200),
			[{ visible: "auto", styled: bold("auto") }],
			20,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
		expect(line).toContain("auto");
	});

	it("survives a resize to a single column without throwing", () => {
		// pi-tui is strict about width 1; we only need to not crash and to
		// stay within the budget.
		expect(() =>
			composeFooterLine("left", [{ visible: "auto", styled: bold("auto") }], 1),
		).not.toThrow();
		const line = composeFooterLine(
			"left",
			[{ visible: "auto", styled: bold("auto") }],
			1,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(1);
	});
});
