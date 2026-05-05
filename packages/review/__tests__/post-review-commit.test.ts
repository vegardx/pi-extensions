import { shouldOfferPostReviewCommit } from "../index.js";

describe("shouldOfferPostReviewCommit", () => {
	it("returns false when no fixes were accepted or explain-requested", () => {
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 0,
				explainCount: 0,
				hasUI: true,
				commitInstalled: true,
			}),
		).toBe(false);
	});

	it("returns true when fixes queued, UI present, commit installed", () => {
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 2,
				explainCount: 0,
				hasUI: true,
				commitInstalled: true,
			}),
		).toBe(true);
	});

	it("explainCount alone (no accepted) still triggers the offer", () => {
		// Explain requests still produce a follow-up turn — the agent
		// walks the user through each one, after which committing is
		// still a sensible next step.
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 0,
				explainCount: 3,
				hasUI: true,
				commitInstalled: true,
			}),
		).toBe(true);
	});

	it("accepted + explain combined triggers the offer", () => {
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 1,
				explainCount: 1,
				hasUI: true,
				commitInstalled: true,
			}),
		).toBe(true);
	});

	it("returns false when not interactive (hasUI=false)", () => {
		// Non-interactive (RPC mode etc.) — no way to ask the user
		// whether to chain, so we don't.
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 5,
				explainCount: 5,
				hasUI: false,
				commitInstalled: true,
			}),
		).toBe(false);
	});

	it("returns false when /commit isn't installed", () => {
		// Nothing to chain into.
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 5,
				explainCount: 5,
				hasUI: true,
				commitInstalled: false,
			}),
		).toBe(false);
	});

	it("returns false when both hasUI=false AND no commit installed", () => {
		// Belt-and-braces: still false.
		expect(
			shouldOfferPostReviewCommit({
				acceptedCount: 1,
				explainCount: 0,
				hasUI: false,
				commitInstalled: false,
			}),
		).toBe(false);
	});
});
