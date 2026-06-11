import { formatRelativeTime, renderPlanListView } from "../plan/list-view.js";
import {
	isPlanStuck,
	isStuckDeliverable,
	type Deliverable as Phase,
	type DeliverableStatus as PhaseStatus,
	type Plan,
} from "../plan/schema.js";

const T0 = "2026-01-01T00:00:00.000Z";

function phase(
	id: string,
	status: PhaseStatus,
	overrides: Partial<Phase> = {},
): Phase {
	return {
		type: "deliverable" as const,
		id,
		title: id,
		body: "",
		status,
		branch: `feat/${id}`,
		children: [],
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

function plan(overrides: Partial<Plan> = {}): Plan {
	return {
		slug: "p",
		title: "P",
		repo: { path: "/r" },
		nodes: [],
		createdAt: T0,
		updatedAt: T0,
		...overrides,
	};
}

describe("isStuckDeliverable", () => {
	it("is true only for in-review without prNumber", () => {
		expect(isStuckDeliverable(phase("p", "in-review"))).toBe(true);
		expect(isStuckDeliverable(phase("p", "in-review", { prNumber: 42 }))).toBe(
			false,
		);
	});

	it.each<PhaseStatus>([
		"planned",
		"active",
		"needs-attention",
		"ready-to-ship",
		"shipped",
		"abandoned",
	])("is false for %s regardless of prNumber", (status) => {
		expect(isStuckDeliverable(phase("p", status))).toBe(false);
		expect(isStuckDeliverable(phase("p", status, { prNumber: 1 }))).toBe(false);
	});
});

describe("isPlanStuck", () => {
	it("is true when every non-terminal phase is stuck", () => {
		expect(isPlanStuck(plan({ nodes: [phase("p-1", "in-review")] }))).toBe(
			true,
		);
	});

	it("is true when stuck phases coexist with terminal phases", () => {
		expect(
			isPlanStuck(
				plan({
					nodes: [phase("p-1", "shipped"), phase("p-2", "in-review")],
				}),
			),
		).toBe(true);
	});

	it("is false when a non-terminal phase is progressable", () => {
		expect(
			isPlanStuck(
				plan({
					nodes: [phase("p-1", "in-review"), phase("p-2", "active")],
				}),
			),
		).toBe(false);
		expect(
			isPlanStuck(
				plan({
					nodes: [phase("p-1", "in-review", { prNumber: 7 })],
				}),
			),
		).toBe(false);
	});

	it("is false for fully-terminal plans", () => {
		expect(
			isPlanStuck(
				plan({
					nodes: [phase("p-1", "shipped"), phase("p-2", "abandoned")],
				}),
			),
		).toBe(false);
	});

	it("is false for empty plans", () => {
		expect(isPlanStuck(plan({ nodes: [] }))).toBe(false);
	});
});

describe("formatRelativeTime", () => {
	const NOW = Date.parse("2026-06-01T12:00:00.000Z");

	it.each([
		["just now", NOW - 30_000],
		["3m ago", NOW - 3 * 60_000],
		["2h ago", NOW - 2 * 3600_000],
		["3d ago", NOW - 3 * 86_400_000],
		["2w ago", NOW - 14 * 86_400_000],
	])("returns %s for the matching delta", (expected, then) => {
		expect(formatRelativeTime(new Date(then).toISOString(), NOW)).toBe(
			expected,
		);
	});

	it("clamps future timestamps to 'just now'", () => {
		expect(formatRelativeTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe(
			"just now",
		);
	});

	it("returns '?' for unparseable input", () => {
		expect(formatRelativeTime("not-a-date", NOW)).toBe("?");
	});
});

describe("renderPlanListView", () => {
	const NOW = Date.parse("2026-06-01T12:00:00.000Z");
	const SESSION = "s-current";
	const CWD = "/r";

	it("returns 'no plans yet' for an empty list", () => {
		expect(
			renderPlanListView({
				plans: [],
				currentSessionId: SESSION,
				currentCwd: CWD,
				now: NOW,
			}),
		).toEqual(["no plans yet"]);
	});

	it("groups by ownership and sorts newest-first within each group", () => {
		const mineNew = plan({
			slug: "mine-new",
			title: "Mine new",
			updatedAt: new Date(NOW - 60_000).toISOString(),
			createdBy: { sessionId: SESSION },
			seenIn: [SESSION],
			nodes: [phase("p-1", "active")],
		});
		const mineOld = plan({
			slug: "mine-old",
			title: "Mine old",
			updatedAt: new Date(NOW - 86_400_000).toISOString(),
			createdBy: { sessionId: "s-other" },
			seenIn: ["s-other", SESSION],
			nodes: [phase("p-1", "shipped")],
		});
		const others = plan({
			slug: "others",
			title: "Theirs",
			updatedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
			createdBy: { sessionId: "s-them", sessionName: "work" },
			seenIn: ["s-them"],
			nodes: [phase("p-1", "active")],
		});
		const legacy = plan({
			slug: "legacy",
			title: "Old",
			updatedAt: new Date(NOW - 14 * 86_400_000).toISOString(),
			nodes: [phase("p-1", "shipped")],
		});

		const lines = renderPlanListView({
			plans: [legacy, others, mineOld, mineNew],
			currentSessionId: SESSION,
			currentCwd: CWD,
			now: NOW,
		});

		const text = lines.join("\n");
		// Section headers present and ordered
		const idxThis = text.indexOf("This session:");
		const idxOther = text.indexOf("Other sessions:");
		const idxLegacy = text.indexOf("Legacy (no owner):");
		expect(idxThis).toBeGreaterThan(0);
		expect(idxOther).toBeGreaterThan(idxThis);
		expect(idxLegacy).toBeGreaterThan(idxOther);

		// Within "This session": newest-first → mine-new before mine-old
		const idxMineNew = text.indexOf("mine-new");
		const idxMineOld = text.indexOf("mine-old");
		expect(idxMineNew).toBeGreaterThan(idxThis);
		expect(idxMineOld).toBeGreaterThan(idxMineNew);
		expect(idxMineOld).toBeLessThan(idxOther);
	});

	it("annotates stuck plans with the ⊘ glyph and the action hint", () => {
		const stuck = plan({
			slug: "stuck",
			title: "Stuck plan",
			createdBy: { sessionId: SESSION },
			seenIn: [SESSION],
			nodes: [phase("p-1", "in-review"), phase("p-2", "shipped")],
			updatedAt: new Date(NOW - 60_000).toISOString(),
		});
		const lines = renderPlanListView({
			plans: [stuck],
			currentSessionId: SESSION,
			currentCwd: CWD,
			now: NOW,
		});
		const stuckLine = lines.find((l) => l.includes("stuck"));
		expect(stuckLine).toContain("⊘");
		expect(stuckLine).toContain("stuck — open a PR or /plan archive");
	});

	it("marks plans for the current cwd with (this repo)", () => {
		const here = plan({
			slug: "here",
			title: "Here",
			repo: { path: CWD },
			createdBy: { sessionId: SESSION },
			seenIn: [SESSION],
			nodes: [phase("p-1", "active")],
		});
		const elsewhere = plan({
			slug: "elsewhere",
			title: "Elsewhere",
			repo: { path: "/other" },
			createdBy: { sessionId: SESSION },
			seenIn: [SESSION],
			nodes: [phase("p-1", "active")],
		});
		const lines = renderPlanListView({
			plans: [here, elsewhere],
			currentSessionId: SESSION,
			currentCwd: CWD,
			now: NOW,
		});
		expect(lines.find((l) => l.includes(" here — "))).toContain("(this repo)");
		expect(lines.find((l) => l.includes(" elsewhere — "))).not.toContain(
			"(this repo)",
		);
	});

	it("shows owner label only in the Other sessions group", () => {
		const mine = plan({
			slug: "mine",
			title: "Mine",
			createdBy: { sessionId: SESSION, sessionName: "self" },
			seenIn: [SESSION],
			nodes: [phase("p-1", "active")],
		});
		const theirs = plan({
			slug: "theirs",
			title: "Theirs",
			createdBy: { sessionId: "s-them", sessionName: "work" },
			seenIn: ["s-them"],
			nodes: [phase("p-1", "active")],
		});
		const lines = renderPlanListView({
			plans: [mine, theirs],
			currentSessionId: SESSION,
			currentCwd: CWD,
			now: NOW,
		});
		const mineLine = lines.find((l) => l.includes("mine"));
		const theirsLine = lines.find((l) => l.includes("theirs"));
		expect(mineLine).not.toContain("by ");
		expect(theirsLine).toContain("by s-them (work)");
	});

	it("classifies plans without createdBy as Legacy", () => {
		const legacy = plan({
			slug: "legacy",
			title: "Legacy",
			nodes: [phase("p-1", "active")],
		});
		const lines = renderPlanListView({
			plans: [legacy],
			currentSessionId: SESSION,
			currentCwd: CWD,
			now: NOW,
		});
		const text = lines.join("\n");
		expect(text).toContain("Legacy (no owner):");
		expect(text).not.toContain("This session:");
		expect(text).not.toContain("Other sessions:");
	});

	it("omits empty groups", () => {
		const mine = plan({
			slug: "mine",
			title: "Mine",
			createdBy: { sessionId: SESSION },
			seenIn: [SESSION],
			nodes: [phase("p-1", "active")],
		});
		const lines = renderPlanListView({
			plans: [mine],
			currentSessionId: SESSION,
			currentCwd: CWD,
			now: NOW,
		});
		const text = lines.join("\n");
		expect(text).toContain("This session:");
		expect(text).not.toContain("Other sessions:");
		expect(text).not.toContain("Legacy");
	});
});
