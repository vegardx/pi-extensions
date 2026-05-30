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

	it("forwards per-call timeoutMs to runSubagent and combines caller signal", async () => {
		const ac = new AbortController();
		const agents = new DelegateAgents(MOCK_CTX);
		await agents.research("q", { timeoutMs: 12345, signal: ac.signal });
		// timeoutMs is forwarded as-is for waitForIdle
		expect(runSubagent).toHaveBeenCalledWith(
			expect.objectContaining({ timeoutMs: 12345 }),
		);
		// The signal passed to runSubagent must be a COMBINED signal that
		// respects the caller's abort: aborting ac should abort the combined
		// signal too.
		const passedSignal: AbortSignal = (runSubagent as ReturnType<typeof vi.fn>)
			.mock.calls[0][0].signal;
		expect(passedSignal).not.toBe(ac.signal); // combined, not original
		expect(passedSignal.aborted).toBe(false);
		ac.abort();
		expect(passedSignal.aborted).toBe(true);
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

describe("DelegateAgents.cappedResearch", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(resolveModel).mockResolvedValue(RESOLVED_MODEL as never);
	});

	it("caps concurrent research subprocesses at maxConcurrent", async () => {
		let active = 0;
		let maxActive = 0;
		const gates: Array<() => void> = [];
		vi.mocked(runSubagent).mockImplementation(async (input) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((r) => gates.push(r));
			active--;
			return { tag: input.tag, rawText: "ok" } as never;
		});

		const agents = new DelegateAgents(MOCK_CTX);
		const calls = [0, 1, 2, 3].map(() =>
			agents.cappedResearch("q", { maxConcurrent: 2 }),
		);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		// Only 2 of the 4 started; the other 2 are blocked in the gate.
		expect(maxActive).toBe(2);
		expect(runSubagent).toHaveBeenCalledTimes(2);

		// Drain: release running gates, let queued calls take freed slots.
		for (let i = 0; i < 8 && gates.length > 0; i++) {
			gates.shift()?.();
			await new Promise((r) => setImmediate(r));
		}
		await Promise.all(calls);
		expect(maxActive).toBe(2); // never exceeded the cap
		expect(runSubagent).toHaveBeenCalledTimes(4);
	});

	it("runs all in parallel when uncapped", async () => {
		let active = 0;
		let maxActive = 0;
		const gates: Array<() => void> = [];
		vi.mocked(runSubagent).mockImplementation(async (input) => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((r) => gates.push(r));
			active--;
			return { tag: input.tag, rawText: "ok" } as never;
		});
		const agents = new DelegateAgents(MOCK_CTX);
		const calls = [0, 1, 2, 3].map(() => agents.cappedResearch("q"));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(maxActive).toBe(4);
		for (const g of gates.splice(0)) g();
		await Promise.all(calls);
	});

	it("aborts a queued call promptly when its signal fires", async () => {
		const gates: Array<() => void> = [];
		vi.mocked(runSubagent).mockImplementation(async (input) => {
			await new Promise<void>((r) => gates.push(r));
			return { tag: input.tag, rawText: "ok" } as never;
		});
		const agents = new DelegateAgents(MOCK_CTX);
		// Fill both slots with blocked runs.
		const a = agents.cappedResearch("q1", { maxConcurrent: 2 });
		const b = agents.cappedResearch("q2", { maxConcurrent: 2 });
		await new Promise((r) => setImmediate(r));
		expect(runSubagent).toHaveBeenCalledTimes(2);
		// Third call queues; aborting its signal must return promptly
		// without ever starting a subprocess.
		const ac = new AbortController();
		const queued = agents.cappedResearch("q3", {
			maxConcurrent: 2,
			signal: ac.signal,
		});
		ac.abort();
		const outcome = await queued;
		expect(outcome).toMatchObject({ ok: false, reason: "subagent-error" });
		expect((outcome as { detail: string }).detail).toMatch(
			/aborted while queued/,
		);
		expect(runSubagent).toHaveBeenCalledTimes(2); // q3 never ran
		for (const g of gates.splice(0)) g();
		await Promise.all([a, b]);
	});
});

describe("DelegateAgents.researchAsk / researchCheck / researchWait (#159a)", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(resolveModel).mockResolvedValue(RESOLVED_MODEL as never);
		vi.mocked(runSubagent).mockResolvedValue({
			tag: 0,
			rawText: "mock research answer",
			error: null,
			elapsedMs: 25,
		} as never);
	});

	it("researchAsk returns immediately with a task id", async () => {
		// Make `runSubagent` block on a never-resolving promise so we can
		// prove `researchAsk` returns *before* the underlying subprocess
		// completes — this is the actual non-blocking contract. Wall-clock
		// thresholds are flaky on CI; an ordering-based assertion isn't.
		let subagentResolve:
			| ((value: { rawText: string; error: null; elapsedMs: number }) => void)
			| null = null;
		vi.mocked(runSubagent).mockImplementationOnce(
			() =>
				new Promise<{
					rawText: string;
					error: null;
					elapsedMs: number;
				}>((res) => {
					subagentResolve = res;
				}) as never,
		);
		const agents = new DelegateAgents(MOCK_CTX);
		const { id } = await agents.researchAsk("what is X?");
		expect(id).toMatch(/^r\d+$/);
		// At this point the underlying promise hasn't resolved yet — the
		// fact that we got `{ id }` proves enqueue is non-blocking.
		expect(subagentResolve).not.toBeNull();
		// Clean up the dangling subagent so vitest doesn't complain about
		// hanging promises across tests.
		(
			subagentResolve as unknown as (value: {
				rawText: string;
				error: null;
				elapsedMs: number;
			}) => void
		)({
			rawText: "answer",
			error: null,
			elapsedMs: 5,
		});
	});

	it("two concurrent researchAsk calls get distinct ids and run in parallel", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		const [{ id: a }, { id: b }] = await Promise.all([
			agents.researchAsk("q1"),
			agents.researchAsk("q2"),
		]);
		expect(a).not.toBe(b);
		// Both subprocess invocations fired in parallel, not serial.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		expect(runSubagent).toHaveBeenCalledTimes(2);
	});

	it("researchCheck drains terminal tasks with the structured outcome attached", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		const { id } = await agents.researchAsk("what is X?");
		// Wait for the dispatcher to resolve.
		const result = await agents.researchWait(id, 5_000);
		expect(result.status).toBe("done");
		expect(result.text).toBe("mock research answer");
		expect(result.outcome).toMatchObject({
			ok: true,
			text: "mock research answer",
		});

		// First check returns the terminal task; subsequent check is empty
		// (drain semantics).
		const firstDrain = agents.researchCheck();
		expect(firstDrain.tasks).toHaveLength(1);
		const secondDrain = agents.researchCheck();
		expect(secondDrain.tasks).toHaveLength(0);
	});

	it("researchCheck on empty mailbox returns empty without spawning", () => {
		const agents = new DelegateAgents(MOCK_CTX);
		const result = agents.researchCheck();
		expect(result.tasks).toHaveLength(0);
		expect(result.notifications).toHaveLength(0);
	});

	it("researchWait timeout returns synthetic terminal record without cancelling subprocess", async () => {
		// Stall the subagent so the wait can hit its timeout.
		vi.mocked(runSubagent).mockImplementationOnce(
			() => new Promise(() => {}) as never,
		);
		const agents = new DelegateAgents(MOCK_CTX);
		const { id } = await agents.researchAsk("slow");
		const out = await agents.researchWait(id, 25);
		expect(out.status).toBe("timeout");
		expect(out.error).toMatch(/timed out/);
	});

	it("a no-model failure surfaces as outcome.ok=false on the task", async () => {
		vi.mocked(resolveModel).mockResolvedValueOnce(null);
		const agents = new DelegateAgents(MOCK_CTX);
		const { id } = await agents.researchAsk("q");
		const result = await agents.researchWait(id, 5_000);
		expect(result.status).toBe("done");
		expect(result.outcome).toMatchObject({ ok: false, reason: "no-model" });
		expect(result.text).toContain("[research no-model]");
	});

	it("dispose tears down the research mailbox", async () => {
		const agents = new DelegateAgents(MOCK_CTX);
		await agents.researchAsk("q");
		await expect(agents.dispose()).resolves.toBeUndefined();
		// After dispose, a fresh ask spins up a new mailbox cleanly.
		const { id } = await agents.researchAsk("second");
		expect(id).toMatch(/^r\d+$/);
	});
});
