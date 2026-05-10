import { vi } from "vitest";
import {
	appendPhaseSliceCompaction,
	appendPlanToImplementCompaction,
	buildPhaseSliceCompactionResult,
	buildSummariserPreamble,
	buildSummary,
	collectMessagesSinceLastCompaction,
	computeContextBuckets,
	countPhaseSlicesOnBranch,
	DEFAULT_PHASE_TOKENS,
	DEFAULT_SUMMARY_TOKENS,
	DEFAULT_WORKING_TOKENS,
	findLatestCompactionSummary,
	hasPhaseEndCompaction,
	hasPlanToImplementCompaction,
	type MidPhaseTriggerInput,
	type ModesCompactionDetails,
	PHASE_BOUNDARY_CUSTOM_TYPE,
	type PhaseBoundaryData,
	renderPhaseSection,
	renderPlanSection,
	type SummariseFn,
	shouldCompactMidPhase,
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
	it("formats in-progress slices with part-N", () => {
		const phase = makePhase({
			id: "p-1",
			title: "Webhook retries",
			status: "active",
		});
		const out = renderPhaseSection({
			phase,
			body: "body text",
			partN: 2,
			kind: "in-progress",
		});
		expect(out).toBe(
			"## Phase `p-1` — Webhook retries (part 2, in progress)\n\nbody text",
		);
	});

	it("formats end slices with PR number", () => {
		const phase = makePhase({
			id: "p-1",
			title: "Webhook retries",
			status: "in-review",
			prNumber: 99,
		});
		const out = renderPhaseSection({
			phase,
			body: "body",
			partN: 1,
			kind: "end",
		});
		expect(out).toBe(
			"## Phase `p-1` — Webhook retries (part 1, shipped, PR #99)\n\nbody",
		);
	});

	it("always emits part-N even for N=1 (no conditional formatting)", () => {
		const phase = makePhase({ id: "p-1", title: "X", status: "active" });
		const out = renderPhaseSection({
			phase,
			body: "b",
			partN: 1,
			kind: "in-progress",
		});
		expect(out).toContain("(part 1, in progress)");
	});

	it("omits PR number when undefined on end slice", () => {
		const phase = makePhase({ id: "p-1", title: "X", status: "in-review" });
		const out = renderPhaseSection({
			phase,
			body: "b",
			partN: 3,
			kind: "end",
		});
		expect(out).toBe("## Phase `p-1` — X (part 3, shipped)\n\nb");
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
		expect(out).toContain("MAXIMUM, not a quota");
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

	it("for partN > 1, instructs the model not to restate prior parts", () => {
		const plan = makePlan([makePhase({ id: "p-1" })]);
		const completed = plan.phases[0];
		if (!completed) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, completed, 5000, 3);
		expect(out).toContain("part 3");
		expect(out).toContain("Earlier parts are already captured");
		expect(out).toContain("do NOT restate work covered by previous parts");
	});

	it("for partN <= 1, omits the prior-parts directive", () => {
		const plan = makePlan([makePhase({ id: "p-1" })]);
		const completed = plan.phases[0];
		if (!completed) throw new Error("fixture missing phase");
		const out1 = buildSummariserPreamble(plan, completed, 5000, 1);
		const out0 = buildSummariserPreamble(plan, completed, 5000, 0);
		expect(out1).not.toContain("Earlier parts are already captured");
		expect(out0).not.toContain("Earlier parts are already captured");
	});

	it("for kind='in-progress', frames the phase as still in flight (regression for #3)", () => {
		// Mid-phase compactions pass the active phase with kind: "in-progress".
		// Earlier versions said "Just completed" unconditionally, which lied to
		// the summariser and risked degraded summary quality (model believing
		// the phase was done when it wasn't).
		const plan = makePlan([
			makePhase({
				id: "p-1",
				title: "In flight",
				goal: "G1",
				status: "active",
			}),
		]);
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, phase, 5000, 1, "in-progress");
		expect(out).toContain("Currently working on phase `p-1`");
		expect(out).toContain("NOT done yet");
		expect(out).toContain("Do NOT claim the phase is finished");
		expect(out).not.toContain("Just completed");
	});

	it("for kind='end', uses the 'Just completed' framing", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", title: "Done", goal: "G1", status: "in-review" }),
		]);
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, phase, 5000, 1, "end");
		expect(out).toContain("Just completed: phase `p-1`");
		expect(out).not.toContain("NOT done yet");
	});

	it("defaults kind to 'end' for back-compat with callers that omit it", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "in-review" })]);
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, phase, 5000);
		expect(out).toContain("Just completed");
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

	it("phase-slice does NOT trigger hasPhaseEndCompaction (only end does)", () => {
		const sm = new FakeSessionManager();
		const m = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s", m, 0, {
			modesKind: "phase-slice",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		expect(hasPhaseEndCompaction(castSm(sm), "p-1")).toBe(false);
	});

	it("ignores compactions without modes details (e.g. pi default /compact)", () => {
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

describe("countPhaseSlicesOnBranch", () => {
	it("returns 0 for a fresh branch", () => {
		const sm = new FakeSessionManager();
		expect(countPhaseSlicesOnBranch(castSm(sm), "p-1")).toBe(0);
	});

	it("counts phase-slice entries", () => {
		const sm = new FakeSessionManager();
		const m1 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s1", m1, 0, {
			modesKind: "phase-slice",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		const m2 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s2", m2, 0, {
			modesKind: "phase-slice",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		expect(countPhaseSlicesOnBranch(castSm(sm), "p-1")).toBe(2);
	});

	it("counts both phase-slice and phase-end (chain ends with end)", () => {
		const sm = new FakeSessionManager();
		const m1 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s1", m1, 0, {
			modesKind: "phase-slice",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		const m2 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s2", m2, 0, {
			modesKind: "phase-end",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		expect(countPhaseSlicesOnBranch(castSm(sm), "p-1")).toBe(2);
	});

	it("ignores other phases", () => {
		const sm = new FakeSessionManager();
		const m1 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s1", m1, 0, {
			modesKind: "phase-slice",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		const m2 = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s2", m2, 0, {
			modesKind: "phase-slice",
			modesPhaseId: "p-2",
		} satisfies ModesCompactionDetails);
		expect(countPhaseSlicesOnBranch(castSm(sm), "p-1")).toBe(1);
		expect(countPhaseSlicesOnBranch(castSm(sm), "p-2")).toBe(1);
	});

	it("ignores plan-to-implement compactions (not phase slices)", () => {
		const sm = new FakeSessionManager();
		const m = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("s", m, 0, {
			modesKind: "plan-to-implement",
			modesPhaseId: "p-1",
		} satisfies ModesCompactionDetails);
		expect(countPhaseSlicesOnBranch(castSm(sm), "p-1")).toBe(0);
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
// appendPhaseSliceCompaction (in-progress + end)
// ---------------------------------------------------------------------------

describe("appendPhaseSliceCompaction", () => {
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

	describe("kind: end", () => {
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

			const id = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 5000,
				phaseId: "p-1",
				kind: "end",
			});

			expect(id).toBeTruthy();
			const last = sm.entries[sm.entries.length - 1];
			expect(last?.type).toBe("compaction");

			// THE invariant: the new summary starts with the previous summary
			// byte-for-byte. This is what keeps the prompt cache hot.
			expect((last?.summary as string).startsWith(prevSummary)).toBe(true);
			// Section title with part-N + shipped + PR.
			expect(last?.summary).toContain(
				"## Phase `p-1` — Endpoint (part 1, shipped, PR #42)\n\n## Done\n- endpoint shipped",
			);
			// Details set correctly.
			const details = last?.details as ModesCompactionDetails;
			expect(details.modesKind).toBe("phase-end");
			expect(details.modesPhaseId).toBe("p-1");
		});

		it("is idempotent on repeat calls for the same phase", async () => {
			const sm = new FakeSessionManager();
			const plan = makePlan([makePhase({ id: "p-1", status: "in-review" })]);
			setupPlanToImplement(sm, plan, "## Plan: x");
			sm.appendMessage(userMsg("work"));

			const summarise: SummariseFn = vi.fn().mockResolvedValue("body");

			const first = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "end",
			});
			expect(first).toBeTruthy();
			const after = sm.entries.length;

			const second = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "end",
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

			const id = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "end",
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

			const id = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "end",
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
				appendPhaseSliceCompaction({
					sm: castSm(sm),
					plan,
					summarise,
					maxTokens: DEFAULT_PHASE_TOKENS,
					tokensBefore: 0,
					phaseId: "p-bogus",
					kind: "end",
				}),
			).rejects.toThrow(/p-bogus.*not found/);
		});
	});

	describe("kind: in-progress", () => {
		it("appends a phase-slice compaction with details.modesKind = 'phase-slice'", async () => {
			const sm = new FakeSessionManager();
			const plan = makePlan([
				makePhase({ id: "p-1", title: "T", status: "active" }),
			]);
			setupPlanToImplement(sm, plan, "## Plan: T");
			sm.appendMessage(userMsg("partial work"));

			const summarise: SummariseFn = vi.fn().mockResolvedValue("partial body");

			const id = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "in-progress",
			});

			expect(id).toBeTruthy();
			const last = sm.entries[sm.entries.length - 1];
			const details = last?.details as ModesCompactionDetails;
			expect(details.modesKind).toBe("phase-slice");
			expect(details.modesPhaseId).toBe("p-1");
			expect(last?.summary).toContain(
				"## Phase `p-1` — T (part 1, in progress)",
			);
		});

		it("is NOT idempotent — multiple slices per phase are valid by design", async () => {
			const sm = new FakeSessionManager();
			const plan = makePlan([
				makePhase({ id: "p-1", title: "T", status: "active" }),
			]);
			setupPlanToImplement(sm, plan, "## Plan: T");
			sm.appendMessage(userMsg("partial 1"));

			const summarise: SummariseFn = vi.fn().mockResolvedValue("body");

			const a = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "in-progress",
			});
			expect(a).toBeTruthy();

			sm.appendMessage(userMsg("partial 2"));
			const b = await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "in-progress",
			});
			expect(b).toBeTruthy();
			expect(b).not.toBe(a);
			expect(summarise).toHaveBeenCalledTimes(2);
		});

		it("increments part-N across consecutive slices", async () => {
			const sm = new FakeSessionManager();
			const plan = makePlan([
				makePhase({ id: "p-1", title: "T", status: "active" }),
			]);
			setupPlanToImplement(sm, plan, "## Plan: T");

			const summarise: SummariseFn = vi.fn().mockResolvedValue("body");

			sm.appendMessage(userMsg("a"));
			await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "in-progress",
			});
			sm.appendMessage(userMsg("b"));
			await appendPhaseSliceCompaction({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				phaseId: "p-1",
				kind: "in-progress",
			});

			const last = sm.entries[sm.entries.length - 1];
			expect(last?.summary).toContain(
				"## Phase `p-1` — T (part 2, in progress)",
			);
		});
	});
});

// ---------------------------------------------------------------------------
// buildPhaseSliceCompactionResult (the new ctx.compact-driven path)
// ---------------------------------------------------------------------------
//
// In the post-fix design, mid-phase compaction is driven by pi via
// ctx.compact() + the session_before_compact hook. The hook handler calls
// this builder to construct the {summary, firstKeptEntryId, tokensBefore,
// details} payload pi expects. Pi then handles appendCompaction AND the
// agent.state.messages rebuild.
//
// Differences vs. appendPhaseSliceCompaction (the legacy direct-write path):
//   - Returns the result instead of mutating the session.
//   - Uses the firstKeptEntryId pi computed via findCutPoint (we trust it).
//   - No marker custom entry — pi's chosen cut point handles the boundary.
//   - Always "in-progress" kind (phase-end is going away in Phase 2).

describe("buildPhaseSliceCompactionResult", () => {
	it("builds a result with summary, firstKeptEntryId, tokensBefore, and modesKind=phase-slice", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({ id: "p-1", title: "Webhook retries", status: "active" }),
		]);
		sm.appendMessage(userMsg("work in progress"));

		const summarise: SummariseFn = vi.fn().mockResolvedValue("distilled body");

		const result = await buildPhaseSliceCompactionResult({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 12345,
			firstKeptEntryId: "pi-chosen-id",
			phaseId: "p-1",
		});

		expect(result).not.toBeNull();
		expect(result?.firstKeptEntryId).toBe("pi-chosen-id");
		expect(result?.tokensBefore).toBe(12345);
		expect(result?.details.modesKind).toBe("phase-slice");
		expect(result?.details.modesPhaseId).toBe("p-1");
		expect(result?.summary).toContain(
			"## Phase `p-1` — Webhook retries (part 1, in progress)",
		);
		expect(result?.summary).toContain("distilled body");
	});

	it("reuses the latest CompactionEntry's summary as a stable prefix", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({ id: "p-1", title: "T", status: "active" }),
		]);
		sm.appendCompaction("## Plan: prior", "_", 0, undefined, true);
		sm.appendMessage(userMsg("more work"));

		const summarise: SummariseFn = vi.fn().mockResolvedValue("body");
		const result = await buildPhaseSliceCompactionResult({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			firstKeptEntryId: "x",
			phaseId: "p-1",
		});

		expect(result?.summary.startsWith("## Plan: prior\n\n## Phase `p-1`")).toBe(
			true,
		);
	});

	it("increments part-N for repeated mid-phase slices on the same phase", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({ id: "p-1", title: "T", status: "active" }),
		]);
		// Pretend a prior phase-slice compaction already exists on the branch.
		sm.appendCompaction(
			"## Phase `p-1` — T (part 1, in progress)\n\nbody1",
			"_",
			0,
			{ modesKind: "phase-slice", modesPhaseId: "p-1" },
			true,
		);
		sm.appendMessage(userMsg("more work"));

		const summarise: SummariseFn = vi.fn().mockResolvedValue("body2");
		const result = await buildPhaseSliceCompactionResult({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			firstKeptEntryId: "x",
			phaseId: "p-1",
		});

		expect(result?.summary).toContain("(part 2, in progress)");
	});

	it("returns null when the summariser fails (clean rollback)", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({ id: "p-1", title: "T", status: "active" }),
		]);
		sm.appendMessage(userMsg("work"));

		const summarise: SummariseFn = vi.fn().mockResolvedValue(null);
		const result = await buildPhaseSliceCompactionResult({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			firstKeptEntryId: "x",
			phaseId: "p-1",
		});

		expect(result).toBeNull();
	});

	it("emits the no-recorded-work placeholder body when there are no messages since last compaction", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({ id: "p-1", title: "T", status: "active" }),
		]);
		sm.appendCompaction("## Plan: prior", "_", 0, undefined, true);

		const summarise: SummariseFn = vi.fn();
		const result = await buildPhaseSliceCompactionResult({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			firstKeptEntryId: "x",
			phaseId: "p-1",
		});

		expect(summarise).not.toHaveBeenCalled();
		expect(result?.summary).toContain("(no recorded work)");
	});

	it("throws when phaseId is not in the plan", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({ id: "p-1", title: "T", status: "active" }),
		]);
		const summarise: SummariseFn = vi.fn().mockResolvedValue("body");

		await expect(
			buildPhaseSliceCompactionResult({
				sm: castSm(sm),
				plan,
				summarise,
				maxTokens: DEFAULT_PHASE_TOKENS,
				tokensBefore: 0,
				firstKeptEntryId: "x",
				phaseId: "p-missing",
			}),
		).rejects.toThrow(/p-missing/);
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
		await appendPhaseSliceCompaction({
			sm: castSm(sm),
			plan,
			summarise: summariseStub,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-1",
			kind: "end",
		});
		const summaryAfterP1 = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// phase 2 work + ship
		sm.appendMessage(userMsg("p2 work"));
		await appendPhaseSliceCompaction({
			sm: castSm(sm),
			plan,
			summarise: summariseStub,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-2",
			kind: "end",
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

	it("slice chain within ONE phase: 2 in-progress slices + 1 end, prefix stable across all", async () => {
		const sm = new FakeSessionManager();
		const plan = makePlan([
			makePhase({
				id: "p-long",
				title: "Long phase",
				goal: "lots of work",
				status: "in-review",
				prNumber: 100,
			}),
		]);
		const summarise: SummariseFn = async ({ messages }) =>
			`body for ${messages.length} msgs`;

		// plan→implement
		sm.appendMessage(userMsg("planning"));
		await appendPlanToImplementCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			activePhaseId: "p-long",
		});
		const sumA = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// First mid-phase slice
		sm.appendMessage(userMsg("work-a-1"));
		sm.appendMessage(userMsg("work-a-2"));
		await appendPhaseSliceCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-long",
			kind: "in-progress",
		});
		const sumB = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// Second mid-phase slice
		sm.appendMessage(userMsg("work-b-1"));
		await appendPhaseSliceCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-long",
			kind: "in-progress",
		});
		const sumC = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// /ship — final slice
		sm.appendMessage(userMsg("work-final"));
		await appendPhaseSliceCompaction({
			sm: castSm(sm),
			plan,
			summarise,
			maxTokens: DEFAULT_PHASE_TOKENS,
			tokensBefore: 0,
			phaseId: "p-long",
			kind: "end",
		});
		const sumD = (
			sm.entries[sm.entries.length - 1] as unknown as { summary: string }
		).summary;

		// Prefix invariant across the entire slice chain.
		expect(sumB.startsWith(sumA)).toBe(true);
		expect(sumC.startsWith(sumB)).toBe(true);
		expect(sumD.startsWith(sumC)).toBe(true);

		// Section titles increment part-N.
		expect(sumD).toContain(
			"## Phase `p-long` — Long phase (part 1, in progress)",
		);
		expect(sumD).toContain(
			"## Phase `p-long` — Long phase (part 2, in progress)",
		);
		expect(sumD).toContain(
			"## Phase `p-long` — Long phase (part 3, shipped, PR #100)",
		);

		// Each part is in the summary exactly once (no dupe / re-summarisation).
		expect(sumD.match(/part 1, in progress/g)?.length).toBe(1);
		expect(sumD.match(/part 2, in progress/g)?.length).toBe(1);
		expect(sumD.match(/part 3, shipped/g)?.length).toBe(1);
	});
});

// Reference imports to silence unused-warnings for types only used in casts.
type _UsedTypes = PhaseStatus;

// ---------------------------------------------------------------------------
// shouldCompactMidPhase — the turn_end gate stack
// ---------------------------------------------------------------------------

describe("shouldCompactMidPhase", () => {
	const baseFire: MidPhaseTriggerInput = {
		compactionApiAvailable: true,
		mode: "auto",
		compactionInFlight: false,
		hasActivePhase: true,
		tokens: 200_000,
		workingTokens: 150_000,
		summaryTokens: 0,
	};

	it("fires when every gate passes", () => {
		expect(shouldCompactMidPhase(baseFire)).toBe(true);
	});

	it("skips when compactionApiAvailable is false (probe failed)", () => {
		expect(
			shouldCompactMidPhase({ ...baseFire, compactionApiAvailable: false }),
		).toBe(false);
	});

	it.each([
		"plan",
		"hack",
		null,
	] as const)("skips outside auto mode (mode=%s)", (mode) => {
		expect(shouldCompactMidPhase({ ...baseFire, mode })).toBe(false);
	});

	it("skips when a compaction is already in flight (re-entrancy guard)", () => {
		expect(
			shouldCompactMidPhase({ ...baseFire, compactionInFlight: true }),
		).toBe(false);
	});

	it("skips when there is no active phase", () => {
		expect(shouldCompactMidPhase({ ...baseFire, hasActivePhase: false })).toBe(
			false,
		);
	});

	it("skips when tokens is null (typically right after a compaction)", () => {
		expect(shouldCompactMidPhase({ ...baseFire, tokens: null })).toBe(false);
	});

	it("skips when tokens is undefined (no usage data yet)", () => {
		expect(shouldCompactMidPhase({ ...baseFire, tokens: undefined })).toBe(
			false,
		);
	});

	it("skips when working portion equals the threshold (strict >, not >=)", () => {
		expect(shouldCompactMidPhase({ ...baseFire, tokens: 150_000 })).toBe(false);
	});

	it("skips when working portion is below the threshold", () => {
		expect(shouldCompactMidPhase({ ...baseFire, tokens: 149_999 })).toBe(false);
	});

	it("fires at threshold + 1", () => {
		expect(shouldCompactMidPhase({ ...baseFire, tokens: 150_001 })).toBe(true);
	});

	it("subtracts summary tokens before comparing (does NOT fire when summary covers the excess)", () => {
		// 200k total, 60k of which is summary -> working portion = 140k, below 150k.
		expect(
			shouldCompactMidPhase({
				...baseFire,
				tokens: 200_000,
				summaryTokens: 60_000,
			}),
		).toBe(false);
	});

	it("fires when working portion exceeds threshold despite summary cushion", () => {
		// 200k total, 30k summary -> working portion = 170k, above 150k.
		expect(
			shouldCompactMidPhase({
				...baseFire,
				tokens: 200_000,
				summaryTokens: 30_000,
			}),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// computeContextBuckets — pure bucket math
// ---------------------------------------------------------------------------

describe("computeContextBuckets", () => {
	it("splits a known total into sys / summary / work", () => {
		const out = computeContextBuckets({
			total: 120_000,
			systemPromptChars: 40_000,
			toolSchemaChars: 8_000,
			summaryChars: 120_000,
		});
		// sys = ceil(48000 / 4) = 12000
		// summary = ceil(120000 / 4) = 30000
		// work = 120000 - 12000 - 30000 = 78000
		expect(out).toEqual({
			sys: 12_000,
			summary: 30_000,
			work: 78_000,
			total: 120_000,
		});
	});

	it("reports work=0 when total is null (post-compaction quiet window)", () => {
		const out = computeContextBuckets({
			total: null,
			systemPromptChars: 40_000,
			toolSchemaChars: 8_000,
			summaryChars: 120_000,
		});
		expect(out).toEqual({
			sys: 12_000,
			summary: 30_000,
			work: 0,
			total: null,
		});
	});

	it("clamps work to 0 when sys + summary exceed total (estimation drift)", () => {
		const out = computeContextBuckets({
			total: 30_000,
			systemPromptChars: 40_000,
			toolSchemaChars: 8_000,
			summaryChars: 120_000,
		});
		expect(out.work).toBe(0);
		expect(out.total).toBe(30_000);
	});

	it("with default budgets, ceiling math is workingTokens + summaryTokens", () => {
		// Sanity check that the package-level defaults compose to a sensible total.
		expect(DEFAULT_WORKING_TOKENS + DEFAULT_SUMMARY_TOKENS).toBe(250_000);
	});

	it("handles all-zero inputs cleanly", () => {
		const out = computeContextBuckets({
			total: 0,
			systemPromptChars: 0,
			toolSchemaChars: 0,
			summaryChars: 0,
		});
		expect(out).toEqual({ sys: 0, summary: 0, work: 0, total: 0 });
	});
});
