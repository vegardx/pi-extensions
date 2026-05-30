import type {
	IdleWaitable,
	SubagentClient,
	SubagentOutcome,
	SubagentTask,
} from "../parallel-subagent.js";
import {
	awaitIdleOrAbort,
	runSubagentWithClient,
} from "../parallel-subagent.js";

// ---- Type-level checks for the public SubagentTask interface ----------
//
// We can't unit-test `runSubagent` end-to-end without spawning a child
// pi process, but we can still pin two layers of the contract:
//
//   1. The public `SubagentTask` interface still carries `timeoutMs`
//      so downstream consumers continue to typecheck. Drift surfaces
//      as `make typecheck` errors at the boundary, not silently at
//      runtime.
//   2. The extracted `awaitIdleOrAbort` helper actually forwards the
//      `timeoutMs` argument to `client.waitForIdle`. A regression
//      that drops or rewrites this argument re-introduces the
//      post-PR-#27 60s timeout cliff on long-running review subagents.
//
// Together the two layers cover the chain `caller → SubagentTask →
// runSubagent → awaitIdleOrAbort → RpcClient.waitForIdle`.

describe("SubagentTask interface", () => {
	it("accepts an optional timeoutMs field (used to scale waitForIdle for long-running subagents)", () => {
		const task: SubagentTask<number> = {
			tag: 1,
			task: "noop",
			systemPromptPath: "/dev/null",
			provider: "p",
			model: "m",
			cwd: "/tmp",
			timeoutMs: 120_000,
		};
		expect(task.timeoutMs).toBe(120_000);
	});

	it("treats timeoutMs as optional (existing callers without it still typecheck)", () => {
		const task: SubagentTask<number> = {
			tag: 1,
			task: "noop",
			systemPromptPath: "/dev/null",
			provider: "p",
			model: "m",
			cwd: "/tmp",
		};
		expect(task.timeoutMs).toBeUndefined();
	});

	it("preserves the SubagentOutcome shape (tag + rawText)", () => {
		const outcome: SubagentOutcome<number> = {
			tag: 7,
			rawText: "hello",
		};
		expect(outcome.tag).toBe(7);
		expect(outcome.rawText).toBe("hello");
	});
});

describe("runSubagentWithClient", () => {
	function task(timeoutMs = 25): SubagentTask<number> {
		return {
			tag: 1,
			task: "noop",
			systemPromptPath: "/dev/null",
			provider: "p",
			model: "m",
			cwd: "/tmp",
			timeoutMs,
		};
	}

	function client(overrides: Partial<SubagentClient> = {}): SubagentClient {
		return {
			start: vi.fn().mockResolvedValue(undefined),
			prompt: vi.fn().mockResolvedValue(undefined),
			waitForIdle: vi.fn().mockResolvedValue(undefined),
			getLastAssistantText: vi.fn().mockResolvedValue("answer"),
			stop: vi.fn().mockResolvedValue(undefined),
			...overrides,
		};
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("times out a hanging start and still asks the client to stop", async () => {
		const c = client({
			start: vi.fn(() => new Promise<void>(() => {})),
		});
		const resultPromise = runSubagentWithClient(task(10), c);

		await vi.advanceTimersByTimeAsync(10);
		const result = await resultPromise;

		expect(result.error).toContain("subagent timed out after 10ms");
		expect(c.stop).toHaveBeenCalledOnce();
	});

	it("times out a hanging prompt", async () => {
		const c = client({
			prompt: vi.fn(() => new Promise<void>(() => {})),
		});
		const resultPromise = runSubagentWithClient(task(10), c);

		await vi.advanceTimersByTimeAsync(10);
		const result = await resultPromise;

		expect(result.error).toContain("subagent timed out after 10ms");
		expect(c.stop).toHaveBeenCalledOnce();
	});

	it("does not let a hanging stop block the returned outcome", async () => {
		const c = client({
			stop: vi.fn(() => new Promise<void>(() => {})),
		});
		const resultPromise = runSubagentWithClient(task(100), c);

		await vi.advanceTimersByTimeAsync(2_000);
		const result = await resultPromise;

		expect(result.rawText).toBe("answer");
		expect(c.stop).toHaveBeenCalledOnce();
	});
});

describe("awaitIdleOrAbort", () => {
	/**
	 * Minimal `IdleWaitable` spy that records the arguments
	 * `waitForIdle` is called with and resolves immediately. Lets us
	 * assert the exact value that flows through `runSubagent`'s race.
	 */
	function makeSpy(): {
		client: IdleWaitable;
		calls: Array<number | undefined>;
	} {
		const calls: Array<number | undefined> = [];
		return {
			calls,
			client: {
				waitForIdle: async (ms?: number) => {
					calls.push(ms);
				},
			},
		};
	}

	const neverAborted: Promise<never> = new Promise<never>(() => {
		// never resolves or rejects — the race below must be settled
		// by `waitForIdle`.
	});

	it("forwards a numeric timeout verbatim to client.waitForIdle", async () => {
		const { client, calls } = makeSpy();
		await awaitIdleOrAbort(client, 255_000, neverAborted);
		expect(calls).toEqual([255_000]);
	});

	it("passes undefined through (so RpcClient's 60s default still applies when no timeout is set)", async () => {
		const { client, calls } = makeSpy();
		await awaitIdleOrAbort(client, undefined, neverAborted);
		expect(calls).toEqual([undefined]);
	});

	it("rejects when the abort promise wins the race (signal-driven cancellation path)", async () => {
		// `waitForIdle` here would resolve after a long delay; the
		// pre-rejected abort promise must win.
		const slowClient: IdleWaitable = {
			waitForIdle: () =>
				new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
		};
		const aborted: Promise<never> = Promise.reject(new Error("aborted"));
		// The promise we pass is already-rejected; suppress the
		// unhandledRejection warning.
		aborted.catch(() => {});
		await expect(awaitIdleOrAbort(slowClient, 60_000, aborted)).rejects.toThrow(
			"aborted",
		);
	});
});
