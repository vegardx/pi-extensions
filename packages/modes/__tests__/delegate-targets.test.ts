/**
 * Tests for modes' delegate targets (researcher/explorer) registered
 * into the shared registry consumed by pi-ext-subagent's tool.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	clearDelegateTargets,
	getDelegateTarget,
} from "@vegardx/pi-extensions-shared/delegate-registry.js";
import {
	type ModesDelegateTargetDeps,
	registerModesDelegateTargets,
} from "../plan/delegate-targets.js";
import type {
	DelegateAgents,
	ResearchOutcome,
} from "../plan/delegate-tools.js";
import type { ExploreMailbox } from "../plan/explore-mailbox.js";

const ctx = { cwd: "/fake/repo" } as ExtensionContext;

function makeDeps(overrides?: Partial<ModesDelegateTargetDeps>): {
	deps: ModesDelegateTargetDeps;
	research: ReturnType<typeof vi.fn>;
	ask: ReturnType<typeof vi.fn>;
	wait: ReturnType<typeof vi.fn>;
	warnings: string[];
} {
	const research = vi.fn();
	const ask = vi.fn().mockResolvedValue({ id: "e1" });
	const wait = vi.fn();
	const warnings: string[] = [];
	const deps: ModesDelegateTargetDeps = {
		getDelegateAgents: () => ({ research }) as unknown as DelegateAgents,
		getExploreMailbox: () => ({ ask, wait }) as unknown as ExploreMailbox,
		readResearchTimeoutMs: () => 120_000,
		isPlanMode: () => true,
		notifyWarning: (_ctx, msg) => warnings.push(msg),
		...overrides,
	};
	return { deps, research, ask, wait, warnings };
}

describe("registerModesDelegateTargets", () => {
	beforeEach(() => {
		clearDelegateTargets();
	});

	it("registers researcher and explorer", () => {
		const { deps } = makeDeps();
		registerModesDelegateTargets(deps);
		expect(getDelegateTarget("researcher")).toBeDefined();
		expect(getDelegateTarget("explorer")).toBeDefined();
	});

	it("researcher forwards the message and per-call timeout to research()", async () => {
		const { deps, research } = makeDeps();
		research.mockResolvedValue({
			ok: true,
			text: "the answer",
			elapsedMs: 42,
		} satisfies ResearchOutcome);
		registerModesDelegateTargets(deps);
		const out = await getDelegateTarget("researcher")?.execute({
			message: "what is X?",
			ctx,
			timeoutMs: 5000,
		});
		expect(research).toHaveBeenCalledWith("what is X?", {
			timeoutMs: 5000,
			signal: undefined,
		});
		expect(out?.text).toBe("the answer");
		expect(out?.details).toEqual({ elapsedMs: 42 });
	});

	it("researcher falls back to the configured timeout when none is passed", async () => {
		const { deps, research } = makeDeps({
			readResearchTimeoutMs: () => 77_000,
		});
		research.mockResolvedValue({
			ok: true,
			text: "ok",
			elapsedMs: 1,
		} satisfies ResearchOutcome);
		registerModesDelegateTargets(deps);
		await getDelegateTarget("researcher")?.execute({ message: "q", ctx });
		expect(research).toHaveBeenCalledWith("q", {
			timeoutMs: 77_000,
			signal: undefined,
		});
	});

	it("researcher failures become text + details.error, never a throw", async () => {
		const { deps, research, warnings } = makeDeps();
		research.mockResolvedValue({
			ok: false,
			reason: "timeout",
			elapsedMs: 5000,
			timeoutMs: 5000,
		} satisfies ResearchOutcome);
		registerModesDelegateTargets(deps);
		const out = await getDelegateTarget("researcher")?.execute({
			message: "q",
			ctx,
		});
		expect(out?.text).toContain("[research timeout");
		expect((out?.details as { error: string }).error).toBe("timeout");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("timed out");
	});

	it("explorer is gated on plan mode via isAvailable", () => {
		let mode = "plan";
		const { deps } = makeDeps({ isPlanMode: () => mode === "plan" });
		registerModesDelegateTargets(deps);
		const explorer = getDelegateTarget("explorer");
		expect(explorer?.isAvailable?.(ctx)).toBe(true);
		mode = "auto";
		expect(explorer?.isAvailable?.(ctx)).toBe(false);
		// researcher has no gate at all.
		expect(getDelegateTarget("researcher")?.isAvailable).toBeUndefined();
	});

	it("explorer asks the mailbox and returns the answer text", async () => {
		const { deps, ask, wait } = makeDeps();
		wait.mockResolvedValue({ status: "done", text: "files live in src/" });
		registerModesDelegateTargets(deps);
		const out = await getDelegateTarget("explorer")?.execute({
			message: "where do files live?",
			ctx,
			timeoutMs: 9000,
		});
		expect(ask).toHaveBeenCalledWith("where do files live?");
		expect(wait).toHaveBeenCalledWith("e1", 9000, undefined);
		expect(out?.text).toBe("files live in src/");
	});

	it("explorer forwards the host abort signal into mailbox.wait", async () => {
		const { deps, wait } = makeDeps();
		wait.mockResolvedValue({ status: "done", text: "ok" });
		registerModesDelegateTargets(deps);
		const ctrl = new AbortController();
		await getDelegateTarget("explorer")?.execute({
			message: "q",
			ctx,
			timeoutMs: 9000,
			signal: ctrl.signal,
		});
		expect(wait).toHaveBeenCalledWith("e1", 9000, ctrl.signal);
	});

	it("explorer error/timeout statuses become structured failures", async () => {
		const { deps, wait } = makeDeps();
		wait.mockResolvedValue({ status: "timeout", error: "no answer in time" });
		registerModesDelegateTargets(deps);
		const out = await getDelegateTarget("explorer")?.execute({
			message: "q",
			ctx,
		});
		expect(out?.text).toBe("[delegate explorer timeout] no answer in time");
		expect(out?.details).toEqual({
			error: "timeout",
			detail: "no answer in time",
		});
	});
});
