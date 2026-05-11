import { vi } from "vitest";
import {
	buildPhaseEndSummaryPreamble,
	buildPhaseSliceCompactionResult,
	buildSummariserPreamble,
	buildSummary,
	collectMessagesSinceLastCompaction,
	computeCarryForwardSummaryChars,
	computeContextBuckets,
	countPhaseSlicesOnBranch,
	DEFAULT_PHASE_TOKENS,
	DEFAULT_SUMMARY_TOKENS,
	DEFAULT_WORKING_TOKENS,
	findLatestCompactionSummary,
	type MidPhaseTriggerInput,
	type ModesCompactionDetails,
	PHASE_BOUNDARY_CUSTOM_TYPE,
	renderPhaseSection,
	renderPlanSection,
	type SummariseFn,
	shouldCompactMidPhase,
	shouldResumeAfterCompaction,
} from "../plan/compaction.js";
import type { Phase, Plan } from "../plan/schema.js";

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
		typeof buildPhaseSliceCompactionResult
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
		});
		expect(out).toBe(
			"## Phase `p-1` — Webhook retries (part 2, in progress)\n\nbody text",
		);
	});

	it("always emits part-N even for N=1 (no conditional formatting)", () => {
		const phase = makePhase({ id: "p-1", title: "X", status: "active" });
		const out = renderPhaseSection({
			phase,
			body: "b",
			partN: 1,
		});
		expect(out).toContain("(part 1, in progress)");
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
	it("names the active phase and only upcoming phases", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", title: "Done", status: "shipped" }),
			makePhase({
				id: "p-2",
				title: "Active",
				goal: "G2",
				status: "active",
			}),
			makePhase({ id: "p-3", title: "Next", goal: "G3", status: "planned" }),
			makePhase({ id: "p-4", title: "Cancelled", status: "abandoned" }),
		]);
		const active = plan.phases[1];
		if (!active) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, active, 5000);

		expect(out).toContain("Currently working on phase `p-2`");
		// Upcoming list should include `p-3` (planned) but exclude:
		//   - `p-1` (shipped — terminal)
		//   - `p-2` itself (active)
		//   - `p-4` (abandoned — terminal)
		expect(out).toContain("`p-3` — Next: G3");
		expect(out).not.toContain("`p-1`");
		expect(out).not.toMatch(/`p-2`.*Active.*G/);
		expect(out).not.toContain("`p-4`");
	});

	it("omits the upcoming-phases section when there are none", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "active" }),
			makePhase({ id: "p-2", status: "shipped" }),
		]);
		const active = plan.phases[0];
		if (!active) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, active, 5000);
		expect(out).not.toContain("Upcoming phases");
	});

	it("for partN > 1, instructs the model not to restate prior parts", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "active" })]);
		const active = plan.phases[0];
		if (!active) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, active, 5000, 3);
		expect(out).toContain("part 3");
		expect(out).toContain("Earlier parts are already captured");
		expect(out).toContain("do NOT restate work covered by previous parts");
	});

	it("for partN <= 1, omits the prior-parts directive", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "active" })]);
		const active = plan.phases[0];
		if (!active) throw new Error("fixture missing phase");
		const out1 = buildSummariserPreamble(plan, active, 5000, 1);
		expect(out1).not.toContain("Earlier parts are already captured");
	});

	it("frames the phase as still in flight (don't claim it's done)", () => {
		// Mid-phase compaction's whole job is not to confuse the summariser
		// into thinking the phase has shipped. The preamble must mark it as
		// in-progress.
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
		const out = buildSummariserPreamble(plan, phase, 5000);
		expect(out).toContain("Currently working on phase `p-1`");
		expect(out).toContain("NOT done yet");
		expect(out).toContain("Do NOT claim the phase is finished");
		expect(out).not.toContain("Just completed");
	});

	it("includes the maxTokens budget in the prompt", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "active" })]);
		const active = plan.phases[0];
		if (!active) throw new Error("fixture missing phase");
		const out = buildSummariserPreamble(plan, active, 8000);
		expect(out).toContain("~8000 output tokens");
		expect(out).toContain("MAXIMUM, not a quota");
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

	it("ignores compactions without modes details", () => {
		const sm = new FakeSessionManager();
		const m = sm.appendCustomEntry(PHASE_BOUNDARY_CUSTOM_TYPE, {});
		sm.appendCompaction("generic", m, 0, {
			readFiles: [],
			modifiedFiles: [],
		});
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

describe("buildPhaseEndSummaryPreamble", () => {
	it("frames the just-shipped phase and lists upcoming phases", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", title: "Done before", status: "shipped" }),
			makePhase({
				id: "p-2",
				title: "Just shipped",
				goal: "core feature",
				status: "in-review",
			}),
			makePhase({
				id: "p-3",
				title: "Next up",
				goal: "polish",
				status: "planned",
			}),
		]);
		const phase = plan.phases[1];
		if (!phase) throw new Error("fixture missing phase");
		const out = buildPhaseEndSummaryPreamble(plan, phase, 8000);

		expect(out).toContain("Phase `p-2` (Just shipped) is shipping");
		expect(out).toContain("Goal of the just-shipped phase: core feature");
		expect(out).toContain("`p-3` — Next up: polish");
		expect(out).not.toContain("`p-1`");
		expect(out).toContain("~8000 output tokens");
		expect(out).toContain("## What shipped");
		expect(out).toContain("## Discoveries that change the plan");
		expect(out).toContain("## Files / identifiers future phases will touch");
		expect(out).toContain("## Don't repeat / pitfalls");
	});

	it("omits the upcoming-phases section when there are none", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "in-review" }),
			makePhase({ id: "p-2", status: "shipped" }),
		]);
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		const out = buildPhaseEndSummaryPreamble(plan, phase, 5000);
		expect(out).not.toContain("Upcoming phases");
	});

	it("is byte-stable for stable input", () => {
		const plan = makePlan([makePhase({ id: "p-1", status: "in-review" })]);
		const phase = plan.phases[0];
		if (!phase) throw new Error("fixture missing phase");
		expect(buildPhaseEndSummaryPreamble(plan, phase, 5000)).toBe(
			buildPhaseEndSummaryPreamble(plan, phase, 5000),
		);
	});
});

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
		seedTokens: 0,
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
	it("splits a known total into sys / seed / summary / work", () => {
		const out = computeContextBuckets({
			total: 120_000,
			systemPromptChars: 40_000,
			toolSchemaChars: 8_000,
			summaryChars: 120_000,
			seedChars: 16_000,
		});
		// sys = ceil(48000 / 4) = 12000
		// seed = ceil(16000 / 4) = 4000
		// summary = ceil(120000 / 4) = 30000
		// work = 120000 - 12000 - 4000 - 30000 = 74000
		expect(out).toEqual({
			sys: 12_000,
			seed: 4_000,
			summary: 30_000,
			work: 74_000,
			total: 120_000,
		});
	});

	it("reports work=0 when total is null (post-compaction quiet window)", () => {
		const out = computeContextBuckets({
			total: null,
			systemPromptChars: 40_000,
			toolSchemaChars: 8_000,
			summaryChars: 120_000,
			seedChars: 0,
		});
		expect(out).toEqual({
			sys: 12_000,
			seed: 0,
			summary: 30_000,
			work: 0,
			total: null,
		});
	});

	it("clamps work to 0 when sys + seed + summary exceed total (estimation drift)", () => {
		const out = computeContextBuckets({
			total: 30_000,
			systemPromptChars: 40_000,
			toolSchemaChars: 8_000,
			summaryChars: 120_000,
			seedChars: 0,
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
			seedChars: 0,
		});
		expect(out).toEqual({ sys: 0, seed: 0, summary: 0, work: 0, total: 0 });
	});
});

// ---------------------------------------------------------------------------
// computeCarryForwardSummaryChars — Σ(phase.summary chars) for shipped phases
// ---------------------------------------------------------------------------

describe("computeCarryForwardSummaryChars", () => {
	it("returns 0 when no phase has shipped", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "active", summary: "ignored" }),
			makePhase({ id: "p-2", status: "planned" }),
		]);
		expect(computeCarryForwardSummaryChars(plan)).toBe(0);
	});

	it("sums summary lengths only across shipped phases", () => {
		const plan = makePlan([
			makePhase({ id: "p-1", status: "shipped", summary: "abc" }),
			makePhase({ id: "p-2", status: "shipped" }),
			makePhase({ id: "p-3", status: "abandoned", summary: "xxxx" }),
			makePhase({ id: "p-4", status: "active", summary: "yyy" }),
			makePhase({ id: "p-5", status: "shipped", summary: "12345" }),
		]);
		expect(computeCarryForwardSummaryChars(plan)).toBe(8);
	});
});

describe("shouldResumeAfterCompaction", () => {
	const BASE = {
		compacted: true,
		stageAtEntry: "executing",
		modeAtEntry: "auto",
		currentStage: "executing",
		currentMode: "auto",
		remainingTaskCount: 3,
	} as const;

	it("returns true when compacted, executing, mode unchanged, and tasks remain", () => {
		expect(shouldResumeAfterCompaction({ ...BASE })).toBe(true);
	});

	it("returns false when compaction was skipped/failed", () => {
		// Failure path: don't poke the agent into a turn it isn't ready for;
		// pi auto-compaction will retry on the next overflow.
		expect(shouldResumeAfterCompaction({ ...BASE, compacted: false })).toBe(
			false,
		);
	});

	it("returns false for non-executing stages (Shift+Tab hack→plan path)", () => {
		// Shift+Tab compaction enters with stage=idle while leaving auto.
		// We must not synthesise a turn for the user.
		for (const stage of ["idle", "planning", "reviewing", "fixing"]) {
			expect(
				shouldResumeAfterCompaction({ ...BASE, stageAtEntry: stage }),
			).toBe(false);
		}
	});

	it("returns false when stageAtEntry is null/undefined", () => {
		expect(shouldResumeAfterCompaction({ ...BASE, stageAtEntry: null })).toBe(
			false,
		);
		expect(
			shouldResumeAfterCompaction({ ...BASE, stageAtEntry: undefined }),
		).toBe(false);
	});

	it("returns false when stage drifted to non-executing during async compaction", () => {
		// User hit Shift+Tab while ctx.compact() was running; modeState moved
		// out of executing. The kick is no longer wanted.
		expect(shouldResumeAfterCompaction({ ...BASE, currentStage: "idle" })).toBe(
			false,
		);
	});

	it("returns false when mode changed mid-flight (e.g. auto→hack via Shift+Tab)", () => {
		expect(shouldResumeAfterCompaction({ ...BASE, currentMode: "hack" })).toBe(
			false,
		);
		expect(shouldResumeAfterCompaction({ ...BASE, currentMode: "plan" })).toBe(
			false,
		);
	});

	it("returns false when no tasks remain (exec-complete handler will fire)", () => {
		expect(
			shouldResumeAfterCompaction({ ...BASE, remainingTaskCount: 0 }),
		).toBe(false);
	});

	it("treats negative remaining counts defensively", () => {
		expect(
			shouldResumeAfterCompaction({ ...BASE, remainingTaskCount: -1 }),
		).toBe(false);
	});
});
