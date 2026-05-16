import {
	applyExecutionMode,
	computeActiveTools,
	EXPLORE_TOOLS,
	PLAN_ONLY_TOOLS,
} from "../index.js";

const FULL_TOOLS = [
	"read",
	"bash",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"websearch",
	"ask",
	"research",
	...EXPLORE_TOOLS,
];

describe("computeActiveTools — plan mode", () => {
	it("returns only PLAN_ONLY_TOOLS + phase/task/plan (no write/edit)", () => {
		const tools = computeActiveTools("plan", FULL_TOOLS);
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("edit");
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("phase");
		expect(tools).toContain("task");
		expect(tools).toContain("plan");
	});

	it("contains all PLAN_ONLY_TOOLS entries", () => {
		const tools = computeActiveTools("plan", FULL_TOOLS);
		for (const t of PLAN_ONLY_TOOLS) {
			expect(tools).toContain(t);
		}
	});
});

describe("computeActiveTools — auto/ask/hack mode", () => {
	it("restores write and edit from priorTools", () => {
		const tools = computeActiveTools("auto", FULL_TOOLS);
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
	});

	it("strips explore_* tools", () => {
		const tools = computeActiveTools("auto", FULL_TOOLS);
		for (const t of EXPLORE_TOOLS) {
			expect(tools).not.toContain(t);
		}
	});

	it("always includes phase/task/plan and research even if absent from priorTools", () => {
		// Simulate priorTools that pre-date plan support.
		const priorWithout = ["read", "bash", "write", "edit"];
		const tools = computeActiveTools("ask", priorWithout);
		expect(tools).toContain("phase");
		expect(tools).toContain("task");
		expect(tools).toContain("plan");
		expect(tools).toContain("research");
	});

	it("does not duplicate phase/task/plan when already in priorTools", () => {
		const priorWith = [...FULL_TOOLS, "phase", "task", "plan"];
		const tools = computeActiveTools("auto", priorWith);
		const count = (name: string) => tools.filter((t) => t === name).length;
		expect(count("phase")).toBe(1);
		expect(count("task")).toBe(1);
		expect(count("plan")).toBe(1);
	});

	it("hack mode: same as auto — write/edit present, explore_* absent", () => {
		const tools = computeActiveTools("hack", FULL_TOOLS);
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
		for (const t of EXPLORE_TOOLS) {
			expect(tools).not.toContain(t);
		}
	});
});

describe("plan → executing transition (regression)", () => {
	it("priorTools captured in plan mode still include write/edit after mode flip", () => {
		// Simulates the bug: if priorTools was captured while plan mode was
		// active, the old code returned PLAN_ONLY_TOOLS on restore because
		// applyModeTools was never called in launchExecution. The pure
		// function must return the full set when mode !== "plan".
		const priorToolsCapturedBeforePlanMode = [
			"read",
			"bash",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
			"websearch",
			"ask",
			"research",
		];
		const tools = computeActiveTools("auto", priorToolsCapturedBeforePlanMode);
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
	});
});

// ---------------------------------------------------------------------------
// applyExecutionMode — plan → executing transition
// ---------------------------------------------------------------------------

const FULL_TOOLS_FOR_EXEC = [
	"read",
	"bash",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"websearch",
	"ask",
	"research",
	...EXPLORE_TOOLS,
];

describe("applyExecutionMode", () => {
	it("mutates state.mode to the given implementMode", () => {
		const state = { mode: "plan", priorTools: FULL_TOOLS_FOR_EXEC };
		applyExecutionMode(state, "auto", vi.fn());
		expect(state.mode).toBe("auto");
	});

	it("calls setActiveTools exactly once with write and edit (auto)", () => {
		const state = { mode: "plan", priorTools: FULL_TOOLS_FOR_EXEC };
		const spy = vi.fn();
		applyExecutionMode(state, "auto", spy);
		expect(spy).toHaveBeenCalledOnce();
		const [tools] = spy.mock.calls[0] as [string[]];
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
	});

	it("calls setActiveTools with write and edit (ask)", () => {
		const state = { mode: "plan", priorTools: FULL_TOOLS_FOR_EXEC };
		const spy = vi.fn();
		applyExecutionMode(state, "ask", spy);
		const [tools] = spy.mock.calls[0] as [string[]];
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
		expect(state.mode).toBe("ask");
	});

	it("strips explore_* tools from the active set", () => {
		const state = { mode: "plan", priorTools: FULL_TOOLS_FOR_EXEC };
		const spy = vi.fn();
		applyExecutionMode(state, "auto", spy);
		const [tools] = spy.mock.calls[0] as [string[]];
		for (const t of EXPLORE_TOOLS) {
			expect(tools).not.toContain(t);
		}
	});

	it("works when transitioning from a non-plan mode (e.g. /implement from ask)", () => {
		const state = { mode: "ask", priorTools: FULL_TOOLS_FOR_EXEC };
		const spy = vi.fn();
		applyExecutionMode(state, "auto", spy);
		const [tools] = spy.mock.calls[0] as [string[]];
		expect(tools).toContain("write");
		expect(tools).toContain("edit");
	});
});
