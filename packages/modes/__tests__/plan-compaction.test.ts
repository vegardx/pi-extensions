import { describe, expect, it, vi } from "vitest";
import {
	appendPhaseEndCompaction,
	appendPlanToImplementCompaction,
	buildSummariserPreamble,
	buildSummary,
	collectMessagesSinceLastCompaction,
	DEFAULT_PHASE_TOKENS,
	findLatestCompactionSummary,
	hasPhaseEndCompaction,
	hasPlanToImplementCompaction,
	type ModesCompactionDetails,
	PHASE_BOUNDARY_CUSTOM_TYPE,
	type PhaseBoundaryData,
	renderPhaseSection,
	renderPlanSection,
	type SummariseFn,
} from "../plan/compaction.js";
import type { Phase, PhaseStatus, Plan } from "../plan/schema.js";

// ---------------------------------------------------------------------------
// Fake SessionManager — records appends, exposes getBranch.
// ---------------------------------------------------------------------------

interface FakeEntry {
	id: string;
	parentId: string | null;
	type: string;
	[key: string]: unknown;
}

class FakeSessionManager {
	entries: FakeEntry[] = [];
	private nextId = 1;

	private alloc(): string {
		const id = `e${this.nextId++}`;
		return id;
	}

	private parentId(): string | null {
		return this.entries.length > 0
			? (this.entries[this.entries.length - 1]?.id ?? null)
			: null;
	}

	appendMessage(message: { role: string; [k: string]: unknown }): string {
		const id = this.alloc();
		this.entries.push({
			id,
			parentId: this.parentId(),
			type: "message",
			message,
		});
		return id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = this.alloc();
		this.entries.push({
			id,
			parentId: this.parentId(),
			type: "custom",
			customType,
			data,
		});
		return id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): string {
		const id = this.alloc();
		this.entries.push({
			id,
			parentId: this.parentId(),
			type: "compaction",
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		});
		return id;
	}

	getBranch(): FakeEntry[] {
		// Linear branch — no forks in tests.
		return this.entries;
	}
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePhase(overrides: Partial<Phase> = {}): Phase {
	const now = new Date().toISOString();
	return {
		id: "p-active",
		title: "Active phase",
		goal: "ship something",
		status: "active",
		branch: "feat/p-active",
		tasks: [],
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

function userMsg(text: string) {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function castSm(sm: FakeSessionManager) {
	// The fake satisfies the structural surface used by compaction.ts;
	// vitest tests don't need the full SessionManager type.
	return sm as unknown as Parameters<
		typeof appendPlanToImplementCompaction
	>[0]["sm"];
}

// ---------------------------------------------------------------------------
// renderPlanSection
// ---------------------------------------------------------------------------

describe("renderPlanSection", () => {
	it("emits stable markdown with status and PR per phase", () => {
		const plan = makePlan([
			makePhase({
				id: "p-1",
				title: "First",
				goal: "do A",
				status: "shipped",
				prNumber: 42,
			}),
			makePhase({
				id: "p-2",
				title: "Second",
				goal: "do B",
				status: "active",
			}),
		]);
		expect(renderPlanSection(plan)).toBe(
			[
				"## Plan: Test Plan (slug: test-plan)",
				"- `p-1` [shipped] PR #42 — First: do A",
				"- `p-2` [active] — Second: do B",
			].join("\n"),
		);
	});

	it("is byte-stable across calls for the same input", () => {
		const plan = makePlan([makePhase()]);
		expect(renderPlanSection(plan)).toBe(renderPlanSection(plan));
	});
});

// ---------------------------------------------------------------------------
// renderPhaseSection
// ---------------------------------------------------------------------------

describe("renderPhaseSection", () => {
	it("includes status and PR number when present", () => {
		const phase = makePhase({
			id: "p-1",
			title: "Webhook retries",
			status: "in-review",
			prNumber: 99,
		});
		const out = renderPhaseSection(phase, "body text");
		expect(out).toBe(
			"## Phase `p-1` — Webhook retries (in-review, PR #99)\n\nbody text",
		);
	});

	it("omits PR number when undefined", () => {
		const phase = makePhase({ id: "p-1", title: "X", status: "active" });
		const out = renderPhaseSection(phase, "body");
		expect(out).toBe("## Phase `p-1` — X (active)\n\nbody");
	});
});

// ---------------------------------------------------------------------------
// buildSummary
// ---------------------------------------------------------------------------

describe("buildSummary", () => {
	it("returns just newSection when prevSummary is empty", () => {
		expect(buildSummary("", "## Phase p-1\nbody")).toBe("## Phase p-1\nbody");
	});

	it("concatenates with double newline separator", () => {
		expect(buildSummary("## Plan\nA", "## Phase p-1\nB")).toBe(
			"## Plan\nA\n\n## Phase p-1\nB",
		);
	});

	it("preserves the previous summary byte-for-byte (cache invariant)", () => {
		const prev = "## Plan: Test\n- p-1 — done\n- p-2 — done";
		const next = buildSummary(prev, "## Phase p-3\nbody");
		// The byte-prefix of `next` must equal `prev` exactly. This is the
		// invariant that lets the prompt cache hit across phase boundaries.
		expect(next.startsWith(prev)).toBe(true);
	});

	it("is deterministic across calls", () => {
		const a = buildSummary("X", "Y");
		const b = buildSummary("X", "Y");
		expect(a).toBe(b);
	});
});

// ---------------------------------------------------------------------------
// buildSummariserPreamble
// ---------------------------------------------------------------------------

describe("buildSummariserPreamble", () => {
	it("for plan→implement (no completed phase) names the planning context", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", title: "T1", goal: "G1", status: "active" }),
			makePhase({ id: "p-2", title: "T2", goal: "G2", status: "planned" }),
		]);
		const out = buildSummariserPreamble(plan, null, 8000);
		expect(out).toContain("planning conversation");
		expect(out).toContain("Upcoming phases");
		expect(out).toContain("`p-1` — T1: G1");
		expect(out).toContain("`p-2` — T2: G2");
		expect(out).toContain("~8000 output tokens");
	});

	it("for phase-end names the completed phase and only upcoming phases", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", title: "Done", status: "shipped" }),
			makePhase({
				id: "p-2",
				title: "Just finished",
				goal: "G2",
				status: "in-review",
			}),
			makePhase({ id: "p-3", title: "Next", goal: "G3", status: "planned" }),
			makePhase({ id: "p-4", title: "Cancelled", status: "abandoned" }),
		]);
		const completed = plan.phases[1];
		if (!completed) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, completed, 5000);

		expect(out).toContain("Just completed: phase `p-2`");
		// Upcoming list should include `p-3` (planned) but exclude:
		//   - `p-1` (shipped — terminal)
		//   - `p-2` itself (just completed)
		//   - `p-4` (abandoned — terminal)
		expect(out).toContain("`p-3` — Next: G3");
		expect(out).not.toContain("`p-1`");
		expect(out).not.toMatch(/`p-2`.*Just finished.*G/);
		expect(out).not.toContain("`p-4`");
	});

	it("omits the upcoming-phases section when there are none", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "in-review" }),
			makePhase({ id: "p-2", status: "shipped" }),
		]);
		const completed = plan.phases[0];
		if (!completed) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, completed, 5000);
		expect(out).not.toContain("Upcoming phases");
	});
});

// ---------------------------------------------------------------------------
// Tree introspection
// ---------------------------------------------------------------------------

describe("findLatestCompactionSummary", () => {
	it("returns empty string when no compaction is on the branch", () => {
		const sm = new FakeSessionManager();
		sm.appendMessage(userMsg("hi"));
		expect(findLatestCompactionSummary(castSm(sm))).toBe("");
	});

	it("returns the most recent compaction's summary", () => {
		const sm = new FakeSessionManager();
		sm.appendMessage(userMsg("first"));
		const m1 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("first summary", m1, 100);
		sm.appendMessage(userMsg("more work"));
		const m2 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("second summary", m2, 200);
		expect(findLatestCompactionSummary(castSm(sm))).toBe("second summary");
	});
});

describe("hasPhaseEndCompaction / hasPlanToImplementCompaction", () => {
	it("are false on a fresh branch", () => {
		const sm = new FakeSessionManager();
		expect(hasPhaseEndCompaction(castSm(sm), "p-1")).toBe(false);
		expect(hasPlanToImplementCompaction(castSm(sm))).toBe(false);
	});

	it("flip true after the matching modes compaction is appended", () => {
		const sm = new FakeSessionManager();
		const m1 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s1", m1, 0, {
			modesKind: "plan-to-implement",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		expect(hasPlanToImplementCompaction(castSm(sm))).toBe(true);
		expect(hasPhaseEndCompaction(castSm(sm), "p-1")).toBe(false);

		const m2 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s2", m2, 0, {
			modesKind: "phase-end",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		expect(hasPhaseEndCompaction(castSm(sm), "p-1")).toBe(true);
		expect(hasPhaseEndCompaction(castSm(sm), "p-2")).toBe(false);
	});

	it("ignores compactions without modes details (e.g. smart-compact)", () => {
		const sm = new FakeSessionManager();
		const m = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		// Default-shape compaction details (file ops) — not modes.
		sm.appendCompaction("generic", m, 0, {
			readFiles: [],
			modifiedFiles: [],
		});
		expect(hasPlanToImplementCompaction(castSm(sm))).toBe(false);
		expect(hasPhaseEndCompaction(castSm(sm), "p-1")).toBe(false);
	});
});

describe("collectMessagesSinceLastCompaction", () => {
	it("returns all messages when no compaction exists", () => {
		const sm = new FakeSessionManager();
		sm.appendMessage(userMsg("a"));
		sm.appendMessage(userMsg("b"));
		const msgs = collectMessagesSinceLastCompaction(castSm(sm));
		expect(
			msgs.map((m) => (m as { content: { text: string }[] }).content[0]?.text),
		).toEqual(["a", "b"]);
	});

	it("returns only messages after the latest compaction", () => {
		const sm = new FakeSessionManager();
		sm.appendMessage(userMsg("before"));
		const marker = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s", marker, 0);
		sm.appendMessage(userMsg("after-1"));
		sm.appendMessage(userMsg("after-2"));
		const msgs = collectMessagesSinceLastCompaction(castSm(sm));
		expect(
			msgs.map((m) => (m as { content: { text: string }[] }).content[0]?.text),
		).toEqual(["after-1", "after-2"]);
	});
});

// ---------------------------------------------------------------------------
// appendPlanToImplementCompaction
// ---------------------------------------------------------------------------

describe("appendPlanToImplementCompaction", () => {
	it("appends marker + compaction with planning summary on happy path", async () => {
		const sm = new FakeSessionManager();
		sm.appendMessage(userMsg("let's plan webhooks"));
		sm.appendMessage(userMsg("phase 1 = endpoint"));

		const plan = makePlan([
			makePhase({ id: "p-1", title: "Endpoint", goal: "POST /hook" }),
		]);
		const summarise: SummariseFn = vi
			.fn()
			.mockResolvedValue("planning notes body");

		const id = await appendPlanToImplementCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 1234,
			activePhaseId: "p-1",
		});

		expect(id).toBeTruthy();
		expect(summarise).toHaveBeenCalledTimes(1);

		// Marker is just before compaction; firstKeptEntryId points at marker.
		const last = sm.entries[sm.entries.length - 1];
		const marker = sm.entries[sm.entries.length - 2];
		expect(marker?.type).toBe("custom");
		expect(marker?.customType).toBe(PHASE_BOUNDARY_CUSTOM_TYPE);
		expect((marker?.data as PhaseBoundaryData).kind).toBe("plan-to-implement");
		expect((marker?.data as PhaseBoundaryData).phaseId).toBe("p-1");

		expect(last?.type).toBe("compaction");
		expect(last?.firstKeptEntryId).toBe(marker?.id);
		expect(last?.tokensBefore).toBe(1234);
		expect(last?.summary).toContain("## Plan: Test Plan");
		expect(last?.summary).toContain("## Planning notes");
		expect(last?.summary).toContain("planning notes body");
		const details = last?.details as ModesCompactionDetails;
		expect(details.modesKind).toBe("plan-to-implement");
		expect(details.modesPhaseId).toBe("p-1");
	});

	it("skips the LLM call and emits plan-only summary when planning is empty", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([makePhase({ id: "p-1" })]);
		const summarise: SummariseFn = vi
			.fn()
			.mockResolvedValue("should not be called");

		const id = await appendPlanToImplementCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			activePhaseId: "p-1",
		});

		expect(id).toBeTruthy();
		expect(summarise).not.toHaveBeenCalled();
		const last = sm.entries[sm.entries.length - 1];
		expect(last?.summary).toContain("## Plan:");
		expect(last?.summary).not.toContain("## Planning notes");
	});

	it("appends nothing on summariser error (clean rollback)", async () => {
		const sm = new FakeSessionManager();
		sm.appendMessage(userMsg("planning chat"));
		const before = sm.entries.length;
		const plan = makePlan([makePhase({ id: "p-1" })]);
		const summarise: SummariseFn = vi.fn().mockResolvedValue(null);

		const id = await appendPlanToImplementCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			activePhaseId: "p-1",
		});

		expect(id).toBeNull();
		expect(sm.entries.length).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// appendPhaseEndCompaction
// ---------------------------------------------------------------------------

describe("appendPhaseEndCompaction", () => {
	function setupPlanToImplement(
		sm: FakeSessionManager,
		plan: Plan,
		prevSummary: string,
	) {
		const first = plan.phases[0];
		if (!first) throw new Error("setupPlanToImplement: plan has no phases");
		// Simulate a plan→implement compaction having already happened.
		const marker = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {
			phaseId: first.id,
			kind: "plan-to-implement",
		});
		sm.appendCompaction(prevSummary, marker, 0, {
			modesKind: "plan-to-implement",
			modesPhaseId: first.id,
		} satisfies ModesCompactionDetails);
	}

	it("preserves the previous summary verbatim and appends a new section", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({
				id: "p-1",
				title: "Endpoint",
				goal: "POST /hook",
				status: "in-review",
				prNumber: 42,
			}),
			makePhase({
				id: "p-2",
				title: "Next",
				goal: "next-up",
				status: "planned",
			}),
		]);

		const prevSummary =
			"## Plan: Test\n- p-1 active\n\n## Planning notes\n\nstuff";
		setupPlanToImplement(sm, plan, prevSummary);

		// Phase 1's work
		sm.appendMessage(userMsg("phase 1 work"));
		sm.appendMessage(userMsg("more phase 1 work"));

		const summarise: SummariseFn = vi
			.fn()
			.mockResolvedValue("## Done\n- endpoint shipped");

		const id = await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 5000,
			phaseId: "p-1",
		});

		expect(id).toBeTruthy();
		const last = sm.entries[sm.entries.length - 1];
		expect(last?.type).toBe("compaction");

		// THE invariant: the new summary starts with the previous summary
		// byte-for-byte. This is what keeps the prompt cache hot.
		expect((last?.summary as string).startsWith(prevSummary)).toBe(true);
		// The new section is appended after a blank line.
		expect(last?.summary).toContain(
			"## Phase `p-1` — Endpoint (in-review, PR #42)\n\n## Done\n- endpoint shipped",
		);
	});

	it("is idempotent on repeat calls for the same phase", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([makePhase({ id: "p-1", status: "in-review" })]);
		setupPlanToImplement(sm, plan, "## Plan: x");
		sm.appendMessage(userMsg("work"));

		const summarise: SummariseFn = vi.fn().mockResolvedValue("body");

		const first = await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-1",
		});
		expect(first).toBeTruthy();
		const after = sm.entries.length;

		const second = await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-1",
		});
		expect(second).toBeNull();
		expect(sm.entries.length).toBe(after); // no new entries
		expect(summarise).toHaveBeenCalledTimes(1); // not called again
	});

	it("appends nothing on summariser error", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([makePhase({ id: "p-1", status: "in-review" })]);
		setupPlanToImplement(sm, plan, "## Plan: x");
		sm.appendMessage(userMsg("work"));
		const before = sm.entries.length;

		const summarise: SummariseFn = vi.fn().mockResolvedValue(null);

		const id = await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-1",
		});

		expect(id).toBeNull();
		expect(sm.entries.length).toBe(before);
	});

	it("uses '(no recorded work)' body when there are no messages since last compaction", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([makePhase({ id: "p-1", status: "in-review" })]);
		setupPlanToImplement(sm, plan, "## Plan: x");
		// No message between the prior compaction and this call.

		const summarise: SummariseFn = vi.fn();

		const id = await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-1",
		});

		expect(id).toBeTruthy();
		expect(summarise).not.toHaveBeenCalled();
		const last = sm.entries[sm.entries.length - 1];
		expect(last?.summary).toContain("(no recorded work)");
	});

	it("throws when phaseId is not in the plan", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([makePhase({ id: "p-1" })]);
		const summarise: SummariseFn = vi.fn();

		await expect(
			appendPhaseEndCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-bogus",
			}),
		).rejects.toThrow(/p-bogus.*not found/);
	});
});

// ---------------------------------------------------------------------------
// End-to-end: the cache invariant across multiple phase boundaries.
// ---------------------------------------------------------------------------

describe("rolling summary across phases (cache invariant)", () => {
	it("each phase's section becomes a stable prefix for the next compaction", async () => {
		const sm = new FakeSessionManager();
		const phases: Phase[] = [
			makePhase({
				id: "p-1",
				title: "P1",
				goal: "G1",
				status: "in-review",
				prNumber: 1,
			}),
			makePhase({
				id: "p-2",
				title: "P2",
				goal: "G2",
				status: "in-review",
				prNumber: 2,
			}),
			makePhase({
				id: "p-3",
				title: "P3",
				goal: "G3",
				status: "in-review",
				prNumber: 3,
			}),
		];
		const plan = makePlan(phases);

		sm.appendMessage(userMsg("planning chat"));
		const summariseStub: SummariseFn = async ({ messages }) =>
			`summary of ${messages.length} messages`;

		// plan→implement
		await appendPlanToImplementCompaction({
			sm: castSm(sm),
			plan,
			summarise: summariseStub,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			activePhaseId: "p-1",
		});
		const summaryAfterImpl = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// phase 1 work + ship
		sm.appendMessage(userMsg("p1 work a"));
		sm.appendMessage(userMsg("p1 work b"));
		await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise: summariseStub,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-1",
		});
		const summaryAfterP1 = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// phase 2 work + ship
		sm.appendMessage(userMsg("p2 work"));
		await appendPhaseEndCompaction({
			sm: castSm(sm),
			plan,
			summarise: summariseStub,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-2",
		});
		const summaryAfterP2 = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// THE invariant chain:
		//   summaryAfterP1 starts with summaryAfterImpl
		//   summaryAfterP2 starts with summaryAfterP1
		// — i.e. every earlier section stays byte-stable forever.
		expect(summaryAfterP1.startsWith(summaryAfterImpl)).toBe(true);
		expect(summaryAfterP2.startsWith(summaryAfterP1)).toBe(true);

		expect(summaryAfterP2).toContain("## Phase `p-1` — P1");
		expect(summaryAfterP2).toContain("## Phase `p-2` — P2");
		expect(summaryAfterP2).not.toContain("## Phase `p-3`");
	});
});

// Reference imports to silence unused-warnings for types only used in casts.
type _UsedTypes = PhaseStatus;
