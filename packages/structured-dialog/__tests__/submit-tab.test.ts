/**
 * Unit tests for renderSubmitAffordance (#155).
 *
 * Uses a passthrough theme (no ANSI codes) so assertions are on plain text
 * and snapshot output is human-readable.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { renderSubmitAffordance } from "../dialog.js";

// Passthrough theme: strips all styling so output is plain text.
const plain = {
	fg: (_c: string, text: string) => text,
	bg: (_c: string, text: string) => text,
	bold: (t: string) => t,
	italic: (t: string) => t,
	underline: (t: string) => t,
	inverse: (t: string) => t,
	strikethrough: (t: string) => t,
} as unknown as Theme;

describe("renderSubmitAffordance", () => {
	it("ready — renders box-bordered Submit button", () => {
		const lines = renderSubmitAffordance(true, [], plain);
		expect(lines).toMatchSnapshot();
	});

	it("ready — top and bottom borders match label width", () => {
		const lines = renderSubmitAffordance(true, [], plain);
		// All three lines must have the same visible length.
		// Strip leading whitespace for comparison.
		const [top, mid, bot] = lines.map((l) => l.trimStart());
		expect(top.length).toBe(bot.length);
		// Middle line is │ + label + │ — same outer width as top/bottom.
		expect(mid.length).toBe(top.length);
	});

	it("ready — button contains ↵ and Submit", () => {
		const lines = renderSubmitAffordance(true, [], plain);
		const content = lines.join("\n");
		expect(content).toContain("↵");
		expect(content).toContain("Submit");
	});

	it("warning — renders ⚠ Required with missing labels", () => {
		const lines = renderSubmitAffordance(false, ["Name", "Email"], plain);
		expect(lines).toMatchSnapshot();
	});

	it("warning — includes each missing label", () => {
		const lines = renderSubmitAffordance(false, ["Name", "Email"], plain);
		const content = lines.join("\n");
		expect(content).toContain("Name");
		expect(content).toContain("Email");
		expect(content).toContain("⚠");
	});

	it("warning — single missing label has no trailing comma", () => {
		const lines = renderSubmitAffordance(false, ["Role"], plain);
		const content = lines.join("\n");
		expect(content).not.toContain(",");
	});
});
