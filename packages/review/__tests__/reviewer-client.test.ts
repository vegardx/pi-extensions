/**
 * Tests for runReviewer error handling — specifically the empty-response
 * detection added to catch silent subagent failures.
 */
import { vi } from "vitest";

// Mock the subagent module before importing the module under test.
vi.mock("@vegardx/pi-extensions-shared/parallel-subagent.js", () => ({
	runSubagent: vi.fn(),
}));

import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import { runReviewer } from "../reviewer-client.js";

const mockedRunSubagent = vi.mocked(runSubagent);

const BASE_INPUT = {
	role: "code-reviewer" as const,
	task: "review this diff",
	provider: "anthropic",
	model: "claude-opus-4-5",
	cwd: "/tmp",
};

describe("runReviewer", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("returns error when subagent produces empty text", async () => {
		mockedRunSubagent.mockResolvedValue({
			tag: "code-reviewer",
			rawText: "",
		});

		const result = await runReviewer(BASE_INPUT);
		expect(result.error).toBe("reviewer produced no output (empty response)");
		expect(result.findings).toEqual([]);
	});

	it("returns error when subagent produces whitespace-only text", async () => {
		mockedRunSubagent.mockResolvedValue({
			tag: "code-reviewer",
			rawText: "   \n\t  ",
		});

		const result = await runReviewer(BASE_INPUT);
		expect(result.error).toBe("reviewer produced no output (empty response)");
		expect(result.findings).toEqual([]);
	});

	it("returns error when subagent reports an error", async () => {
		mockedRunSubagent.mockResolvedValue({
			tag: "code-reviewer",
			rawText: "",
			error: "Timeout waiting for agent to become idle. Stderr: 429",
		});

		const result = await runReviewer(BASE_INPUT);
		expect(result.error).toContain("Timeout");
		expect(result.findings).toEqual([]);
	});

	it("returns error when output is not valid JSON", async () => {
		mockedRunSubagent.mockResolvedValue({
			tag: "code-reviewer",
			rawText: "I found no issues in this diff.",
		});

		const result = await runReviewer(BASE_INPUT);
		expect(result.error).toContain("not valid JSON");
		expect(result.findings).toEqual([]);
	});

	it("returns findings on valid JSON array response", async () => {
		const findings = [
			{
				severity: "IMPORTANT",
				file: "src/foo.ts",
				line: 10,
				title: "missing null check",
				description: "could NPE",
				suggestedAction: "add if (!x) return",
			},
		];
		mockedRunSubagent.mockResolvedValue({
			tag: "code-reviewer",
			rawText: JSON.stringify(findings),
		});

		const result = await runReviewer(BASE_INPUT);
		expect(result.error).toBeUndefined();
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].title).toBe("missing null check");
	});

	it("returns empty findings (no error) on valid empty JSON array", async () => {
		mockedRunSubagent.mockResolvedValue({
			tag: "code-reviewer",
			rawText: "[]",
		});

		const result = await runReviewer(BASE_INPUT);
		expect(result.error).toBeUndefined();
		expect(result.findings).toEqual([]);
	});
});
