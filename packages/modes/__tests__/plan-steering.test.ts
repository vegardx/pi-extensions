import { describe, expect, it } from "vitest";
import type { Phase, PhaseStatus, Plan } from "../plan/schema.js";
import { buildSteeringPreamble } from "../plan/steering.js";

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		id: "p-active",
		title: "Active phase",
		goal: "ship something",
		status: "active",
		branch: "feat/p-active",
		tasks: [
			{
				id: "t-one",
				title: "First task",
				body: "",
				done: true,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "t-two",
				title: "Second task",
				body: "",
				done: false,
				createdAt: now,
				updatedAt: now,
			},
		],
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makePlan(phases: Phase[]): Plan {
	const now = new Date().toISOString();
	return {
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/tmp/repo" },
		phases,
		createdAt: now,
		updatedAt: now,
	};
}

describe("buildSteeringPreamble", () => {
	it("wraps an interactive auto-mode message with phase context", () => {
		const result = buildSteeringPreamble({
			text: "also add retry-with-jitter",
			source: "interactive",
			mode: "auto",
			plan: makePlan([makePhase()]),
		});
		expect(result).not.toBeNull();
		expect(result).toContain("steering message");
		expect(result).toContain("p-active — Active phase (active)");
		expect(result).toContain("✓ t-one — First task");
		expect(result).toContain("○ t-two — Second task");
		expect(result?.endsWith("also add retry-with-jitter")).toBe(true);
	});

	it("wraps when the in-flight phase is needs-attention", () => {
		const phase = makePhase({ status: "needs-attention" });
		const result = buildSteeringPreamble({
			text: "fix the off-by-one",
			source: "interactive",
			mode: "auto",
			plan: makePlan([phase]),
		});
		expect(result).not.toBeNull();
		expect(result).toContain("(needs-attention)");
	});

	it("renders '(no tasks yet)' when the active phase has no tasks", () => {
		const phase = makePhase({ tasks: [] });
		const result = buildSteeringPreamble({
			text: "hi",
			source: "interactive",
			mode: "auto",
			plan: makePlan([phase]),
		});
		expect(result).toContain("(no tasks yet)");
	});

	it.each<[SteeringMode | null, string]>([
		["plan", "plan mode"],
		["ask", "ask mode"],
		[null, "no mode"],
	])("returns null in %s", (mode) => {
		const result = buildSteeringPreamble({
			text: "anything",
			source: "interactive",
			mode,
			plan: makePlan([makePhase()]),
		});
		expect(result).toBeNull();
	});

	it("returns null for extension-sourced messages", () => {
		const result = buildSteeringPreamble({
			text: "internal notification",
			source: "extension",
			mode: "auto",
			plan: makePlan([makePhase()]),
		});
		expect(result).toBeNull();
	});

	it("returns null for slash commands (incl. leading whitespace)", () => {
		expect(
			buildSteeringPreamble({
				text: "/ship",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBeNull();
		expect(
			buildSteeringPreamble({
				text: "  /skill:exa-search look up X",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBeNull();
	});

	it("returns null for empty / whitespace-only messages", () => {
		expect(
			buildSteeringPreamble({
				text: "",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBeNull();
		expect(
			buildSteeringPreamble({
				text: "   \n  ",
				source: "interactive",
				mode: "auto",
				plan: makePlan([makePhase()]),
			}),
		).toBeNull();
	});

	it("returns null when no plan is present", () => {
		expect(
			buildSteeringPreamble({
				text: "do the thing",
				source: "interactive",
				mode: "auto",
				plan: null,
			}),
		).toBeNull();
	});

	it("returns null when no phase is in flight", () => {
		const allPlanned: PhaseStatus[] = ["planned", "shipped", "abandoned"];
		const phases = allPlanned.map((status, i) =>
			makePhase({ id: `p-${i}`, status }),
		);
		expect(
			buildSteeringPreamble({
				text: "do the thing",
				source: "interactive",
				mode: "auto",
				plan: makePlan(phases),
			}),
		).toBeNull();
	});

	it("preserves the original text byte-for-byte after the preamble", () => {
		const text = "Multi-line\n  message with `backticks` and emoji 🚀";
		const result = buildSteeringPreamble({
			text,
			source: "interactive",
			mode: "auto",
			plan: makePlan([makePhase()]),
		});
		expect(result).not.toBeNull();
		expect(result?.endsWith(`\n\n${text}`)).toBe(true);
	});
});

type SteeringMode = "plan" | "ask" | "auto";
