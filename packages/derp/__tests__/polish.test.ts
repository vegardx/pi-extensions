import type { DerpContext } from "../context.js";
import { polishReport, type SubagentRunner } from "../polish.js";

function makeCtx(): DerpContext {
	return {
		userText: "ghost text overlaps input",
		date: "2026-05-10",
		sessionId: "s",
		sessionName: null,
		piVersion: "0.73.0",
		recentEntries: [],
	};
}

function fixedRunner(rawText: string, error?: string): SubagentRunner {
	return async () => ({ rawText, error });
}

describe("polishReport", () => {
	const baseInput = {
		ctx: makeCtx(),
		provider: "anthropic",
		model: "claude-haiku",
		cwd: "/tmp/r",
		timeoutMs: 30000,
	};

	it("parses a clean JSON response", async () => {
		const r = await polishReport(
			baseInput,
			fixedRunner('{"title":"a bug","body":"## Summary\\n\\nbroken"}'),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.draft.title).toBe("a bug");
			expect(r.draft.body).toContain("broken");
		}
	});

	it("recovers JSON from a fenced code block", async () => {
		const raw = 'Here you go:\n\n```json\n{"title":"x","body":"y"}\n```';
		const r = await polishReport(baseInput, fixedRunner(raw));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.draft.title).toBe("x");
	});

	it("falls back to bad-json on prose-only output", async () => {
		const r = await polishReport(
			baseInput,
			fixedRunner("here is your issue: please fix it"),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("bad-json");
	});

	it("returns empty-output when subagent returns no text", async () => {
		const r = await polishReport(baseInput, fixedRunner(""));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("empty-output");
	});

	it("propagates subagent errors", async () => {
		const r = await polishReport(
			baseInput,
			fixedRunner("", "timeout waiting for idle"),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("subagent-error");
			expect(r.detail).toContain("timeout");
		}
	});

	it("forwards task fields to the runner", async () => {
		let capturedTask: any = null;
		const runner: SubagentRunner = async (task) => {
			capturedTask = task;
			return { rawText: '{"title":"t","body":"b"}' };
		};
		await polishReport(baseInput, runner);
		expect(capturedTask.tag).toBe("derp");
		expect(capturedTask.provider).toBe("anthropic");
		expect(capturedTask.model).toBe("claude-haiku");
		expect(capturedTask.timeoutMs).toBe(30000);
		expect(capturedTask.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(capturedTask.systemPromptPath).toContain("system-prompt.md");
	});

	it("recovers JSON when model adds prose after the object", async () => {
		const raw =
			'Here is the issue:\n{"title":"a bug","body":"broken"}\n\nLet me know!';
		const r = await polishReport(baseInput, fixedRunner(raw));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.draft.title).toBe("a bug");
	});

	it("rejects polish output missing required fields", async () => {
		const r = await polishReport(
			baseInput,
			fixedRunner('{"title":"only-title"}'),
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("bad-json");
	});
});
