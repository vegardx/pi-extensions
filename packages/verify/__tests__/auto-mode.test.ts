import { findAutoModeIteration } from "../index.js";

type Entry = {
	type: string;
	customType?: string;
	data?: unknown;
};

describe("findAutoModeIteration", () => {
	it("returns null when there are no relevant entries", () => {
		const entries: Entry[] = [];
		expect(findAutoModeIteration(entries)).toBeNull();
	});

	it("returns null when only unrelated entries exist", () => {
		const entries: Entry[] = [
			{ type: "message", customType: "user", data: { content: "hi" } },
			{ type: "custom", customType: "something-else", data: {} },
		];
		expect(findAutoModeIteration(entries)).toBeNull();
	});

	it("returns request iteration when there's a request but no result yet", () => {
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 1, planText: "Plan:\n1. step" },
			},
		];
		expect(findAutoModeIteration(entries)).toBe(1);
	});

	it("returns null when latest request matches latest result iteration (already answered)", () => {
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 1 },
			},
			{
				type: "custom",
				customType: "develop-verify-result",
				data: { iteration: 1, verdicts: [], errorCount: 0 },
			},
		];
		expect(findAutoModeIteration(entries)).toBeNull();
	});

	it("returns the latest request iteration when it's ahead of latest result", () => {
		// /develop bumped iteration to 2 and wrote a fresh request; /verify
		// should pick up the new one even though there's a stale result.
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 1 },
			},
			{
				type: "custom",
				customType: "develop-verify-result",
				data: { iteration: 1 },
			},
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 2 },
			},
		];
		expect(findAutoModeIteration(entries)).toBe(2);
	});

	it("uses the LATEST request and LATEST result, not the first", () => {
		// Multiple iterations: the latest pair determines auto-mode state.
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 1 },
			},
			{
				type: "custom",
				customType: "develop-verify-result",
				data: { iteration: 1 },
			},
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 2 },
			},
			{
				type: "custom",
				customType: "develop-verify-result",
				data: { iteration: 2 },
			},
		];
		// All answered → null
		expect(findAutoModeIteration(entries)).toBeNull();
	});

	it("returns null when request has no iteration field (malformed)", () => {
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { planText: "Plan:" },
			},
		];
		expect(findAutoModeIteration(entries)).toBeNull();
	});

	it("treats a request with no result as iteration 0 baseline", () => {
		// First-ever verify: latest result iteration defaults to 0; any
		// request iteration ≥ 1 is unanswered.
		const entries: Entry[] = [
			{
				type: "custom",
				customType: "develop-verify-request",
				data: { iteration: 1 },
			},
		];
		expect(findAutoModeIteration(entries)).toBe(1);
	});

	it("ignores message entries entirely", () => {
		const entries: Entry[] = [
			{
				type: "message",
				customType: "develop-verify-request",
				data: { iteration: 99 },
			},
		];
		expect(findAutoModeIteration(entries)).toBeNull();
	});
});
