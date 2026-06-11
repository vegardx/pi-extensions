import {
	BASE_REVIEW_TIMEOUT_MS,
	MAX_REVIEW_TIMEOUT_MS,
	PER_10K_CHARS_MS,
	reviewTimeoutMs,
} from "../lens-client.js";

describe("reviewTimeoutMs", () => {
	it("uses the base 120s budget when diff is empty / zero", () => {
		// Defensive: reviewers with no diff content should still get
		// a usable timeout rather than zero.
		expect(reviewTimeoutMs(0)).toBe(BASE_REVIEW_TIMEOUT_MS);
	});

	it("adds 15s per 10 000 chars of diff", () => {
		expect(reviewTimeoutMs(10_000)).toBe(
			BASE_REVIEW_TIMEOUT_MS + PER_10K_CHARS_MS,
		);
		expect(reviewTimeoutMs(30_000)).toBe(
			BASE_REVIEW_TIMEOUT_MS + 3 * PER_10K_CHARS_MS,
		);
	});

	it("rounds down to the nearest 10k-char band", () => {
		// 9 999 chars → 0 full bands → base only.
		expect(reviewTimeoutMs(9_999)).toBe(BASE_REVIEW_TIMEOUT_MS);
		// 10 001 chars → 1 full band.
		expect(reviewTimeoutMs(10_001)).toBe(
			BASE_REVIEW_TIMEOUT_MS + PER_10K_CHARS_MS,
		);
	});

	it("clamps at the 10-minute cap for very large diffs", () => {
		expect(reviewTimeoutMs(1_000_000)).toBe(MAX_REVIEW_TIMEOUT_MS);
		// Cap is hit at 320k chars: 120s + 32*15s = 600s.
		expect(reviewTimeoutMs(320_000)).toBe(MAX_REVIEW_TIMEOUT_MS);
		expect(reviewTimeoutMs(321_000)).toBe(MAX_REVIEW_TIMEOUT_MS);
	});

	it("is strictly above the 60s RpcClient default for any non-empty diff", () => {
		// Reviewers must never run on a tighter budget than the legacy
		// default, even for tiny diffs.
		expect(reviewTimeoutMs(1)).toBeGreaterThan(60_000);
	});

	it("treats negative / non-finite diff sizes as zero", () => {
		expect(reviewTimeoutMs(-1)).toBe(BASE_REVIEW_TIMEOUT_MS);
		expect(reviewTimeoutMs(Number.NaN)).toBe(BASE_REVIEW_TIMEOUT_MS);
		expect(reviewTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
			BASE_REVIEW_TIMEOUT_MS,
		);
	});
});
