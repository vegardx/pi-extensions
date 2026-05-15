import {
	resolveImplementDefault,
	resolveImplementModeForCurrentMode,
} from "../index.js";

// ---------------------------------------------------------------------------
// resolveImplementModeForCurrentMode — mode-preservation table
// ---------------------------------------------------------------------------

describe("resolveImplementModeForCurrentMode", () => {
	it("preserves ask when current mode is ask", () => {
		expect(resolveImplementModeForCurrentMode("ask", "auto")).toBe("ask");
	});

	it("preserves auto when current mode is auto", () => {
		expect(resolveImplementModeForCurrentMode("auto", "ask")).toBe("auto");
	});

	it("falls back to default when mode is plan", () => {
		expect(resolveImplementModeForCurrentMode("plan", "auto")).toBe("auto");
		expect(resolveImplementModeForCurrentMode("plan", "ask")).toBe("ask");
	});

	it("falls back to default when mode is hack (ImplementMode excludes hack)", () => {
		expect(resolveImplementModeForCurrentMode("hack", "auto")).toBe("auto");
		expect(resolveImplementModeForCurrentMode("hack", "ask")).toBe("ask");
	});

	it("falls back to default when mode is null", () => {
		expect(resolveImplementModeForCurrentMode(null, "auto")).toBe("auto");
	});

	it("falls back to default when mode is undefined", () => {
		expect(resolveImplementModeForCurrentMode(undefined, "ask")).toBe("ask");
	});

	it("falls back to default for unrecognised mode strings", () => {
		expect(resolveImplementModeForCurrentMode("idle", "auto")).toBe("auto");
	});

	// Idempotency: result is always a valid ImplementMode
	it.each([
		["ask", "auto"],
		["ask", "ask"],
		["auto", "auto"],
		["auto", "ask"],
		["plan", "auto"],
		["plan", "ask"],
		["hack", "auto"],
		["hack", "ask"],
	] as const)("always returns a valid ImplementMode (currentMode=%s, default=%s)", (currentMode, defaultMode) => {
		const result = resolveImplementModeForCurrentMode(currentMode, defaultMode);
		expect(["auto", "ask"]).toContain(result);
	});
});

// ---------------------------------------------------------------------------
// resolveImplementDefault — validate config value
// ---------------------------------------------------------------------------

describe("resolveImplementDefault", () => {
	it("defaults to auto for undefined", () => {
		expect(resolveImplementDefault(undefined)).toEqual({
			mode: "auto",
			valid: true,
		});
	});

	it("accepts auto", () => {
		expect(resolveImplementDefault("auto")).toEqual({
			mode: "auto",
			valid: true,
		});
	});

	it("accepts ask", () => {
		expect(resolveImplementDefault("ask")).toEqual({
			mode: "ask",
			valid: true,
		});
	});

	it("rejects unknown strings, falls back to auto", () => {
		expect(resolveImplementDefault("plan")).toEqual({
			mode: "auto",
			valid: false,
		});
	});

	it("rejects non-strings, falls back to auto", () => {
		expect(resolveImplementDefault(42)).toEqual({
			mode: "auto",
			valid: false,
		});
	});
});
