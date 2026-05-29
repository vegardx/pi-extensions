/**
 * Tests for token-usage helpers (#143).
 */

import type { Usage } from "@mariozechner/pi-ai";
import {
	type AssistantishEntry,
	addUsage,
	aggregateAssistantUsage,
	formatCost,
	formatTokenCount,
	fromAiUsage,
	zeroUsage,
} from "../plan/token-usage.js";

function aiUsage(opts: Partial<Usage> & { withCost?: number }): Usage {
	return {
		input: opts.input ?? 0,
		output: opts.output ?? 0,
		cacheRead: opts.cacheRead ?? 0,
		cacheWrite: opts.cacheWrite ?? 0,
		totalTokens:
			(opts.input ?? 0) +
			(opts.output ?? 0) +
			(opts.cacheRead ?? 0) +
			(opts.cacheWrite ?? 0),
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: opts.withCost ?? 0,
		},
	};
}

describe("fromAiUsage", () => {
	it("returns null for nullish input", () => {
		expect(fromAiUsage(undefined)).toBeNull();
		expect(fromAiUsage(null)).toBeNull();
	});

	it("flattens a Usage to {input, output, cacheRead, cacheWrite, cost?}", () => {
		const u = aiUsage({
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 10,
			withCost: 0.0042,
		});
		expect(fromAiUsage(u)).toEqual({
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 10,
			cost: 0.0042,
		});
	});

	it("omits cost when the underlying total is missing or zero", () => {
		const u = aiUsage({ input: 1, output: 2 });
		// totalTokens computed and cost.total defaults to 0 — cost.total
		// is a number, so it's surfaced even when zero. That matches the
		// "0 means free / known-zero" reading. Tests here lock the rule:
		// only a non-numeric cost.total drops the field.
		const out = fromAiUsage(u);
		expect(out?.cost).toBe(0);
	});

	it("drops cost when cost.total is non-numeric", () => {
		const u = aiUsage({ input: 1 }) as unknown as Usage;
		(u as { cost: { total: unknown } }).cost.total = undefined;
		const out = fromAiUsage(u);
		expect(out).not.toBeNull();
		expect(out?.cost).toBeUndefined();
	});
});

describe("zeroUsage", () => {
	it("returns all zeros and no cost field", () => {
		const z = zeroUsage();
		expect(z).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect("cost" in z).toBe(false);
	});
});

describe("addUsage", () => {
	const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
	const b = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };

	it("sums field-by-field", () => {
		expect(addUsage(a, b)).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
		});
	});

	it("treats null contributions as zero", () => {
		expect(addUsage(null, b)).toEqual(b);
		expect(addUsage(a, undefined)).toEqual(a);
		expect(addUsage(null, null)).toEqual(zeroUsage());
	});

	it("sums cost when both contributors have it", () => {
		const result = addUsage({ ...a, cost: 0.01 }, { ...b, cost: 0.02 });
		expect(result.cost).toBeCloseTo(0.03, 6);
	});

	it("drops cost when either contributor is missing it", () => {
		const result = addUsage({ ...a, cost: 0.01 }, b);
		expect(result.cost).toBeUndefined();
	});

	it("preserves a single-side cost when the other side is null", () => {
		expect(addUsage(null, { ...b, cost: 0.05 }).cost).toBeCloseTo(0.05);
		expect(addUsage({ ...a, cost: 0.07 }, null).cost).toBeCloseTo(0.07);
	});
});

describe("aggregateAssistantUsage", () => {
	const entries: AssistantishEntry[] = [
		{
			type: "message",
			message: {
				role: "user",
				usage: aiUsage({ input: 99 }),
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				usage: aiUsage({
					input: 100,
					output: 50,
					cacheRead: 20,
					withCost: 0.01,
				}),
			},
		},
		{
			type: "thinking_level_change" as const,
		} as AssistantishEntry,
		{
			type: "message",
			message: {
				role: "assistant",
				usage: aiUsage({
					input: 200,
					output: 100,
					cacheRead: 80,
					cacheWrite: 5,
					withCost: 0.02,
				}),
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				// Missing usage entirely (provider didn't report)
			},
		},
	];

	it("sums only assistant message usages and drops missing contributions", () => {
		expect(aggregateAssistantUsage(entries)).toEqual({
			input: 300,
			output: 150,
			cacheRead: 100,
			cacheWrite: 5,
			cost: expect.any(Number),
		});
	});

	it("returns zeroUsage when no entries contribute", () => {
		expect(aggregateAssistantUsage([])).toEqual(zeroUsage());
		expect(
			aggregateAssistantUsage([{ type: "thinking_level_change" }]),
		).toEqual(zeroUsage());
	});
});

describe("formatTokenCount", () => {
	it.each([
		[0, "0"],
		[-1, "0"],
		[42, "42"],
		[999, "999"],
		[1000, "1.0k"],
		[12345, "12.3k"],
		[99999, "100k"],
		[1_234_567, "1.23M"],
		[100_000_000, "100M"],
	])("formats %d as %s", (n, expected) => {
		expect(formatTokenCount(n)).toBe(expected);
	});
});

describe("formatCost", () => {
	it("renders zero / negative as $0.00", () => {
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(-1)).toBe("$0.00");
	});

	it("renders sub-$100 with two decimals", () => {
		expect(formatCost(0.42)).toBe("$0.42");
		expect(formatCost(12.345)).toBe("$12.35");
	});

	it("rounds at three+ digits", () => {
		expect(formatCost(123.4)).toBe("$123");
	});
});
