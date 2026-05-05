import {
	BASE_VERIFY_TIMEOUT_MS,
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
