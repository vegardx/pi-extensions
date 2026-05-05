import { extractPlanSteps, parseVerdict, parseVerdictArray } from "../index.js";

describe("extractPlanSteps", () => {
	it("returns [] when there's no Plan: header", () => {
		expect(extractPlanSteps("just some text")).toEqual([]);
	});

	it("extracts numbered steps under a plain Plan: header", () => {
		const items = extractPlanSteps(
			"Plan:\n1. First step here\n2. Second step here",
		);
		expect(items).toEqual([
			{ step: 1, text: "First step here" },
			{ step: 2, text: "Second step here" },
		]);
	});

	it("accepts ## Plan: heading style and **Plan:** bolded style", () => {
		expect(
			extractPlanSteps("## Plan:\n1. Alpha step\n2. Beta step"),
		).toHaveLength(2);
		expect(
			extractPlanSteps("**Plan:**\n1. Alpha step\n2. Beta step"),
		).toHaveLength(2);
	});

	it("accepts both `1.` and `1)` numbering", () => {
		const items = extractPlanSteps(
			"Plan:\n1) First step here\n2) Second step here",
		);
		expect(items.map((i) => i.text)).toEqual([
			"First step here",
			"Second step here",
		]);
	});

	it("renumbers steps to be 1-based and contiguous", () => {
		const items = extractPlanSteps(
			"Plan:\n3. Third in source\n7. Seventh in source\n42. Forty-second",
		);
		expect(items.map((i) => i.step)).toEqual([1, 2, 3]);
	});

	it("skips steps starting with `, /, or - (look like code/paths/bullets)", () => {
		const items = extractPlanSteps(
			"Plan:\n1. `code-only step`\n2. /path/to/file\n3. - dash bullet\n4. Real step here",
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.text).toBe("Real step here");
	});

	it("strips inline markdown emphasis and code", () => {
		const items = extractPlanSteps(
			"Plan:\n1. Add **bold** and `code` in step\n2. Plain step",
		);
		expect(items[0]?.text).toBe("Add bold and code in step");
		expect(items[1]?.text).toBe("Plain step");
	});

	it("ignores text after the plan if it isn't numbered", () => {
		const items = extractPlanSteps(
			"## Context\n\nblah blah\n\nPlan:\n1. Real step\n2. Another step\n\n## Risks\n- some risk",
		);
		expect(items).toHaveLength(2);
	});
});

describe("parseVerdict", () => {
	it("parses a well-formed JSON verdict", () => {
		const v = parseVerdict(
			JSON.stringify({
				step: 3,
				status: "partial",
				reason: "the reason",
				suggestion: "do this",
			}),
		);
		expect(v).toEqual({
			step: 3,
			status: "partial",
			reason: "the reason",
			suggestion: "do this",
		});
	});

	it("treats absent suggestion as undefined", () => {
		const v = parseVerdict(
			JSON.stringify({ step: 1, status: "done", reason: "ok" }),
		);
		expect(v).toEqual({
			step: 1,
			status: "done",
			reason: "ok",
			suggestion: undefined,
		});
	});

	it("treats empty-string suggestion as undefined", () => {
		const v = parseVerdict(
			JSON.stringify({
				step: 1,
				status: "done",
				reason: "ok",
				suggestion: "",
			}),
		);
		expect(v?.suggestion).toBeUndefined();
	});

	it("tolerates ```json … ``` code-fence wrapping", () => {
		const v = parseVerdict(
			'```json\n{"step":2,"status":"missing","reason":"nope"}\n```',
		);
		expect(v?.status).toBe("missing");
	});

	it("tolerates plain ``` … ``` without language tag", () => {
		const v = parseVerdict(
			'```\n{"step":2,"status":"missing","reason":"nope"}\n```',
		);
		expect(v?.status).toBe("missing");
	});

	it("returns null for empty input", () => {
		expect(parseVerdict("")).toBeNull();
		expect(parseVerdict("   \n  ")).toBeNull();
	});

	it("returns null for non-JSON output", () => {
		expect(parseVerdict("the answer is 42")).toBeNull();
	});

	it("returns null for JSON with the wrong shape", () => {
		expect(parseVerdict(JSON.stringify({ step: 1 }))).toBeNull();
		expect(
			parseVerdict(JSON.stringify({ step: 1, status: "ok", reason: "x" })),
		).toBeNull();
		expect(
			parseVerdict(
				JSON.stringify({ step: "one", status: "done", reason: "ok" }),
			),
		).toBeNull();
	});

	it("accepts all four valid status values", () => {
		for (const status of [
			"done",
			"partial",
			"missing",
			"unverifiable",
		] as const) {
			const v = parseVerdict(JSON.stringify({ step: 1, status, reason: "x" }));
			expect(v?.status).toBe(status);
		}
	});
});

describe("parseVerdictArray", () => {
	it("returns null for empty input", () => {
		expect(parseVerdictArray("")).toBeNull();
		expect(parseVerdictArray("   \n  ")).toBeNull();
	});

	it("returns null for non-JSON input", () => {
		expect(parseVerdictArray("the answer is 42")).toBeNull();
	});

	it("returns null when the JSON is not an array", () => {
		// A bare object, even if shaped like a verdict, is not an array.
		expect(
			parseVerdictArray(
				JSON.stringify({ step: 1, status: "done", reason: "x" }),
			),
		).toBeNull();
	});

	it("returns an empty array for `[]` input", () => {
		expect(parseVerdictArray("[]")).toEqual([]);
	});

	it("parses a well-shaped array of verdicts", () => {
		const input = JSON.stringify([
			{ step: 1, status: "done", reason: "first" },
			{ step: 2, status: "partial", reason: "second", suggestion: "do x" },
			{ step: 3, status: "missing", reason: "third" },
		]);
		const result = parseVerdictArray(input);
		expect(result).toEqual([
			{ step: 1, status: "done", reason: "first", suggestion: undefined },
			{
				step: 2,
				status: "partial",
				reason: "second",
				suggestion: "do x",
			},
			{ step: 3, status: "missing", reason: "third", suggestion: undefined },
		]);
	});

	it("tolerates code-fence wrapping", () => {
		const fenced = [
			"```json",
			JSON.stringify([{ step: 1, status: "done", reason: "x" }]),
			"```",
		].join("\n");
		const result = parseVerdictArray(fenced);
		expect(result).toHaveLength(1);
		expect(result?.[0]).toEqual({
			step: 1,
			status: "done",
			reason: "x",
			suggestion: undefined,
		});
	});

	it("drops malformed elements but keeps the rest", () => {
		// Caller (runVerify) cross-checks returned `step` numbers
		// against the expected plan, so silently dropping junk here
		// surfaces as "missing verdict for step N" upstream.
		const input = JSON.stringify([
			{ step: 1, status: "done", reason: "ok" },
			{ step: 2, status: "oops", reason: "bad status" }, // invalid
			"not an object", // invalid
			{ step: 3, status: "missing" }, // missing reason
			{ step: 4, status: "partial", reason: "good" },
		]);
		const result = parseVerdictArray(input);
		expect(result?.map((v) => v.step)).toEqual([1, 4]);
	});
});
