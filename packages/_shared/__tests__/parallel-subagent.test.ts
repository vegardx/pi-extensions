import type {
	IdleWaitable,
	SubagentOutcome,
	SubagentTask,
} from "../parallel-subagent.js";
import { awaitIdleOrAbort } from "../parallel-subagent.js";

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
//      post-PR-#27 60s timeout cliff on `/verify`.
//
// Together the two layers cover the chain `caller → SubagentTask →
// runSubagent → awaitIdleOrAbort → RpcClient.waitForIdle`.

describe("SubagentTask interface", () => {
	it("accepts an optional timeoutMs field (used by /verify to scale waitForIdle)", () => {
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

	it("passes undefined through (so RpcClient's 60s default still applies for non-/verify callers)", async () => {
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
