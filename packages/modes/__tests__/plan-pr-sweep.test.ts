/**
 * Pure-logic tests for the end-of-plan PR sweep. The shell driver
 * (`runEndOfPlanPrSweep`) takes a `run` injection seam so we can
 * stub `gh` without spawning anything.
 */

import type { ShellResult } from "../git.js";
import {
	type PrSweepResult,
	parsePrJson,
	pickFirstWithFeedback,
	type RunShell,
	runEndOfPlanPrSweep,
	summarisePrSweep,
} from "../plan/pr-sweep.js";
import type { Plan } from "../plan/schema.js";

function makePlan(
	nodes: Array<{ id: string; prNumber?: number }>,
): Pick<Plan, "nodes"> {
	return {
		nodes: nodes.map((p, i) => ({
			type: "deliverable" as const,
			id: p.id,
			title: p.id,
			body: "",
			status: p.prNumber ? "shipped" : "planned",
			children: [],
			branch: `feat/${p.id}`,
			createdAt: "0",
			updatedAt: "0",
			prNumber: p.prNumber,
			position: i,
		})) as unknown as Plan["nodes"],
	};
}

function shellOk(stdout: string): ShellResult {
	return { ok: true, stdout, stderr: "", exitCode: 0 };
}
function shellErr(stderr: string, code = 1): ShellResult {
	return { ok: false, stdout: "", stderr, exitCode: code };
}

describe("parsePrJson", () => {
	it("maps state=MERGED to merged regardless of other fields", () => {
		const r = parsePrJson("p1", 42, {
			state: "MERGED",
			statusCheckRollup: [{ conclusion: "SUCCESS" }],
			reviewDecision: null,
			reviews: [],
		});
		expect(r.state).toBe("merged");
		expect(r.ci).toBe("green");
	});

	it("classifies CI as red when any rollup row failed", () => {
		const r = parsePrJson("p1", 1, {
			state: "OPEN",
			statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }],
		});
		expect(r.ci).toBe("red");
	});

	it("classifies CI as pending when nothing failed but something is in progress", () => {
		const r = parsePrJson("p1", 1, {
			state: "OPEN",
			statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "IN_PROGRESS" }],
		});
		expect(r.ci).toBe("pending");
	});

	it("returns ci=none when there are no checks at all", () => {
		const r = parsePrJson("p1", 1, {
			state: "OPEN",
			statusCheckRollup: [],
		});
		expect(r.ci).toBe("none");
	});

	it("counts COMMENTED and CHANGES_REQUESTED reviews as unresolved", () => {
		const r = parsePrJson("p1", 1, {
			state: "OPEN",
			reviews: [
				{ state: "APPROVED" },
				{ state: "COMMENTED" },
				{ state: "CHANGES_REQUESTED" },
				{ state: "DISMISSED" },
			],
		});
		expect(r.unresolvedComments).toBe(2);
	});

	it("tolerates missing/garbage payloads and returns conservative defaults", () => {
		const r = parsePrJson("p1", 1, {});
		expect(r).toMatchObject({
			phaseId: "p1",
			prNumber: 1,
			state: "unknown",
			ci: "none",
			reviewDecision: null,
			unresolvedComments: 0,
		});
	});
});

describe("summarisePrSweep", () => {
	it("renders one row per phase with state and CI flags", () => {
		const results: PrSweepResult[] = [
			{
				phaseId: "add-webhook",
				prNumber: 142,
				state: "merged",
				ci: "green",
				reviewDecision: "APPROVED",
				unresolvedComments: 0,
			},
			{
				phaseId: "validate-signatures",
				prNumber: 145,
				state: "open",
				ci: "green",
				reviewDecision: "CHANGES_REQUESTED",
				unresolvedComments: 3,
			},
		];
		const out = summarisePrSweep(results);
		expect(out).toContain("PR sweep");
		expect(out).toContain("add-webhook");
		expect(out).toContain("PR #142");
		expect(out).toContain("merged");
		expect(out).toContain("validate-signatures");
		expect(out).toContain("CHANGES_REQUESTED");
		expect(out).toContain("3 unresolved comments");
	});

	it("flags rows where gh failed", () => {
		const out = summarisePrSweep([
			{
				phaseId: "p1",
				prNumber: 99,
				state: "unknown",
				ci: "error",
				reviewDecision: null,
				unresolvedComments: 0,
				error: "gh: not authenticated",
			},
		]);
		expect(out).toContain("⚠ gh: gh: not authenticated");
	});

	it("returns a single line when there are no phases with PRs", () => {
		expect(summarisePrSweep([])).toContain("no phases with PRs");
	});
});

describe("pickFirstWithFeedback", () => {
	const merged: PrSweepResult = {
		phaseId: "p-merged",
		prNumber: 1,
		state: "merged",
		ci: "green",
		reviewDecision: "APPROVED",
		unresolvedComments: 0,
	};
	const ciFail: PrSweepResult = {
		phaseId: "p-ci-fail",
		prNumber: 2,
		state: "open",
		ci: "red",
		reviewDecision: null,
		unresolvedComments: 0,
	};
	const changesRequested: PrSweepResult = {
		phaseId: "p-cr",
		prNumber: 3,
		state: "open",
		ci: "green",
		reviewDecision: "CHANGES_REQUESTED",
		unresolvedComments: 0,
	};
	const pending: PrSweepResult = {
		phaseId: "p-pending",
		prNumber: 4,
		state: "open",
		ci: "pending",
		reviewDecision: null,
		unresolvedComments: 0,
	};

	it("returns null when nothing flags", () => {
		expect(pickFirstWithFeedback([merged, merged])).toBeNull();
	});
	it("prioritises red CI over CHANGES_REQUESTED", () => {
		expect(pickFirstWithFeedback([changesRequested, ciFail])?.phaseId).toBe(
			"p-ci-fail",
		);
	});
	it("prioritises CHANGES_REQUESTED over pending CI", () => {
		expect(pickFirstWithFeedback([pending, changesRequested])?.phaseId).toBe(
			"p-cr",
		);
	});
});

describe("runEndOfPlanPrSweep", () => {
	it("returns null when no phase has a PR", async () => {
		const plan = makePlan([{ id: "p1" }, { id: "p2" }]);
		const out = await runEndOfPlanPrSweep({
			cwd: "/tmp",
			plan,
			run: () => shellOk("{}"),
		});
		expect(out).toBeNull();
	});

	it("aggregates per-phase results from gh", async () => {
		const plan = makePlan([
			{ id: "p1", prNumber: 100 },
			{ id: "p2", prNumber: 101 },
		]);
		const calls: string[][] = [];
		const run: RunShell = (_cmd, args) => {
			calls.push([...args]);
			const num = args[2];
			if (num === "100") {
				return shellOk(
					JSON.stringify({
						state: "MERGED",
						statusCheckRollup: [{ conclusion: "SUCCESS" }],
						reviewDecision: "APPROVED",
						reviews: [],
					}),
				);
			}
			return shellOk(
				JSON.stringify({
					state: "OPEN",
					statusCheckRollup: [{ conclusion: "FAILURE" }],
					reviewDecision: "CHANGES_REQUESTED",
					reviews: [{ state: "CHANGES_REQUESTED" }],
				}),
			);
		};
		const out = await runEndOfPlanPrSweep({ cwd: "/tmp", plan, run });
		expect(out).toHaveLength(2);
		expect(out?.[0]).toMatchObject({ phaseId: "p1", state: "merged" });
		expect(out?.[1]).toMatchObject({
			phaseId: "p2",
			ci: "red",
			reviewDecision: "CHANGES_REQUESTED",
			unresolvedComments: 1,
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("100");
		expect(calls[1]).toContain("101");
		// Pin the `--json` field list — `merged` is not a valid gh JSON
		// field and reintroducing it aborts every per-phase call.
		const jsonIdx = calls[0].indexOf("--json");
		expect(jsonIdx).toBeGreaterThanOrEqual(0);
		expect(calls[0][jsonIdx + 1]).toBe(
			"state,statusCheckRollup,reviewDecision,reviews",
		);
	});

	it("aborts the entire sweep when the first gh call hits command-not-found", async () => {
		const plan = makePlan([
			{ id: "p1", prNumber: 1 },
			{ id: "p2", prNumber: 2 },
		]);
		const out = await runEndOfPlanPrSweep({
			cwd: "/tmp",
			plan,
			run: () => shellErr("gh: command not found"),
		});
		expect(out).toBeNull();
	});

	it("soft-fails per phase when gh errors mid-sweep", async () => {
		const plan = makePlan([
			{ id: "p1", prNumber: 1 },
			{ id: "p2", prNumber: 2 },
		]);
		let n = 0;
		const run: RunShell = () => {
			n++;
			if (n === 1) {
				return shellOk(
					JSON.stringify({
						state: "MERGED",
						statusCheckRollup: [{ conclusion: "SUCCESS" }],
					}),
				);
			}
			return shellErr("HTTP 404: Not Found");
		};
		const out = await runEndOfPlanPrSweep({ cwd: "/tmp", plan, run });
		expect(out).toHaveLength(2);
		expect(out?.[0].state).toBe("merged");
		expect(out?.[1].error).toContain("HTTP 404");
		expect(out?.[1].ci).toBe("error");
	});

	it("soft-fails on JSON parse errors", async () => {
		const plan = makePlan([{ id: "p1", prNumber: 1 }]);
		const out = await runEndOfPlanPrSweep({
			cwd: "/tmp",
			plan,
			run: () => shellOk("not-json{"),
		});
		expect(out).toHaveLength(1);
		expect(out?.[0].error).toContain("parse error");
	});
});
