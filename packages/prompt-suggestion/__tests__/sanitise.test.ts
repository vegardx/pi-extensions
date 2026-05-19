import {
	INLINE_SUGGESTION_SYSTEM_ADDENDUM,
	sanitiseSuggestion,
} from "../sanitise.js";

describe("sanitiseSuggestion", () => {
	it("returns null on empty input", () => {
		expect(sanitiseSuggestion("")).toBeNull();
	});

	it("returns null on whitespace-only input", () => {
		expect(sanitiseSuggestion("   \n\t\n  ")).toBeNull();
	});

	it("returns the trimmed first line for a clean single-line suggestion", () => {
		expect(sanitiseSuggestion("open the PR")).toBe("open the PR");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitiseSuggestion("   open the PR   ")).toBe("open the PR");
	});

	it("returns null on NONE content (any case)", () => {
		expect(sanitiseSuggestion("NONE")).toBeNull();
		expect(sanitiseSuggestion("none")).toBeNull();
		expect(sanitiseSuggestion("None")).toBeNull();
	});

	it("strips surrounding quotes", () => {
		expect(sanitiseSuggestion(`"open the PR"`)).toBe("open the PR");
		expect(sanitiseSuggestion(`'open the PR'`)).toBe("open the PR");
		expect(sanitiseSuggestion("`open the PR`")).toBe("open the PR");
	});

	it("strips trailing punctuation", () => {
		expect(sanitiseSuggestion("open the PR.")).toBe("open the PR");
		expect(sanitiseSuggestion("open the PR!!")).toBe("open the PR");
		expect(sanitiseSuggestion("open the PR?")).toBe("open the PR");
	});

	it("takes the first line only when input contains multiple lines", () => {
		expect(sanitiseSuggestion("open the PR\nand also test it")).toBe(
			"open the PR",
		);
	});

	it("caps overlong content at 120 chars + ellipsis", () => {
		const long = "a".repeat(200);
		const out = sanitiseSuggestion(long);
		expect(out).not.toBeNull();
		expect(out).toMatch(/…$/);
		// 120 + 1 ellipsis char
		expect((out ?? "").length).toBeLessThanOrEqual(121);
	});

	it("strips ANSI escape sequences", () => {
		// A suggestion that contains escape codes would render terminal
		// control sequences in the ghost editor.
		expect(sanitiseSuggestion("\x1b[31mred suggestion\x1b[0m")).toBe(
			"red suggestion",
		);
	});

	it("strips Unicode bidi/format overrides", () => {
		// LRO / RLO can visually spoof what the user thinks they're
		// accepting; ZWSP can sneak past visual review.
		expect(sanitiseSuggestion("fix\u202Eevil\u202C bug")).toBe("fixevil bug");
	});

	it("strips control chars (NUL, BEL, etc.)", () => {
		expect(sanitiseSuggestion("open\x00the\x07PR")).toBe("openthePR");
	});

	it("returns null when sanitisation strips everything", () => {
		expect(sanitiseSuggestion("\u202E\u202C")).toBeNull();
		expect(sanitiseSuggestion("\x1b[31m\x1b[0m")).toBeNull();
	});
});

describe("INLINE_SUGGESTION_SYSTEM_ADDENDUM", () => {
	it("names the suggest_next_prompt tool", () => {
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("suggest_next_prompt");
	});

	it("instructs the agent to predict directives, not self-statements", () => {
		// The example contrasts an imperative ("Open the PR") with a
		// self-statement ("I'll open the PR") to anchor the directive
		// framing.
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("Open the PR");
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("I'll open the PR");
	});

	it("documents the omit-on-no-suggestion escape hatch", () => {
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toMatch(/omit/i);
	});

	it("declares the 120-char limit", () => {
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("120");
	});

	it("does not leak the legacy bracketed-sentinel format", () => {
		// Regression guard: callers who copied the old addendum into their
		// AGENTS.md need to update; we shouldn't ship both formats.
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).not.toMatch(/<<<[A-Z_]+>>>/);
	});
});
