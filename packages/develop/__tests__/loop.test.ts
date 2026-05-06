// The verify loop was removed from /develop. The loop-related plan-utils
// helpers (decideLoopAction, aggregateConcerns, detectNoProgress,
// toVerdictSnapshot, restoreLoopPhaseFromAutoReview) have been deleted.
// The remaining plan-utils tests live in plan-utils.test.ts.

describe("verify loop removed", () => {
	it("loop logic was deleted with the verify loop — see plan-utils.test.ts", () => {
		expect(true).toBe(true);
	});
});
