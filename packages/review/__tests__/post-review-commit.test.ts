import { shouldOfferPostReviewCommit } from "../index.js";

describe("shouldOfferPostReviewCommit", () => {
	it("returns true when interactive AND /commit is installed", () => {
		expect(
			shouldOfferPostReviewCommit({
				hasUI: true,
				commitInstalled: true,
			}),
		).toBe(true);
	});

	it("returns false when not interactive", () => {
		// Non-interactive (RPC mode etc.) — no way to ask the user
		// whether to chain, so we don't.
		expect(
			shouldOfferPostReviewCommit({
				hasUI: false,
				commitInstalled: true,
			}),
		).toBe(false);
	});

	it("returns false when /commit isn't installed", () => {
		// Nothing to chain into.
		expect(
			shouldOfferPostReviewCommit({
				hasUI: true,
				commitInstalled: false,
			}),
		).toBe(false);
	});

	it("returns false when both hasUI and /commit are off", () => {
		// Belt-and-braces: still false.
		expect(
			shouldOfferPostReviewCommit({
				hasUI: false,
				commitInstalled: false,
			}),
		).toBe(false);
	});

	// The fix-count axis (accepted / explain requests) is intentionally
	// NOT a precondition. A "no findings" review is just as natural a
	// moment to chain into /commit as a fix-walked one. Whether to use
	// a one-shot listener (fix turn pending) or dispatch /commit
	// immediately is decided in `chainToCommit`, not here.
	it("does not consult fix counts (callers decide listener vs immediate)", () => {
		expect(
			shouldOfferPostReviewCommit({ hasUI: true, commitInstalled: true }),
		).toBe(true);
	});
});
