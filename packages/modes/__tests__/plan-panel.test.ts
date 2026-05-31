import { visibleWidth } from "@mariozechner/pi-tui";
import {
	boxify,
	buildCompactLines,
	buildTreeLines,
	deriveProgress,
	formatProgressLine,
	renderPlanPanel,
	STATUS_GLYPH,
	summarisePlan,
	windowLines,
} from "../plan/panel.js";
import type {
	Phase,
	PhaseStatus,
	Plan,
	Task,
	TaskKind,
} from "../plan/schema.js";

// Minimal theme that strips styling so assertions read on plain text.
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderPlanPanel>[1]["theme"];

const stripBox = (lines: string[]) =>
	lines.slice(1, -1).map((l) => l.replace(/[│╭╮╰╯]/g, "").trimEnd());

let taskSeq = 0;
function makeTask(
	title: string,
	done: boolean,
	kind: TaskKind = "deliverable",
): Task {
	taskSeq++;
	return {
		id: `t${taskSeq}`,
		title,
		body: "",
		done,
		kind,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function makePhase(
	title: string,
	status: PhaseStatus,
	tasks: Task[] = [],
	extra: Partial<Phase> = {},
): Phase {
	return {
		id: title.toLowerCase().replace(/\s+/g, "-"),
		title,
		goal: "",
		status,
		branch: `feat/${title.toLowerCase().replace(/\s+/g, "-")}`,
		tasks,
		dependsOn: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...extra,
	};
}

function makePlan(phases: Phase[], title = "Test plan"): Plan {
	return {
		slug: "test-plan",
		title,
		repo: { path: "/tmp/test" },
		schemaVersion: 3,
		phases,
		followUps: [],
		seenIn: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("summarisePlan", () => {
	it("counts done phases and locates the active one (1-based, all phases)", () => {
		const plan = makePlan([
			makePhase("Done", "shipped"),
			makePhase("Ready", "ready-to-ship"),
			makePhase("Working", "active"),
			makePhase("Later", "planned"),
		]);
		expect(summarisePlan(plan)).toEqual({
			donePhases: 2,
			totalPhases: 4,
			activeIndex: 3,
			activeTitle: "Working",
		});
	});

	it("reports no active phase when nothing owns a worktree", () => {
		const plan = makePlan([
			makePhase("Done", "shipped"),
			makePhase("Later", "planned"),
		]);
		expect(summarisePlan(plan)).toMatchObject({
			activeIndex: null,
			activeTitle: null,
		});
	});
});

describe("buildCompactLines", () => {
	it("renders title with a done/total tally and the active phase line", () => {
		const plan = makePlan([
			makePhase("Groundwork", "shipped"),
			makePhase("Build it", "active"),
			makePhase("Docs", "planned"),
		]);
		const lines = buildCompactLines(plan, theme, 38);
		expect(lines[0]).toContain("Test plan");
		expect(lines[0]).toContain("1/3");
		expect(lines[1]).toContain("● Build it");
	});

	it("omits the active line when there is no active phase", () => {
		const plan = makePlan([makePhase("Done", "shipped")]);
		expect(buildCompactLines(plan, theme, 38)).toHaveLength(1);
	});
});

describe("buildTreeLines", () => {
	it("maps each status to its glyph and renders task checkboxes", () => {
		const plan = makePlan([
			makePhase("Shipped phase", "shipped"),
			makePhase("Active phase", "active", [
				makeTask("done task", true),
				makeTask("todo task", false),
			]),
			makePhase("Planned phase", "planned"),
		]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body[0]).toContain(`${STATUS_GLYPH.shipped} Shipped phase`);
		expect(body[1]).toContain(`${STATUS_GLYPH.active} Active phase`);
		expect(body[2]).toContain("☑ done task");
		expect(body[3]).toContain("☐ todo task");
		expect(body[4]).toContain(`${STATUS_GLYPH.planned} Planned phase`);
	});

	it("annotates phases driven by another session with [peer]", () => {
		const plan = makePlan([
			makePhase("Peer phase", "active", [], { driverSessionId: "other" }),
		]);
		const body = buildTreeLines(plan, theme, 38, "me");
		expect(body[0]).toContain("[peer]");
	});

	it("does not annotate the local driver's own phase", () => {
		const plan = makePlan([
			makePhase("Mine", "active", [], { driverSessionId: "me" }),
		]);
		const body = buildTreeLines(plan, theme, 38, "me");
		expect(body[0]).not.toContain("[peer]");
	});

	it("shows an explicit placeholder for an active phase with no tasks", () => {
		const plan = makePlan([makePhase("Empty", "active", [])]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body[1]).toContain("(no tasks)");
	});

	it("hides tasks for non-worktree phases", () => {
		const plan = makePlan([
			makePhase("Planned", "planned", [makeTask("hidden", false)]),
		]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body).toHaveLength(1);
	});
});

describe("windowLines", () => {
	const lines = ["a", "b", "c", "d", "e"];

	it("returns everything and zero scroll when content fits", () => {
		const w = windowLines(lines, 0, 10);
		expect(w).toMatchObject({
			rows: lines,
			maxScroll: 0,
			clampedOffset: 0,
			atTop: true,
			atBottom: true,
		});
	});

	it("clamps an over-large offset to the bottom", () => {
		const w = windowLines(lines, 99, 3);
		expect(w.clampedOffset).toBe(2);
		expect(w.maxScroll).toBe(2);
		expect(w.rows).toEqual(["c", "d", "e"]);
		expect(w.atBottom).toBe(true);
		expect(w.atTop).toBe(false);
	});

	it("windows from the middle", () => {
		const w = windowLines(lines, 1, 3);
		expect(w.rows).toEqual(["b", "c", "d"]);
		expect(w.atTop).toBe(false);
		expect(w.atBottom).toBe(false);
	});

	it("treats a non-positive maxRows as a single row", () => {
		const w = windowLines(lines, 0, 0);
		expect(w.rows).toHaveLength(1);
		expect(w.maxScroll).toBe(4);
	});
});

describe("boxify", () => {
	it("draws a rounded border padded to the requested width", () => {
		const out = boxify(theme, "Title", [" body"], 20);
		expect(out).toHaveLength(3);
		for (const line of out) expect(line.length).toBe(20);
		expect(out[0]).toContain("Title");
		expect(out[0].startsWith("╭")).toBe(true);
		expect(out[2]).toBe(`╰${"─".repeat(18)}╯`);
	});
});

describe("renderPlanPanel", () => {
	const plan = makePlan([
		makePhase("Shipped", "shipped"),
		makePhase(
			"Active",
			"active",
			Array.from({ length: 12 }, (_, i) => makeTask(`task ${i}`, i < 2)),
		),
		makePhase("Planned", "planned"),
	]);

	it("renders the compact summary when collapsed", () => {
		const r = renderPlanPanel(plan, {
			theme,
			width: 40,
			expanded: false,
			focused: false,
			scrollOffset: 0,
			termHeight: 40,
		});
		expect(r.maxScroll).toBe(0);
		const body = stripBox(r.lines);
		expect(body[0]).toContain("Test plan");
		expect(body.some((l) => l.includes("☐"))).toBe(false);
	});

	it("renders the full tree with a hint footer when expanded and untruncated", () => {
		const r = renderPlanPanel(plan, {
			theme,
			width: 40,
			expanded: true,
			focused: false,
			scrollOffset: 0,
			termHeight: 60,
		});
		expect(r.maxScroll).toBe(0);
		const joined = r.lines.join("\n");
		expect(joined).toContain("☑ task 0");
		expect(joined).toContain("^⇧O scroll");
	});

	it("windows and clamps scroll on a short terminal, focused title + indicator", () => {
		const r = renderPlanPanel(plan, {
			theme,
			width: 40,
			expanded: true,
			focused: true,
			scrollOffset: 999,
			termHeight: 14,
		});
		expect(r.maxScroll).toBeGreaterThan(0);
		expect(r.scrollOffset).toBe(r.maxScroll);
		const joined = r.lines.join("\n");
		expect(joined).toContain("Plan · scroll");
		expect(joined).toContain("↑↓ scroll · Esc back");
		expect(joined).toContain("↑");
	});

	it("renders nothing implicitly via the component for an empty plan", () => {
		const r = renderPlanPanel(makePlan([]), {
			theme,
			width: 40,
			expanded: false,
			focused: false,
			scrollOffset: 0,
			termHeight: 40,
		});
		// summarise of an empty plan still produces a (titled) box; the
		// component short-circuits empties before calling render.
		expect(r.lines.length).toBeGreaterThan(0);
	});
});

describe("deriveProgress", () => {
	it("picks the first incomplete deliverable in the active phase", () => {
		const plan = makePlan([
			makePhase("Schema", "shipped"),
			makePhase("Build", "active", [
				makeTask("done", true),
				makeTask("the next thing", false),
				makeTask("a later thing", false),
			]),
			makePhase("Docs", "planned"),
		]);
		expect(deriveProgress(plan)).toEqual({
			task: "the next thing",
			phaseIndex: 2,
			phaseCount: 3,
		});
	});

	it("excludes abandoned phases from index and count", () => {
		const plan = makePlan([
			makePhase("Schema", "shipped"),
			makePhase("Dead", "abandoned"),
			makePhase("Build", "active", [makeTask("go", false)]),
			makePhase("Docs", "planned"),
		]);
		expect(deriveProgress(plan)).toMatchObject({
			phaseIndex: 2,
			phaseCount: 3,
		});
	});

	it("skips non-deliverable tasks", () => {
		const plan = makePlan([
			makePhase("Build", "active", [
				makeTask("a question", false, "question"),
				makeTask("real work", false, "deliverable"),
			]),
		]);
		expect(deriveProgress(plan)?.task).toBe("real work");
	});

	it("falls back to the phase title when no incomplete deliverable remains", () => {
		const plan = makePlan([
			makePhase("Build it", "active", [makeTask("done", true)]),
		]);
		expect(deriveProgress(plan)?.task).toBe("Build it");
	});

	it("returns null when there is no active phase", () => {
		const plan = makePlan([makePhase("Done", "shipped")]);
		expect(deriveProgress(plan)).toBeNull();
	});

	it("returns null when every phase is abandoned", () => {
		const plan = makePlan([makePhase("Dead", "abandoned")]);
		expect(deriveProgress(plan)).toBeNull();
	});
});

describe("formatProgressLine", () => {
	it("renders the marker, task, and [X/N] tally", () => {
		const line = formatProgressLine(
			{ task: "wire it up", phaseIndex: 2, phaseCount: 3 },
			theme,
			80,
		);
		expect(line).toBe("▸ wire it up [2/3]");
	});

	it("truncates the task but keeps the tally visible within width", () => {
		const line = formatProgressLine(
			{ task: "x".repeat(100), phaseIndex: 2, phaseCount: 3 },
			theme,
			30,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(line).toContain("[2/3]");
	});
});
