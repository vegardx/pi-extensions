/**
 * Tests for scrutinizePlan — model fallback chain, plan serialisation,
 * JSON parsing, and error handling.
 */
import { vi } from "vitest";

vi.mock("@vegardx/pi-extensions-shared/parallel-subagent.js", () => ({
	runSubagent: vi.fn(),
}));

vi.mock("@vegardx/pi-extensions-shared/model-resolver.js", () => ({
	resolveModel: vi.fn(),
}));

import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import type { Plan } from "../plan/schema.js";
import { scrutinizePlan } from "../plan/scrutinize.js";

// ---- Fixtures ------------------------------------------------------------

function makeTask(
	id: string,
	body = "Task body.",
): Plan["phases"][0]["tasks"][0] {
	return {
		id,
		title: `Task ${id}`,
		body,
		done: false,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		slug: "test-plan",
		title: "Test Plan",
		repo: { path: "/fake/repo" },
		phases: [
			{
				id: "phase-1",
				title: "Phase 1",
				goal: "Ship phase 1",
				status: "planned",
				branch: "feat/phase-1",
				summary: "This is the phase summary — should be stripped.",
				tasks: [makeTask("t1"), makeTask("t2")],
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		],
		...overrides,
	} as Plan;
}

const MOCK_CTX = {
	cwd: "/fake/repo",
	model: { provider: "session-provider", id: "session-model" },
	hasUI: true,
} as never;

const SECONDARY_HEAVY = {
	model: { provider: "secondary-provider", id: "secondary-heavy-model" },
};

const VALID_FINDINGS = [
	{
		severity: "high",
		phase: "phase-1",
		finding: "Add migration phase",
		detail: "Schema change with no migration task.",
	},
	{
		severity: "low",
		phase: null,
		finding: "Missing integration tests",
		detail: "No end-to-end test phase.",
	},
];

// ---- Tests ---------------------------------------------------------------

describe("scrutinizePlan", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(resolveModel).mockResolvedValue(SECONDARY_HEAVY as never);
		vi.mocked(runSubagent).mockResolvedValue({
			tag: "scrutinize",
			rawText: JSON.stringify(VALID_FINDINGS),
		});
	});

	describe("happy path", () => {
		it("returns parsed findings on valid JSON array output", async () => {
			const result = await scrutinizePlan(makePlan(), MOCK_CTX);

			expect(result.error).toBeUndefined();
			expect(result.findings).toHaveLength(2);
			expect(result.findings[0]).toMatchObject({
				severity: "high",
				phase: "phase-1",
				finding: "Add migration phase",
			});
		});

		it("returns empty findings (no error) for empty JSON array", async () => {
			vi.mocked(runSubagent).mockResolvedValue({
				tag: "scrutinize",
				rawText: "[]",
			});

			const result = await scrutinizePlan(makePlan(), MOCK_CTX);
			expect(result.error).toBeUndefined();
			expect(result.findings).toEqual([]);
		});
	});

	describe("output parsing", () => {
		it("recovers findings from JSON wrapped in a markdown fence", async () => {
			vi.mocked(runSubagent).mockResolvedValue({
				tag: "scrutinize",
				rawText: "```json\n" + JSON.stringify(VALID_FINDINGS) + "\n```",
			});

			const result = await scrutinizePlan(makePlan(), MOCK_CTX);
			expect(result.findings).toHaveLength(2);
		});

		it("returns error when output is unparseable prose", async () => {
			vi.mocked(runSubagent).mockResolvedValue({
				tag: "scrutinize",
				rawText: "The plan looks great! No issues found.",
			});

			const result = await scrutinizePlan(makePlan(), MOCK_CTX);
			expect(result.findings).toEqual([]);
			expect(result.error).toContain("not valid JSON");
		});

		it("returns error when output is empty", async () => {
			vi.mocked(runSubagent).mockResolvedValue({
				tag: "scrutinize",
				rawText: "",
			});

			const result = await scrutinizePlan(makePlan(), MOCK_CTX);
			expect(result.findings).toEqual([]);
			expect(result.error).toBe("scrutinizer produced no output");
		});

		it("drops malformed entries, keeps valid ones, and sets error", async () => {
			const mixed = [
				VALID_FINDINGS[0],
				{ severity: "high", phase: "p1" }, // missing finding + detail
				VALID_FINDINGS[1],
			];
			vi.mocked(runSubagent).mockResolvedValue({
				tag: "scrutinize",
				rawText: JSON.stringify(mixed),
			});

			const result = await scrutinizePlan(makePlan(), MOCK_CTX);
			// Valid findings are still returned
			expect(result.findings).toHaveLength(2);
			// But error is set to signal the output wasn't fully clean
			expect(result.error).toContain("1 malformed entry");
			expect(result.error).toContain("kept 2 valid");
		});
	});

	describe("sub-agent errors", () => {
		it("returns error when runSubagent reports an error", async () => {
			vi.mocked(runSubagent).mockResolvedValue({
				tag: "scrutinize",
				rawText: "",
				error: "Timeout waiting for agent to become idle",
			});

			const result = await scrutinizePlan(makePlan(), MOCK_CTX);
			expect(result.findings).toEqual([]);
			expect(result.error).toBe("Timeout waiting for agent to become idle");
		});
	});

	describe("model fallback chain", () => {
		it("uses secondary.heavy when configured", async () => {
			await scrutinizePlan(makePlan(), MOCK_CTX);

			expect(resolveModel).toHaveBeenCalledWith(
				MOCK_CTX,
				expect.objectContaining({ tier: "heavy", set: "secondary" }),
			);
			expect(runSubagent).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: "secondary-provider",
					model: "secondary-heavy-model",
				}),
			);
		});

		it("falls back to session model when resolveModel returns null", async () => {
			vi.mocked(resolveModel).mockResolvedValue(null);

			await scrutinizePlan(makePlan(), MOCK_CTX);

			expect(runSubagent).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: "session-provider",
					model: "session-model",
				}),
			);
		});

		it("returns error when resolveModel is null and ctx.model is absent", async () => {
			vi.mocked(resolveModel).mockResolvedValue(null);
			const ctxNoModel = { cwd: "/fake", hasUI: true } as never;

			const result = await scrutinizePlan(makePlan(), ctxNoModel);
			expect(result.findings).toEqual([]);
			expect(result.error).toContain("no model configured");
			expect(runSubagent).not.toHaveBeenCalled();
		});
	});

	describe("plan serialisation", () => {
		it("strips phase.summary from the payload", async () => {
			await scrutinizePlan(makePlan(), MOCK_CTX);

			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			expect(call.task).not.toContain("This is the phase summary");
			expect(call.task).not.toContain("summary");
		});

		it("truncates task.body longer than 500 chars", async () => {
			const longBody = "x".repeat(600);
			const plan = makePlan({
				phases: [
					{
						id: "p1",
						title: "P1",
						goal: "goal",
						status: "planned",
						branch: "feat/p1",
						tasks: [makeTask("t1", longBody)],
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					} as Plan["phases"][0],
				],
			});

			await scrutinizePlan(plan, MOCK_CTX);

			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			// payload should contain the truncated version (500 chars + ellipsis)
			// and not the full 600-char body
			expect(call.task).toContain("x".repeat(500) + "…");
			expect(call.task).not.toContain("x".repeat(501));
		});

		it("uses tools: [] for pure reasoning", async () => {
			await scrutinizePlan(makePlan(), MOCK_CTX);

			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			expect(call.tools).toEqual([]);
		});

		it("includes task.kind in the payload (defaults to deliverable)", async () => {
			await scrutinizePlan(makePlan(), MOCK_CTX);
			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			expect(call.task).toContain('"kind":"deliverable"');
		});

		it("carries non-deliverable kinds through verbatim", async () => {
			const plan = makePlan({
				phases: [
					{
						id: "p1",
						title: "P",
						goal: "g",
						status: "planned",
						branch: "feat/p1",
						tasks: [
							{ ...makeTask("d"), kind: "deliverable" },
							{ ...makeTask("q"), kind: "question" },
							{ ...makeTask("f"), kind: "followUp" },
							{ ...makeTask("m"), kind: "manual" },
						],
						createdAt: "x",
						updatedAt: "x",
					} as Plan["phases"][0],
				],
			});
			await scrutinizePlan(plan, MOCK_CTX);
			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			expect(call.task).toContain('"kind":"deliverable"');
			expect(call.task).toContain('"kind":"question"');
			expect(call.task).toContain('"kind":"followUp"');
			expect(call.task).toContain('"kind":"manual"');
		});

		it("includes phase.dependsOn in the payload", async () => {
			const plan = makePlan({
				phases: [
					{
						id: "a",
						title: "A",
						goal: "g",
						status: "shipped",
						branch: "feat/a",
						tasks: [],
						createdAt: "x",
						updatedAt: "x",
					} as Plan["phases"][0],
					{
						id: "b",
						title: "B",
						goal: "g",
						status: "planned",
						branch: "feat/b",
						dependsOn: ["a"],
						tasks: [],
						createdAt: "x",
						updatedAt: "x",
					} as Plan["phases"][0],
				],
			});
			await scrutinizePlan(plan, MOCK_CTX);
			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			expect(call.task).toContain('"dependsOn":["a"]');
			expect(call.task).toContain('"dependsOn":[]');
		});

		it("includes plan.followUps in the payload", async () => {
			const plan = makePlan({
				followUps: [
					{
						id: "pf",
						title: "Doc the new schema",
						body: "",
						done: false,
						kind: "followUp",
						createdAt: "x",
						updatedAt: "x",
					},
				],
			});
			await scrutinizePlan(plan, MOCK_CTX);
			const call = vi.mocked(runSubagent).mock.calls[0]![0];
			expect(call.task).toContain('"followUps"');
			expect(call.task).toContain("Doc the new schema");
		});
	});
});
