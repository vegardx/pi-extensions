/**
 * Unit tests for active-mode accessor (#136).
 */

import { getActiveMode, setActiveMode } from "../active-mode.js";

afterEach(() => setActiveMode(null));

describe("active-mode", () => {
	it("returns null before anything is set", () => {
		setActiveMode(null);
		expect(getActiveMode()).toBeNull();
	});

	it("round-trips a mode string", () => {
		setActiveMode("auto");
		expect(getActiveMode()).toBe("auto");
		setActiveMode("hack");
		expect(getActiveMode()).toBe("hack");
		setActiveMode("ask");
		expect(getActiveMode()).toBe("ask");
		setActiveMode("plan");
		expect(getActiveMode()).toBe("plan");
	});

	it("normalises null and undefined to null", () => {
		setActiveMode("auto");
		setActiveMode(null);
		expect(getActiveMode()).toBeNull();
		setActiveMode("auto");
		setActiveMode(undefined);
		expect(getActiveMode()).toBeNull();
	});
});
