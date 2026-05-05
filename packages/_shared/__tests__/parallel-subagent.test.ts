import type { SubagentOutcome, SubagentTask } from "../parallel-subagent.js";

// ---- Type-level checks for the public SubagentTask interface ----------
//
// We can't unit-test `runSubagent` itself without spawning a child pi
// process, but we can assert at the type layer that the public
// interface still carries the fields downstream consumers rely on.
// The `assertAssignable` helper below makes the check compile-time:
// any drift in `SubagentTask`'s shape will surface as a TypeScript
// error at `make typecheck` rather than mysteriously breaking the
// `/verify` timeout heuristic at runtime.

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
