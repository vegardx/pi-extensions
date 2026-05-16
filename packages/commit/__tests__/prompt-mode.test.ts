/**
 * Unit tests for mode-aware prompt copy (#136).
 *
 * Exercises `buildPlanPrompt` and `buildExecutePrompt` across the
 * four modes (`auto`, `ask`, `hack`, `plan`) plus `undefined`.
 *
 * Acceptance per #136:
 *  - `auto` mode: prompts MUST yield back to the extension; MUST NOT
 *    contain the strict "Finish the turn" / "do not push" copy.
 *  - `ask` / `hack` / `plan` / undefined: prompts MUST keep the strict
 *    copy.
 */

import { buildExecutePrompt, buildPlanPrompt } from "../core.js";

const STRICT_PLAN = "Finish the turn after writing the plan.";
const STRICT_EXEC = "Stop after the last commit — do not push.";
const SOFT_PLAN_MARKER = "Yield back to the extension";
const SOFT_PLAN_FULL =
	"Yield back to the extension; it will confirm the plan and sequence /ship and the next phase.";
const SOFT_EXEC_FULL =
	"Yield back to the extension; it will sequence /ship and the next phase.";

const STRICT_MODES: ReadonlyArray<string | undefined> = [
	"hack",
	"ask",
	"plan",
	undefined,
];

describe("buildPlanPrompt", () => {
	it("auto mode emits the soft yield-back line", () => {
		const out = buildPlanPrompt(undefined, "(no diff)", "auto");
		expect(out).toContain(SOFT_PLAN_FULL);
		expect(out).not.toContain(STRICT_PLAN);
	});

	it.each(
		STRICT_MODES,
	)("%s mode keeps the strict 'Finish the turn' copy", (mode) => {
		const out = buildPlanPrompt(undefined, "(no diff)", mode);
		expect(out).toContain(STRICT_PLAN);
		expect(out).not.toContain(SOFT_PLAN_MARKER);
	});

	it("threads guidance into the prompt regardless of mode", () => {
		const guidance = "fix the webhook timeout";
		expect(buildPlanPrompt(guidance, "(no diff)", "auto")).toContain(guidance);
		expect(buildPlanPrompt(guidance, "(no diff)", "hack")).toContain(guidance);
	});
});

describe("buildExecutePrompt", () => {
	it("auto mode emits the soft yield-back line", () => {
		const out = buildExecutePrompt(null, "auto");
		expect(out).toContain(SOFT_EXEC_FULL);
		expect(out).not.toContain(STRICT_EXEC);
	});

	it.each(
		STRICT_MODES,
	)("%s mode keeps the strict 'do not push' copy", (mode) => {
		const out = buildExecutePrompt(null, mode);
		expect(out).toContain(STRICT_EXEC);
		expect(out).not.toContain(SOFT_EXEC_FULL);
	});

	it("override path ignores mode (executes plan verbatim)", () => {
		// When the user edits the plan, the override branch is taken and
		// neither finish-line variant is emitted.
		const auto = buildExecutePrompt("# my override plan", "auto");
		const hack = buildExecutePrompt("# my override plan", "hack");
		expect(auto).not.toContain(SOFT_EXEC_FULL);
		expect(auto).not.toContain(STRICT_EXEC);
		expect(hack).not.toContain(SOFT_EXEC_FULL);
		expect(hack).not.toContain(STRICT_EXEC);
		expect(auto).toContain("# my override plan");
		expect(hack).toContain("# my override plan");
	});
});
