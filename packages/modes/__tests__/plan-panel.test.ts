import {
	boxify,
	buildTreeLines,
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

describe("buildTreeLines", () => {
	it("lists every phase with its glyph and a per-phase [done/total] tally", () => {
		const plan = makePlan([
			makePhase("Shipped phase", "shipped", [
				makeTask("a", true),
				makeTask("b", true),
				makeTask("c", true),
			]),
			makePhase("Active phase", "active", [
				makeTask("done task", true),
				makeTask("todo task", false),
			]),
			makePhase("Planned phase", "planned", [makeTask("later", false)]),
		]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body[0]).toContain(`${STATUS_GLYPH.shipped} Shipped phase`);
		expect(body[0]).toContain("[3/3]");
		// Active phase header carries its tally, then its checklist follows.
		expect(body[1]).toContain(`${STATUS_GLYPH.active} Active phase`);
		expect(body[1]).toContain("[1/2]");
		expect(body[2]).toContain("☑ done task");
		expect(body[3]).toContain("☐ todo task");
		expect(body[4]).toContain(`${STATUS_GLYPH.planned} Planned phase`);
		expect(body[4]).toContain("[0/1]");
	});

	it("auto-expands the active phase but not other phases", () => {
		const plan = makePlan([
			makePhase("Planned", "planned", [makeTask("hidden", false)]),
			makePhase("Active", "active", [makeTask("shown", false)]),
		]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body.some((l) => l.includes("hidden"))).toBe(false);
		expect(body.some((l) => l.includes("☐ shown"))).toBe(true);
	});

	it("expands a non-active phase whose id is in expandedPhaseIds", () => {
		const plan = makePlan([
			makePhase("Planned", "planned", [makeTask("reveal me", false)]),
		]);
		const body = buildTreeLines(plan, theme, 38, null, new Set(["planned"]));
		expect(body.some((l) => l.includes("☐ reveal me"))).toBe(true);
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
		expect(body[0]).toContain("[0/0]");
		expect(body[1]).toContain("(no tasks)");
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
	it("draws a rounded border padded to the requested width with a title", () => {
		const out = boxify(theme, "Title", [" body"], 20);
		expect(out).toHaveLength(3);
		for (const line of out) expect(line.length).toBe(20);
		expect(out[0]).toContain("Title");
		expect(out[0].startsWith("╭")).toBe(true);
		expect(out[2]).toBe(`╰${"─".repeat(18)}╯`);
	});

	it("draws a clean title-less top edge when title is empty", () => {
		const out = boxify(theme, "", [" body"], 20);
		expect(out[0]).toBe(`╭${"─".repeat(18)}╮`);
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

	it("renders the full phase list with per-phase tallies and a title-less border", () => {
		const r = renderPlanPanel(plan, {
			theme,
			width: 40,
			focused: false,
			scrollOffset: 0,
			termHeight: 40,
		});
		expect(r.maxScroll).toBe(0);
		// Title-less top border: a clean run of box-drawing characters.
		expect(r.lines[0]).toBe(`╭${"─".repeat(38)}╮`);
		const body = stripBox(r.lines);
		const joined = body.join("\n");
		expect(joined).toContain("● Active");
		expect(joined).toContain("[2/12]");
		expect(joined).toContain("☑ task 0");
		// No footer hint when everything fits and the panel isn't focused.
		expect(joined).not.toContain("scroll");
	});

	it("windows and shows a scroll hint when overflowing but not focused", () => {
		const r = renderPlanPanel(plan, {
			theme,
			width: 40,
			focused: false,
			scrollOffset: 0,
			termHeight: 8,
		});
		expect(r.maxScroll).toBeGreaterThan(0);
		const joined = r.lines.join("\n");
		expect(joined).toContain("^⇧O to scroll");
	});

	it("shows the focus hint and clamps scroll when focused", () => {
		const r = renderPlanPanel(plan, {
			theme,
			width: 40,
			focused: true,
			scrollOffset: 999,
			termHeight: 14,
		});
		expect(r.maxScroll).toBeGreaterThan(0);
		expect(r.scrollOffset).toBe(r.maxScroll);
		const joined = r.lines.join("\n");
		expect(joined).toContain("↑↓ scroll · Esc back");
	});

	it("still produces a box for an empty plan (component short-circuits empties)", () => {
		const r = renderPlanPanel(makePlan([]), {
			theme,
			width: 40,
			focused: false,
			scrollOffset: 0,
			termHeight: 40,
		});
		expect(r.lines.length).toBeGreaterThan(0);
	});
});
