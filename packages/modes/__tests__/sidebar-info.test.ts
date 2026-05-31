import type { Theme } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { type AgentRow, renderAgentRows } from "../sidebar/agents.js";
import { renderEnvRows, type SidebarEnv } from "../sidebar/info.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("renderEnvRows", () => {
	it("renders only the facts that are present", () => {
		const env: SidebarEnv = {
			model: "Sonnet 4.5",
			context: null,
			repo: "~/src/app",
			branch: null,
		};
		const rows = renderEnvRows(theme, env, 40);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("model");
		expect(rows[0]).toContain("Sonnet 4.5");
		expect(rows[1]).toContain("repo");
		expect(rows.join("\n")).not.toContain("context");
		expect(rows.join("\n")).not.toContain("branch");
	});

	it("returns nothing for a null env", () => {
		expect(renderEnvRows(theme, null, 40)).toEqual([]);
	});

	it("clips a value to the inner width", () => {
		const env: SidebarEnv = {
			model: "x".repeat(200),
			context: null,
			repo: null,
			branch: null,
		};
		const [row] = renderEnvRows(theme, env, 20);
		expect(row && visibleWidth(row)).toBeLessThanOrEqual(20);
	});
});

describe("renderAgentRows", () => {
	it("renders one line per row with label and detail", () => {
		const rows: AgentRow[] = [
			{ kind: "explore", label: "e1", status: "running", detail: "grep foo" },
			{ kind: "research", label: "auth flows", status: "running" },
		];
		const out = renderAgentRows(theme, rows, 48);
		expect(out).toHaveLength(2);
		expect(out[0]).toContain("e1");
		expect(out[0]).toContain("grep foo");
		expect(out[1]).toContain("auth flows");
	});

	it("returns [] for no rows", () => {
		expect(renderAgentRows(theme, [], 40)).toEqual([]);
	});

	it("clips each line to the inner width", () => {
		const rows: AgentRow[] = [
			{
				kind: "fleet",
				label: "abc12345",
				status: "running",
				detail: "y".repeat(200),
			},
		];
		for (const line of renderAgentRows(theme, rows, 24)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});
});
