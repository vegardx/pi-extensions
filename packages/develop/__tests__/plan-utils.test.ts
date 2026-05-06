import {
	buildPostLoopPickerOptions,
	decideAutoReviewNextAction,
} from "../plan-utils.js";

describe("buildPostLoopPickerOptions", () => {
	it("Stay here always present, even when no follow-ups installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(),
		});
		expect(options).toEqual(["Stay here — I'll handle it"]);
	});

	it("only review when only review installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review"]),
		});
		expect(options).toEqual(["Run /review", "Stay here — I'll handle it"]);
	});

	it("only commit when only commit installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["commit"]),
		});
		expect(options).toEqual(["Run /commit", "Stay here — I'll handle it"]);
	});

	it("review+commit when both installed", () => {
		const options = buildPostLoopPickerOptions({
			installedCommands: new Set(["review", "commit"]),
		});
		expect(options).toEqual([
			"Run /review",
			"Run /commit",
			"Stay here — I'll handle it",
		]);
	});
});

describe("decideAutoReviewNextAction", () => {
	it("skips to picker when the auto-review pass didn't run", () => {
		expect(decideAutoReviewNextAction({ ran: false, appliedCount: 0 })).toBe(
			"skip-to-picker",
		);
		// Even if a leftover applied-count is nonzero, a non-run pass
		// can't have queued anything for the host — still skip.
		expect(decideAutoReviewNextAction({ ran: false, appliedCount: 5 })).toBe(
			"skip-to-picker",
		);
	});

	it("skips to picker when the pass ran but found no consensus", () => {
		expect(decideAutoReviewNextAction({ ran: true, appliedCount: 0 })).toBe(
			"skip-to-picker",
		);
	});

	it("applies fixes when at least one consensus finding was queued", () => {
		expect(decideAutoReviewNextAction({ ran: true, appliedCount: 1 })).toBe(
			"apply-fixes",
		);
		expect(decideAutoReviewNextAction({ ran: true, appliedCount: 12 })).toBe(
			"apply-fixes",
		);
	});

	it("treats negative applied counts defensively as skip-to-picker", () => {
		// Shouldn't happen in practice, but make sure the boundary is
		// `> 0` not `!= 0` so a defensive negative still routes safely.
		expect(decideAutoReviewNextAction({ ran: true, appliedCount: -1 })).toBe(
			"skip-to-picker",
		);
	});
});
