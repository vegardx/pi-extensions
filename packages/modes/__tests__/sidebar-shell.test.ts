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

	it("renders env facts and re-renders on setEnv", () => {
		const requestRender = vi.fn();
		const c = new SidebarComponent({ theme, requestRender });
		c.setEnv({
			model: "Sonnet 4.5",
			context: "12k/200k",
			repo: "~/src/app",
			branch: "feat/x",
		});
		expect(requestRender).toHaveBeenCalledTimes(1);
		const joined = c.render(40).join("\n");
		expect(joined).toContain("Sonnet 4.5");
		expect(joined).toContain("feat/x");
		expect(joined).toContain("~/src/app");
	});

	it("renders sub-agent rows under the env facts", () => {
		const c = new SidebarComponent({ theme, requestRender: () => {} });
		c.setEnv({ model: "m", context: null, repo: null, branch: "main" });
		c.setAgents([
			{ kind: "explore", label: "e1", status: "running", detail: "grep foo" },
			{ kind: "fleet", label: "abc12345", status: "queued" },
		]);
		const joined = c.render(48).join("\n");
		expect(joined).toContain("e1");
		expect(joined).toContain("abc12345");
	});

	it("renders the plan view body in the Plan box, notes via setBody", () => {
		const c = new SidebarComponent({ theme, requestRender: () => {} });
		const planView = {
			renderBody: () => ({ rows: [" phase 1"], footer: {} }),
		} as unknown as Parameters<SidebarComponent["setPlanView"]>[0];
		c.setPlanView(planView);
		c.setBody("notes", [" remember this"]);
		const joined = c.render(40).join("\n");
		expect(joined).toContain("phase 1");
		expect(joined).toContain("remember this");
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
