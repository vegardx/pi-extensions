/**
 * Tests for `capDelegatedAnswer` — the hard-cap backstop on a
 * delegated answer's size.
 */

import { capDelegatedAnswer } from "../config.js";

describe("capDelegatedAnswer", () => {
	it("returns short text unchanged", () => {
		expect(capDelegatedAnswer("hi", 100)).toBe("hi");
	});

	it("truncates with a marker and stays within the cap", () => {
		const out = capDelegatedAnswer("x".repeat(500), 100);
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out).toContain("truncated at 100 chars");
	});

	it("never exceeds a cap smaller than the truncation marker", () => {
		const text = "y".repeat(500);
		for (const cap of [0, 1, 10, 40]) {
			const out = capDelegatedAnswer(text, cap);
			expect(out.length).toBeLessThanOrEqual(cap);
		}
	});
});
