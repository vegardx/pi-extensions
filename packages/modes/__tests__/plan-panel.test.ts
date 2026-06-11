import {
	boxify,
	buildTreeLines,
	isPhaseAttachable,
	PlanPanelComponent,
	phaseHeaderOffsets,
	planPanelBody,
	renderPlanPanel,
	STATUS_GLYPH,
	summarisePlan,
	windowLines,
} from "../plan/panel.js";
import type {
	Deliverable as Phase,
	DeliverableStatus as PhaseStatus,
	Plan,
	WorkItem as Task,
	WorkItemKind as TaskKind,
} from "../plan/schema.js";
import { deliverables } from "../plan/schema.js";

// Minimal theme that strips styling so assertions read on plain text.
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Parameters<typeof renderPlanPanel>[1]["theme"];

const stripBox = (lines: string[]) =>
	lines.slice(1, -1).map((l) => l.replace(/[│╭╮╰╯]/g, "").trimEnd());

let taskSeq = 0;
function makeTask(title: string, done: boolean, kind: TaskKind = "task"): Task {
	taskSeq++;
	return {
		type: "work-item" as const,
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
		type: "deliverable" as const,
		id: title.toLowerCase().replace(/\s+/g, "-"),
		title,
		body: "",
		status,
		branch: `feat/${title.toLowerCase().replace(/\s+/g, "-")}`,
		children: tasks,
		dependsOn: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...extra,
	};
}

function makePlan(nodes: Phase[], title = "Test plan"): Plan {
	return {
		slug: "test-plan",
		title,
		repo: { path: "/tmp/test" },
		schemaVersion: 3,
		nodes,
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

describe("planPanelBody", () => {
	const plan = makePlan([
		makePhase("One", "shipped"),
		makePhase("Two", "active", [makeTask("a", false)]),
		makePhase("Three", "planned"),
	]);

	it("returns border-free rows plus a passive focus hint", () => {
		const body = planPanelBody(plan, {
			theme,
			contentWidth: 40,
			maxBodyRows: 20,
			focused: false,
			scrollOffset: 0,
		});
		expect(body.rows.join("\n")).not.toMatch(/[│╭╮╰╯]/);
		expect(body.rows.some((r) => r.includes("One"))).toBe(true);
		expect(body.footer.hint).toContain("to open");
	});

	it("shows navigation hints when focused", () => {
		const body = planPanelBody(plan, {
			theme,
			contentWidth: 40,
			maxBodyRows: 20,
			focused: true,
			scrollOffset: 0,
			selectedIndex: 1,
		});
		expect(body.footer.hint).toContain("move");
	});

	it("clamps the window to maxBodyRows and reports scroll", () => {
		const big = makePlan(
			Array.from({ length: 30 }, (_, i) => makePhase(`P${i}`, "planned")),
		);
		const body = planPanelBody(big, {
			theme,
			contentWidth: 40,
			maxBodyRows: 5,
			focused: false,
			scrollOffset: 0,
		});
		expect(body.rows).toHaveLength(5);
		expect(body.maxScroll).toBeGreaterThan(0);
		expect(body.footer.scroll).toBeDefined();
	});
});

describe("PlanPanelComponent.renderBody", () => {
	it("returns empty rows for a null plan", () => {
		const c = new PlanPanelComponent({
			plan: null,
			theme,
			requestRender: () => {},
			onRequestUnfocus: () => {},
		});
		expect(c.renderBody(40, 10).rows).toEqual([]);
	});

	it("renders the tree without a border", () => {
		const c = new PlanPanelComponent({
			plan: makePlan([
				makePhase("Alpha", "shipped"),
				makePhase("Beta", "active"),
			]),
			theme,
			requestRender: () => {},
			onRequestUnfocus: () => {},
		});
		const { rows } = c.renderBody(40, 10);
		expect(rows.join("\n")).toContain("Alpha");
		expect(rows.join("\n")).toContain("Beta");
		expect(rows.join("\n")).not.toMatch(/[│╭╮╰╯]/);
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
		const body = buildTreeLines(
			plan,
			theme,
			38,
			undefined,
			new Set(["planned"]),
		);
		expect(body.some((l) => l.includes("☐ reveal me"))).toBe(true);
	});

	it("renders a live-peer badge for a phase in the driver-badge map", () => {
		const plan = makePlan([
			makePhase("Peer phase", "active", [], { driverSessionId: "other" }),
		]);
		const body = buildTreeLines(
			plan,
			theme,
			38,
			new Map([["peer-phase", "peer-live"]]),
		);
		expect(body[0]).toContain("◆ peer·live");
	});

	it("renders a stale-peer badge from the driver-badge map", () => {
		const plan = makePlan([
			makePhase("Peer phase", "active", [], { driverSessionId: "other" }),
		]);
		const body = buildTreeLines(
			plan,
			theme,
			38,
			new Map([["peer-phase", "peer-stale"]]),
		);
		expect(body[0]).toContain("◆ peer·stale");
	});

	it("renders a self badge from the driver-badge map", () => {
		const plan = makePlan([
			makePhase("Mine", "active", [], { driverSessionId: "me" }),
		]);
		const body = buildTreeLines(plan, theme, 38, new Map([["mine", "self"]]));
		expect(body[0]).toContain("◆ self");
		expect(body[0]).not.toContain("peer");
	});

	it("renders no driver badge when the phase is absent from the map", () => {
		const plan = makePlan([makePhase("Lonely", "active", [])]);
		const body = buildTreeLines(plan, theme, 38, new Map());
		expect(body[0]).not.toContain("◆");
	});

	it("shows an explicit placeholder for an active phase with no tasks", () => {
		const plan = makePlan([makePhase("Empty", "active", [])]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body[0]).toContain("[0/0]");
		expect(body[1]).toContain("(no tasks)");
	});

	it("marks the selected phase with a cursor bar when selectedIndex is set", () => {
		const plan = makePlan([
			makePhase("First", "planned"),
			makePhase("Second", "planned"),
		]);
		const body = buildTreeLines(plan, theme, 38, undefined, undefined, 1);
		expect(body[0]).not.toContain("▌");
		expect(body[1]).toContain("▌");
	});

	it("draws no cursor when selectedIndex is undefined", () => {
		const plan = makePlan([makePhase("Only", "planned")]);
		const body = buildTreeLines(plan, theme, 38);
		expect(body[0]).not.toContain("▌");
	});
});

describe("phaseHeaderOffsets", () => {
	it("accounts for the auto-expanded active phase's task rows", () => {
		const plan = makePlan([
			makePhase("A", "planned"),
			makePhase("B", "active", [makeTask("x", false), makeTask("y", false)]),
			makePhase("C", "planned"),
		]);
		// A header at 0; B header at 1, two task rows at 2-3; C header at 4.
		expect(phaseHeaderOffsets(plan)).toEqual([0, 1, 4]);
	});

	it("counts an explicitly expanded phase's rows", () => {
		const plan = makePlan([
			makePhase("A", "planned", [makeTask("x", false)]),
			makePhase("B", "planned"),
		]);
		expect(phaseHeaderOffsets(plan, new Set(["a"]))).toEqual([0, 2]);
	});

	it("reserves one row for an expanded phase with no tasks", () => {
		const plan = makePlan([
			makePhase("Empty", "active", []),
			makePhase("Next", "planned"),
		]);
		expect(phaseHeaderOffsets(plan)).toEqual([0, 2]);
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

	it("embeds a right-aligned hint into the bottom edge", () => {
		const out = boxify(theme, "", [" body"], 24, { hint: "hi" });
		expect(out[2].length).toBe(24);
		expect(out[2].startsWith("╰")).toBe(true);
		expect(out[2].endsWith("╯")).toBe(true);
		expect(out[2]).toContain("hi");
		// Hint hugs the right edge: hint then a single trailing dash.
		expect(out[2]).toContain("hi ─╯");
	});

	it("embeds the scroll indicator on the bottom-left of the edge", () => {
		const out = boxify(theme, "", [" body"], 30, {
			scroll: "↑1 ↓2",
			hint: "hi",
		});
		expect(out[2].length).toBe(30);
		expect(out[2]).toContain("↑1 ↓2");
		expect(out[2]).toContain("hi");
		// Scroll sits at the left, hint at the right.
		expect(out[2].indexOf("↑1 ↓2")).toBeLessThan(out[2].indexOf("hi"));
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
		// The focus hint is always discoverable — embedded in the bottom border
		// even when the plan fits and the panel is passive.
		expect(r.lines.at(-1)).toContain("^⇧P to open");
		// No scroll indicator when nothing overflows.
		expect(r.lines.at(-1)).not.toContain("↑");
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
		const bottom = r.lines.at(-1) ?? "";
		expect(bottom).toContain("^⇧P to open");
		// Scroll indicator rides the bottom-left of the same edge when overflowing.
		expect(bottom).toContain("↑");
		expect(bottom).toContain("↓");
	});

	it("shows the focus/navigate hint and clamps scroll when focused", () => {
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
		expect(joined).toContain("↑↓ move · → expand · Esc close");
	});

	it("swaps in the attach hint when the cursor sits on a peer phase", () => {
		const peerPlan = makePlan([
			makePhase("Peer", "active", [], {
				driverSessionId: "other",
				sessionPath: "/tmp/other.jsonl",
			}),
		]);
		const r = renderPlanPanel(peerPlan, {
			theme,
			width: 44,
			focused: true,
			scrollOffset: 0,
			termHeight: 14,
			selectedIndex: 0,
			driverBadges: new Map([["peer", "peer-live"]]),
		});
		expect(r.lines.join("\n")).toContain("⏎ attach agent");
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

describe("PlanPanelComponent navigation", () => {
	const KEY = {
		up: "\x1b[A",
		down: "\x1b[B",
		right: "\x1b[C",
		left: "\x1b[D",
		return: "\r",
		escape: "\x1b",
	};

	function mount(
		plan: Plan,
		opts: {
			onAttachPhase?: (phaseId: string) => void;
		} = {},
	) {
		let unfocused = 0;
		const component = new PlanPanelComponent({
			plan,
			theme,
			requestRender: () => {},
			onRequestUnfocus: () => {
				unfocused++;
			},
			onAttachPhase: opts.onAttachPhase,
		});
		// Prime the cached viewport metrics the way the host does on render.
		component.setViewportHeight(40);
		component.render(40);
		return { component, unfocused: () => unfocused };
	}

	function bodyOf(component: PlanPanelComponent): string {
		return component.render(40).join("\n");
	}

	it("defaults the cursor to the active phase on focus", () => {
		const { component } = mount(
			makePlan([
				makePhase("First", "shipped"),
				makePhase("Active", "active"),
				makePhase("Last", "planned"),
			]),
		);
		component.setFocused(true);
		expect(component.selectedIndex).toBe(1);
	});

	it("moves the cursor with up/down and clamps at the ends", () => {
		const { component } = mount(
			makePlan([
				makePhase("A", "planned"),
				makePhase("B", "planned"),
				makePhase("C", "planned"),
			]),
		);
		component.setFocused(true);
		expect(component.selectedIndex).toBe(0);
		component.handleInput(KEY.up); // already at top — clamp
		expect(component.selectedIndex).toBe(0);
		component.handleInput(KEY.down);
		component.handleInput(KEY.down);
		expect(component.selectedIndex).toBe(2);
		component.handleInput(KEY.down); // at bottom — clamp
		expect(component.selectedIndex).toBe(2);
	});

	it("expands and collapses the selected phase with right/left", () => {
		const { component } = mount(
			makePlan([makePhase("Planned", "planned", [makeTask("hidden", false)])]),
		);
		component.setFocused(true);
		expect(bodyOf(component)).not.toContain("hidden");
		component.handleInput(KEY.right);
		expect(bodyOf(component)).toContain("☐ hidden");
		component.handleInput(KEY.left);
		expect(bodyOf(component)).not.toContain("hidden");
	});

	it("keeps the selected phase visible by scrolling on a tall plan", () => {
		const phases = Array.from({ length: 30 }, (_, i) =>
			makePhase(`Phase ${i}`, "planned"),
		);
		const { component } = mount(makePlan(phases));
		component.setViewportHeight(10);
		component.render(40);
		component.setFocused(true);
		for (let i = 0; i < 20; i++) component.handleInput(KEY.down);
		expect(component.selectedIndex).toBe(20);
		// The selected phase's header line must be inside the rendered window.
		expect(bodyOf(component)).toContain("Phase 20");
	});

	it("releases focus on escape", () => {
		const { component, unfocused } = mount(
			makePlan([makePhase("A", "planned")]),
		);
		component.setFocused(true);
		component.handleInput(KEY.escape);
		expect(unfocused()).toBe(1);
	});

	it("clears expanded phases when swapped to a different plan", () => {
		const { component } = mount(
			makePlan([makePhase("Shared", "planned", [makeTask("hidden", false)])]),
		);
		component.setFocused(true);
		component.handleInput(KEY.right); // expand "shared"
		expect(bodyOf(component)).toContain("☐ hidden");
		// A different plan that happens to reuse the same phase id must not
		// inherit the expanded state.
		const other = makePlan(
			[makePhase("Shared", "planned", [makeTask("hidden", false)])],
			"Other plan",
		);
		other.slug = "other-plan";
		component.setPlan(other);
		expect(bodyOf(component)).not.toContain("hidden");
	});

	it("keeps expanded phases when refreshed with the same plan", () => {
		const plan = makePlan([
			makePhase("Shared", "planned", [makeTask("hidden", false)]),
		]);
		const { component } = mount(plan);
		component.setFocused(true);
		component.handleInput(KEY.right);
		expect(bodyOf(component)).toContain("☐ hidden");
		component.setPlan(makePlan(deliverables(plan))); // same slug "test-plan"
		expect(bodyOf(component)).toContain("☐ hidden");
	});

	it("routes ⏎ to onAttachPhase for a peer-driven phase", () => {
		const attached: string[] = [];
		const { component } = mount(
			makePlan([
				makePhase("Peer", "active", [], {
					driverSessionId: "other",
					sessionPath: "/tmp/other.jsonl",
				}),
			]),
			{ onAttachPhase: (id) => attached.push(id) },
		);
		component.setDriverBadges(new Map([["peer", "peer-live"]]));
		component.setFocused(true);
		component.handleInput(KEY.return);
		expect(attached).toEqual(["peer"]);
	});

	it("falls back to expand on ⏎ for a non-attachable phase", () => {
		const attached: string[] = [];
		const { component } = mount(
			makePlan([makePhase("Planned", "planned", [makeTask("hidden", false)])]),
			{ onAttachPhase: (id) => attached.push(id) },
		);
		component.setFocused(true);
		expect(bodyOf(component)).not.toContain("hidden");
		component.handleInput(KEY.return);
		expect(attached).toEqual([]);
		expect(bodyOf(component)).toContain("☐ hidden");
	});
});

describe("isPhaseAttachable", () => {
	it("is true for a peer phase with a session path", () => {
		const plan = makePlan([
			makePhase("Peer", "active", [], { sessionPath: "/tmp/p.jsonl" }),
		]);
		expect(isPhaseAttachable(plan, 0, new Map([["peer", "peer-live"]]))).toBe(
			true,
		);
		expect(isPhaseAttachable(plan, 0, new Map([["peer", "peer-stale"]]))).toBe(
			true,
		);
	});

	it("is false for self, missing session path, or undefined selection", () => {
		const withPath = makePlan([
			makePhase("Self", "active", [], { sessionPath: "/tmp/p.jsonl" }),
		]);
		expect(isPhaseAttachable(withPath, 0, new Map([["self", "self"]]))).toBe(
			false,
		);
		const noPath = makePlan([makePhase("Peer", "active")]);
		expect(isPhaseAttachable(noPath, 0, new Map([["peer", "peer-live"]]))).toBe(
			false,
		);
		expect(
			isPhaseAttachable(withPath, undefined, new Map([["self", "peer-live"]])),
		).toBe(false);
	});
});
