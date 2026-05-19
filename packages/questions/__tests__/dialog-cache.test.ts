import { renderCacheIsValid } from "../dialog.js";

// ---------------------------------------------------------------------------
// renderCacheIsValid — resize-invalidation logic for the dialog render cache
// ---------------------------------------------------------------------------

describe("renderCacheIsValid", () => {
	it("returns false when cache is empty (first render)", () => {
		expect(renderCacheIsValid(undefined, -1, 80)).toBe(false);
	});

	it("returns true when cached at the same width", () => {
		const lines = ["line 1", "line 2"];
		expect(renderCacheIsValid(lines, 80, 80)).toBe(true);
	});

	it("returns false when terminal width increased (resize)", () => {
		const lines = ["line 1"];
		expect(renderCacheIsValid(lines, 80, 120)).toBe(false);
	});

	it("returns false when terminal width decreased (resize)", () => {
		const lines = ["line 1"];
		expect(renderCacheIsValid(lines, 120, 80)).toBe(false);
	});

	it("returns false when cachedWidth is the -1 sentinel but lines exist", () => {
		// -1 is the initial value set by invalidate(); should always miss.
		const lines = ["stale"];
		expect(renderCacheIsValid(lines, -1, 80)).toBe(false);
	});

	it("returns true for zero-width edge case when both match", () => {
		expect(renderCacheIsValid([], 0, 0)).toBe(true);
	});
});
