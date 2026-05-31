import type { Theme } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { boxify } from "../sidebar/box.js";
import { SidebarComponent } from "../sidebar/shell.js";

// Strip styling so assertions read on plain text + box glyphs.
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** Count how many `╭…╮` top edges a render produced (one per box). */
const topEdges = (lines: string[]) =>
	lines.filter((l) => l.startsWith("╭")).length;

describe("SidebarComponent", () => {
	it("stacks three titled boxes top-to-bottom", () => {
		const c = new SidebarComponent({ theme, requestRender: () => {} });
		const lines = c.render(30);
		expect(topEdges(lines)).toBe(3);
		const joined = lines.join("\n");
		expect(joined).toContain("Info");
		expect(joined).toContain("Plan");
		expect(joined).toContain("Notes");
		// Boxes appear in order info → plan → notes.
		expect(joined.indexOf("Info")).toBeLessThan(joined.indexOf("Plan"));
		expect(joined.indexOf("Plan")).toBeLessThan(joined.indexOf("Notes"));
	});

	it("pads every line to the requested width", () => {
		const c = new SidebarComponent({ theme, requestRender: () => {} });
		const width = 24;
		for (const line of c.render(width)) {
			expect(line.length).toBe(width);
		}
	});

	it("renders supplied body content and re-renders on setBox", () => {
		const requestRender = vi.fn();
		const c = new SidebarComponent({ theme, requestRender });
		c.setBox("info", [" model: claude", " branch: main"]);
		expect(requestRender).toHaveBeenCalledTimes(1);
		const joined = c.render(40).join("\n");
		expect(joined).toContain("model: claude");
		expect(joined).toContain("branch: main");
	});

	it("invalidate triggers a re-render", () => {
		const requestRender = vi.fn();
		const c = new SidebarComponent({ theme, requestRender });
		c.invalidate();
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});

describe("boxify (shared box renderer)", () => {
	it("draws a titled rounded box padded to width", () => {
		const out = boxify(theme, "Info", [" body"], 20);
		expect(out[0]).toContain("Info");
		expect(out[0]).toMatch(/^╭/);
		expect(out.at(-1)).toMatch(/^╰/);
		for (const line of out) expect(line.length).toBe(20);
	});

	it("embeds a hint into the bottom edge without a body row", () => {
		const out = boxify(theme, "", [" body"], 24, { hint: "hi" });
		expect(out.at(-1)).toContain("hi");
		// title + 1 body + bottom edge = 3 lines (hint costs no extra row).
		expect(out.length).toBe(3);
	});
});
