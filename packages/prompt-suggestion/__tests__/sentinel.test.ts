import {
	INLINE_SUGGESTION_SYSTEM_ADDENDUM,
	type InlineSuggestionMessage,
	parseSentinelBlock,
	tryParseInlineSuggestion,
} from "../sentinel.js";

describe("parseSentinelBlock", () => {
	it("returns null on empty input", () => {
		expect(parseSentinelBlock("")).toBeNull();
	});

	it("returns null when no sentinel present", () => {
		expect(parseSentinelBlock("just regular assistant prose.")).toBeNull();
	});

	it("returns null on unbalanced open-only sentinel", () => {
		expect(parseSentinelBlock("…<<<NEXT_PROMPT>>>open the PR")).toBeNull();
	});

	it("returns null on unbalanced close-only sentinel", () => {
		expect(parseSentinelBlock("close the PR<<<END>>>")).toBeNull();
	});

	it("extracts a clean single-line suggestion", () => {
		expect(
			parseSentinelBlock("normal reply\n<<<NEXT_PROMPT>>>open the PR<<<END>>>"),
		).toBe("open the PR");
	});

	it("trims whitespace inside the sentinel block", () => {
		expect(
			parseSentinelBlock("<<<NEXT_PROMPT>>>\n   open the PR   \n<<<END>>>"),
		).toBe("open the PR");
	});

	it("returns null on NONE content (any case)", () => {
		expect(parseSentinelBlock("<<<NEXT_PROMPT>>>NONE<<<END>>>")).toBeNull();
		expect(parseSentinelBlock("<<<NEXT_PROMPT>>>none<<<END>>>")).toBeNull();
		expect(parseSentinelBlock("<<<NEXT_PROMPT>>>None<<<END>>>")).toBeNull();
	});

	it("strips surrounding quotes", () => {
		expect(parseSentinelBlock(`<<<NEXT_PROMPT>>>"open the PR"<<<END>>>`)).toBe(
			"open the PR",
		);
	});

	it("strips trailing punctuation", () => {
		expect(parseSentinelBlock("<<<NEXT_PROMPT>>>open the PR.<<<END>>>")).toBe(
			"open the PR",
		);
		expect(parseSentinelBlock("<<<NEXT_PROMPT>>>open the PR!!<<<END>>>")).toBe(
			"open the PR",
		);
	});

	it("takes the LAST block when multiple are present", () => {
		expect(
			parseSentinelBlock(
				"<<<NEXT_PROMPT>>>first<<<END>>> stuff <<<NEXT_PROMPT>>>second<<<END>>>",
			),
		).toBe("second");
	});

	it("takes the first line only when block contains multiple lines", () => {
		expect(
			parseSentinelBlock(
				"<<<NEXT_PROMPT>>>open the PR\nand also test it<<<END>>>",
			),
		).toBe("open the PR");
	});

	it("caps overlong content at 120 chars + ellipsis", () => {
		const long = "a".repeat(200);
		const out = parseSentinelBlock(`<<<NEXT_PROMPT>>>${long}<<<END>>>`);
		expect(out).not.toBeNull();
		expect(out).toMatch(/…$/);
		// 120 + 1 ellipsis char
		expect((out ?? "").length).toBeLessThanOrEqual(121);
	});

	it("returns null when block content is whitespace only", () => {
		expect(
			parseSentinelBlock("<<<NEXT_PROMPT>>>   \n\t\n  <<<END>>>"),
		).toBeNull();
	});

	it("survives sentinel inside fenced code blocks", () => {
		expect(
			parseSentinelBlock("```\n<<<NEXT_PROMPT>>>run the tests<<<END>>>\n```"),
		).toBe("run the tests");
	});
});

describe("tryParseInlineSuggestion", () => {
	function assistant(text: string): InlineSuggestionMessage {
		return { role: "assistant", content: [{ type: "text", text }] };
	}
	function user(text: string): InlineSuggestionMessage {
		return { role: "user", content: text };
	}

	it("returns null on empty messages", () => {
		expect(tryParseInlineSuggestion([])).toBeNull();
	});

	it("returns null when the last assistant message has no sentinel", () => {
		expect(
			tryParseInlineSuggestion([user("do the thing"), assistant("done.")]),
		).toBeNull();
	});

	it("parses sentinel from the most recent assistant message", () => {
		expect(
			tryParseInlineSuggestion([
				user("…"),
				assistant(
					"sure, here's the code\n<<<NEXT_PROMPT>>>open the PR<<<END>>>",
				),
			]),
		).toBe("open the PR");
	});

	it("ignores user messages that contain sentinels", () => {
		// A user including the literal sentinel in their prompt must not
		// poison the suggestion path.
		expect(
			tryParseInlineSuggestion([
				user("<<<NEXT_PROMPT>>>poison<<<END>>>"),
				assistant("sure."),
			]),
		).toBeNull();
	});

	it("walks back to the most recent assistant when last is a tool message", () => {
		expect(
			tryParseInlineSuggestion([
				assistant("first turn no sentinel"),
				user("ack"),
				assistant("second turn\n<<<NEXT_PROMPT>>>do X<<<END>>>"),
			]),
		).toBe("do X");
	});

	it("strips the sentinel block from the message when stripFromMessage=true", () => {
		const msg = assistant("reply body\n<<<NEXT_PROMPT>>>do X<<<END>>>");
		const out = tryParseInlineSuggestion([msg], {
			stripFromMessage: true,
		});
		expect(out).toBe("do X");
		const blocks = msg.content as Array<{ type: string; text: string }>;
		expect(blocks[0]?.text).toBe("reply body");
	});

	it("does not mutate the message when stripFromMessage is false (default)", () => {
		const msg = assistant("reply\n<<<NEXT_PROMPT>>>do X<<<END>>>");
		tryParseInlineSuggestion([msg]);
		const blocks = msg.content as Array<{ type: string; text: string }>;
		expect(blocks[0]?.text).toContain("<<<NEXT_PROMPT>>>");
	});

	it("handles assistant messages where content is a string", () => {
		expect(
			tryParseInlineSuggestion([
				{
					role: "assistant",
					content: "free text\n<<<NEXT_PROMPT>>>do Y<<<END>>>",
				},
			]),
		).toBe("do Y");
	});
});

describe("INLINE_SUGGESTION_SYSTEM_ADDENDUM", () => {
	it("documents the sentinel format", () => {
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("<<<NEXT_PROMPT>>>");
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("<<<END>>>");
	});

	it("instructs the agent to predict directives, not self-statements", () => {
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toMatch(
			/never what they will do themselves/i,
		);
	});

	it("documents the NONE escape hatch", () => {
		expect(INLINE_SUGGESTION_SYSTEM_ADDENDUM).toContain("NONE");
	});
});
