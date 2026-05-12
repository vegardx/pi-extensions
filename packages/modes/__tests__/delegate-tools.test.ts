/**
 * Tests for DelegateAgents.
 *
 * Now narrowed to research only — codebase exploration moved to
 * ExploreMailbox (see explore-mailbox.test.ts).
 */
import { vi } from "vitest";

vi.mock("@vegardx/pi-extensions-shared/model-resolver.js", () => ({
	resolveModel: vi.fn(),
}));

vi.mock("@vegardx/pi-extensions-shared/parallel-subagent.js", () => ({
	runSubagent: vi.fn(),
}));

import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import { DelegateAgents } from "../plan/delegate-tools.js";

const MOCK_CTX = {
	cwd: "/fake/repo",
	hasUI: false,
	model: { provider: "anthropic", id: "claude-haiku" },
} as never;

const RESOLVED_MODEL = {
	model: { provider: "anthropic", id: "claude-haiku" },
};

describe("DelegateAgents.research", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(resolveModel).mockResolvedValue(RESOLVED_MODEL as never);
		vi.mocked(runSubagent).mockResolvedValue({
			tag: 0,
			rawText: "mock answer",
		});
	});

	it("spawns a one-shot subagent with websearch/webfetch tools", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		const result = await agents.research("how does zod v4 work?");

		expect(runSubagent).toHaveBeenCalledOnce();
		expect(runSubagent).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "anthropic",
				model: "claude-haiku",
				tools: ["websearch", "webfetch"],
				cwd: "/fake/repo",
				systemPromptPath: expect.stringContaining("research-agent.md"),
				task: "how does zod v4 work?",
			}),
		);
		expect(result).toBe("mock answer");
	});

	it("each call spawns a fresh one-shot process", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		await agents.research("q1");
		await agents.research("q2");

		expect(runSubagent).toHaveBeenCalledTimes(2);
	});

	it("concurrent calls run in parallel", async () => {
		let resolveFirst!: () => void;
		const firstStarted = new Promise<void>((r) => (resolveFirst = r));

		vi.mocked(runSubagent)
			.mockImplementationOnce(async (input) => {
				resolveFirst();
				await new Promise<void>((r) => setTimeout(r, 10));
				return { tag: input.tag, rawText: "first" };
			})
			.mockImplementationOnce(async (input) => {
				await firstStarted;
				return { tag: input.tag, rawText: "second" };
			});

		const agents = new DelegateAgents(MOCK_CTX);
		const [r1, r2] = await Promise.all([
			agents.research("q1"),
			agents.research("q2"),
		]);

		expect(r1).toBe("first");
		expect(r2).toBe("second");
		expect(runSubagent).toHaveBeenCalledTimes(2);
	});

	it("returns error string when runSubagent reports an error", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({
			tag: 0,
			rawText: "",
			error: "network timeout",
		});
		const agents = new DelegateAgents(MOCK_CTX);
		const result = await agents.research("q");
		expect(result).toBe("[research error: network timeout]");
	});

	it("returns error string when no fast-tier model is configured", async () => {
		vi.mocked(resolveModel).mockResolvedValue(null);
		const agents = new DelegateAgents(MOCK_CTX);
		const result = await agents.research("q");

		expect(result).toMatch(/\[research:.*no fast-tier model/);
		expect(runSubagent).not.toHaveBeenCalled();
	});

	it("dispose() is a no-op for research-only DelegateAgents", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		await agents.research("first");
		await expect(agents.dispose()).resolves.toBeUndefined();

		const result = await agents.research("after dispose");
		expect(result).toBe("mock answer");
		expect(runSubagent).toHaveBeenCalledTimes(2);
	});
});
