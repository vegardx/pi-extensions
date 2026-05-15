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
import {
	DEFAULT_RESEARCH_TIMEOUT_MS,
	DelegateAgents,
} from "../plan/delegate-tools.js";

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
		const outcome = await agents.research("how does zod v4 work?");

		expect(runSubagent).toHaveBeenCalledOnce();
		expect(runSubagent).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "anthropic",
				model: "claude-haiku",
				tools: ["websearch", "webfetch"],
				cwd: "/fake/repo",
				systemPromptPath: expect.stringContaining("research-agent.md"),
				task: "how does zod v4 work?",
				timeoutMs: DEFAULT_RESEARCH_TIMEOUT_MS,
			}),
		);
		expect(outcome).toEqual(
			expect.objectContaining({ ok: true, text: "mock answer" }),
		);
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

		expect(r1).toMatchObject({ ok: true, text: "first" });
		expect(r2).toMatchObject({ ok: true, text: "second" });
		expect(runSubagent).toHaveBeenCalledTimes(2);
	});

	it("reports subagent errors as structured outcome", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({
			tag: 0,
			rawText: "",
			error: "network error",
		});
		const agents = new DelegateAgents(MOCK_CTX);
		const outcome = await agents.research("q");
		expect(outcome).toMatchObject({
			ok: false,
			reason: "subagent-error",
			detail: "network error",
		});
	});

	it("classifies elapsed >= timeoutMs errors as timeout", async () => {
		// Stall the subagent past the per-call deadline, then resolve
		// with a runSubagent-style error mirroring what `waitForIdle`
		// rejects with on timeout.
		vi.mocked(runSubagent).mockImplementationOnce(async (input) => {
			await new Promise((r) => setTimeout(r, (input.timeoutMs ?? 60000) + 5));
			return {
				tag: input.tag,
				rawText: "",
				error: "Timeout waiting for agent to become idle.",
			};
		});

		const agents = new DelegateAgents(MOCK_CTX);
		const outcome = await agents.research("q", { timeoutMs: 20 });
		expect(outcome).toMatchObject({
			ok: false,
			reason: "timeout",
			timeoutMs: 20,
		});
		expect((outcome as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(
			20,
		);
	});

	it("returns no-model outcome when no fast-tier model is configured", async () => {
		vi.mocked(resolveModel).mockResolvedValue(null);
		const agents = new DelegateAgents(MOCK_CTX);
		const outcome = await agents.research("q");

		expect(outcome).toMatchObject({ ok: false, reason: "no-model" });
		expect(runSubagent).not.toHaveBeenCalled();
	});

	it("returns empty outcome when subagent produces no text", async () => {
		vi.mocked(runSubagent).mockResolvedValueOnce({
			tag: 0,
			rawText: "",
		});
		const agents = new DelegateAgents(MOCK_CTX);
		const outcome = await agents.research("q");
		expect(outcome).toMatchObject({ ok: false, reason: "empty" });
	});

	it("forwards per-call timeoutMs and signal to runSubagent", async () => {
		const ac = new AbortController();
		const agents = new DelegateAgents(MOCK_CTX);
		await agents.research("q", { timeoutMs: 12345, signal: ac.signal });
		expect(runSubagent).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 12345, signal: ac.signal }),
		);
	});

	it("dispose() is a no-op for research-only DelegateAgents", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		await agents.research("first");
		await expect(agents.dispose()).resolves.toBeUndefined();

		const outcome = await agents.research("after dispose");
		expect(outcome).toMatchObject({ ok: true, text: "mock answer" });
		expect(runSubagent).toHaveBeenCalledTimes(2);
	});
});
