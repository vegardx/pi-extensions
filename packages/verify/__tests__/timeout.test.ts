import {
	BASE_VERIFY_TIMEOUT_MS,
	buildVerifySubagentInput,
	MAX_VERIFY_TIMEOUT_MS,
	PER_STEP_TIMEOUT_MS,
	verifyTimeoutMs,
} from "../index.js";

describe("verifyTimeoutMs", () => {
	it("uses the base 60s budget when there are no steps", () => {
		// Defensive: callers should never invoke /verify with zero
		// steps (resolvePlan rejects empty plans), but if they did, the
		// heuristic must still return a usable timeout.
		expect(verifyTimeoutMs(0)).toBe(BASE_VERIFY_TIMEOUT_MS);
	});

	it("adds 15s of headroom per plan step", () => {
		expect(verifyTimeoutMs(1)).toBe(
			BASE_VERIFY_TIMEOUT_MS + PER_STEP_TIMEOUT_MS,
		);
		expect(verifyTimeoutMs(5)).toBe(
			BASE_VERIFY_TIMEOUT_MS + 5 * PER_STEP_TIMEOUT_MS,
		);
	});

	it("scales linearly up to the cap (13 steps → 255s, well under cap)", () => {
		// 13 steps was the size of the plan that surfaced the
		// post-#27 single-subagent timeout regression. 60s + 13*15s =
		// 255s leaves ~45s of headroom under the 5-minute ceiling.
		expect(verifyTimeoutMs(13)).toBe(255_000);
		expect(verifyTimeoutMs(13)).toBeLessThan(MAX_VERIFY_TIMEOUT_MS);
	});

	it("clamps at the 5-minute cap for absurdly large plans", () => {
		expect(verifyTimeoutMs(100)).toBe(MAX_VERIFY_TIMEOUT_MS);
		// Cap is exactly hit at 16 steps (60s + 16*15s = 300s).
		expect(verifyTimeoutMs(16)).toBe(MAX_VERIFY_TIMEOUT_MS);
		expect(verifyTimeoutMs(17)).toBe(MAX_VERIFY_TIMEOUT_MS);
	});

	it("treats negative / non-finite step counts defensively as zero", () => {
		// Boundary check — a corrupted step list shouldn't yield a
		// negative timeout that bypasses the underlying RpcClient
		// default.
		expect(verifyTimeoutMs(-1)).toBe(BASE_VERIFY_TIMEOUT_MS);
		expect(verifyTimeoutMs(Number.NaN)).toBe(BASE_VERIFY_TIMEOUT_MS);
	});
});

describe("buildVerifySubagentInput", () => {
	// Pin the call-shape `runVerify` hands to `runSubagent`. A typo or
	// refactor accident here — dropping `timeoutMs`, passing seconds
	// instead of ms, swapping in `verifyTimeoutMs(0)` instead of
	// `steps.length` — would silently re-introduce the post-PR-#27 60s
	// timeout cliff while the heuristic-only suite above stayed green.

	const threeStepPlan = [
		{ step: 1, text: "first" },
		{ step: 2, text: "second" },
		{ step: 3, text: "third" },
	];

	it("wires verifyTimeoutMs(steps.length) into the SubagentTask", () => {
		const input = buildVerifySubagentInput({
			steps: threeStepPlan,
			provider: "prov",
			modelId: "mid",
			cwd: "/tmp",
		});
		expect(input.timeoutMs).toBe(verifyTimeoutMs(threeStepPlan.length));
		expect(input.timeoutMs).toBe(
			BASE_VERIFY_TIMEOUT_MS + 3 * PER_STEP_TIMEOUT_MS,
		);
	});

	it("forwards provider, model, cwd, signal, and tag verbatim", () => {
		const signal = new AbortController().signal;
		const input = buildVerifySubagentInput({
			steps: threeStepPlan,
			provider: "prov",
			modelId: "mid",
			cwd: "/some/cwd",
			signal,
		});
		expect(input.tag).toBe(0);
		expect(input.provider).toBe("prov");
		expect(input.model).toBe("mid");
		expect(input.cwd).toBe("/some/cwd");
		expect(input.signal).toBe(signal);
	});

	it("resolves systemPromptPath against the verify package's prompts dir", () => {
		const input = buildVerifySubagentInput({
			steps: threeStepPlan,
			provider: "p",
			modelId: "m",
			cwd: "/tmp",
		});
		// Don't lock the absolute path — just confirm we point at the
		// shipped prompt file rather than e.g. a stale /dev/null or
		// process.cwd()-relative path that would silently break under
		// the workspace symlink.
		expect(input.systemPromptPath).toMatch(/prompts[\\/]+verify\.md$/);
	});

	it("embeds every step in the task payload (regression guard for plan-truncation typos)", () => {
		const input = buildVerifySubagentInput({
			steps: threeStepPlan,
			provider: "p",
			modelId: "m",
			cwd: "/tmp",
		});
		for (const step of threeStepPlan) {
			expect(input.task).toContain(step.text);
		}
	});

	it("caps the timeout for absurdly large plans (no override path)", () => {
		const hugePlan = Array.from({ length: 50 }, (_, i) => ({
			step: i + 1,
			text: `step ${i + 1}`,
		}));
		const input = buildVerifySubagentInput({
			steps: hugePlan,
			provider: "p",
			modelId: "m",
			cwd: "/tmp",
		});
		expect(input.timeoutMs).toBe(MAX_VERIFY_TIMEOUT_MS);
	});
});
