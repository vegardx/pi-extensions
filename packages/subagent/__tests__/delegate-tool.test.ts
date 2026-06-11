/**
 * Tests for the generic delegate tool: target resolution, gating,
 * passthrough, answer capping, and semaphore behaviour — all without
 * a pi host (targets injected via the shared registry, `execute`
 * called directly).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	clearDelegateTargets,
	type DelegateTarget,
	registerDelegateTarget,
} from "@vegardx/pi-extensions-shared/delegate-registry.js";
import { buildDelegateTool, type DelegateToolDeps } from "../delegate-tool.js";
import { Semaphore } from "../semaphore.js";

let cwd: string;

function makeCtx(): ExtensionContext {
	return { cwd } as ExtensionContext;
}

function writeSettings(body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body));
}

function makeTool(overrides?: Partial<DelegateToolDeps>) {
	const semaphore = overrides?.semaphore ?? new Semaphore();
	const submitJob =
		overrides?.submitJob ?? vi.fn().mockReturnValue({ id: "d1" });
	return {
		tool: buildDelegateTool({ semaphore, submitJob }),
		semaphore,
		submitJob,
	};
}

function target(name: string, extra?: Partial<DelegateTarget>): DelegateTarget {
	return {
		name,
		description: `${name} target`,
		execute: async ({ message }) => ({ text: `${name} says: ${message}` }),
		...extra,
	};
}

function resultText(out: {
	content: { type: string; text?: string }[];
}): string {
	return out.content[0]?.text ?? "";
}

describe("delegate tool", () => {
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
		clearDelegateTargets();
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("unknown target returns an error listing available targets", async () => {
		registerDelegateTarget(target("researcher"));
		registerDelegateTarget(target("explorer", { isAvailable: () => false }));
		const { tool } = makeTool();
		const out = await tool.execute(
			"t1",
			{ to: "nope", message: "hi" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(resultText(out)).toContain('unknown target "nope"');
		expect(resultText(out)).toContain('"researcher" — researcher target');
		// Gated-off targets don't appear in the available list.
		expect(resultText(out)).not.toContain('"explorer"');
		expect(out.details?.error).toBe("unknown-target");
		expect(out.details?.available).toEqual(["researcher"]);
	});

	it("registered-but-unavailable target returns a gating error", async () => {
		registerDelegateTarget(target("explorer", { isAvailable: () => false }));
		const { tool } = makeTool();
		const out = await tool.execute(
			"t1",
			{ to: "explorer", message: "hi" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(resultText(out)).toContain('"explorer" is not available');
		expect(out.details?.error).toBe("target-unavailable");
	});

	it("passes message, params, signal and sanitized timeout through to execute", async () => {
		const seen: Record<string, unknown> = {};
		registerDelegateTarget(
			target("researcher", {
				execute: async (args) => {
					Object.assign(seen, args);
					return { text: "ok", details: { elapsedMs: 5 } };
				},
			}),
		);
		const { tool } = makeTool();
		const ac = new AbortController();
		const out = await tool.execute(
			"t1",
			{
				to: "researcher",
				message: "find docs",
				params: { depth: 2 },
				timeoutMs: 1234,
			},
			ac.signal,
			undefined,
			makeCtx(),
		);
		expect(seen.message).toBe("find docs");
		expect(seen.params).toEqual({ depth: 2 });
		expect(seen.timeoutMs).toBe(1234);
		expect(seen.signal).toBe(ac.signal);
		expect(resultText(out)).toBe("ok");
		expect(out.details).toEqual({ to: "researcher", result: { elapsedMs: 5 } });
	});

	it("nonsense timeoutMs is dropped rather than forwarded", async () => {
		let seenTimeout: number | undefined = 999;
		registerDelegateTarget(
			target("researcher", {
				execute: async ({ timeoutMs }) => {
					seenTimeout = timeoutMs;
					return { text: "ok" };
				},
			}),
		);
		const { tool } = makeTool();
		await tool.execute(
			"t1",
			{ to: "researcher", message: "q", timeoutMs: -5 },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(seenTimeout).toBeUndefined();
	});

	it("caps the answer at the configured maxAnswerChars", async () => {
		writeSettings({
			extensionConfig: { subagent: { delegate: { maxAnswerChars: 100 } } },
		});
		registerDelegateTarget(
			target("researcher", {
				execute: async () => ({ text: "x".repeat(500) }),
			}),
		);
		const { tool } = makeTool();
		const out = await tool.execute(
			"t1",
			{ to: "researcher", message: "q" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(resultText(out).length).toBeLessThanOrEqual(100);
		expect(resultText(out)).toContain("truncated at 100 chars");
	});

	it("a throwing target becomes a structured error result, not a tool crash", async () => {
		registerDelegateTarget(
			target("researcher", {
				execute: async () => {
					throw new Error("boom");
				},
			}),
		);
		const { tool, semaphore } = makeTool();
		const out = await tool.execute(
			"t1",
			{ to: "researcher", message: "q" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(resultText(out)).toBe("[delegate researcher error] boom");
		expect(out.details?.error).toBe("boom");
		// The slot was released despite the throw.
		expect(semaphore.activeCount).toBe(0);
	});

	it("respects the configured maxConcurrent via the semaphore", async () => {
		writeSettings({
			extensionConfig: { subagent: { delegate: { maxConcurrent: 1 } } },
		});
		const gates: Array<() => void> = [];
		registerDelegateTarget(
			target("researcher", {
				execute: () =>
					new Promise((res) => {
						gates.push(() => res({ text: "done" }));
					}),
			}),
		);
		const { tool, semaphore } = makeTool();
		const p1 = tool.execute(
			"t1",
			{ to: "researcher", message: "a" },
			undefined,
			undefined,
			makeCtx(),
		);
		const p2 = tool.execute(
			"t2",
			{ to: "researcher", message: "b" },
			undefined,
			undefined,
			makeCtx(),
		);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		// Only the first acquired a slot and reached the target.
		expect(gates).toHaveLength(1);
		expect(semaphore.queuedCount).toBe(1);
		gates[0]?.();
		await p1;
		await new Promise((r) => setImmediate(r));
		expect(gates).toHaveLength(2);
		gates[1]?.();
		await p2;
	});

	it("abort while queued for a slot returns a structured error", async () => {
		writeSettings({
			extensionConfig: { subagent: { delegate: { maxConcurrent: 1 } } },
		});
		registerDelegateTarget(
			target("researcher", {
				execute: () => new Promise(() => {}),
			}),
		);
		const { tool } = makeTool();
		const blocked = tool.execute(
			"t1",
			{ to: "researcher", message: "a" },
			undefined,
			undefined,
			makeCtx(),
		);
		const ac = new AbortController();
		const queued = tool.execute(
			"t2",
			{ to: "researcher", message: "b" },
			ac.signal,
			undefined,
			makeCtx(),
		);
		await new Promise((r) => setImmediate(r));
		ac.abort();
		const out = await queued;
		expect(resultText(out)).toContain("aborted while queued");
		expect(out.details?.error).toBe("aborted-while-queued");
		void blocked;
	});

	it("async:true submits a job and returns its id immediately", async () => {
		registerDelegateTarget(target("researcher"));
		const submitJob = vi.fn().mockReturnValue({ id: "d7" });
		const { tool } = makeTool({ submitJob });
		const out = await tool.execute(
			"t1",
			{
				to: "researcher",
				message: "slow question",
				async: true,
				params: { a: 1 },
			},
			undefined,
			undefined,
			makeCtx(),
		);
		expect(resultText(out)).toContain("queued job d7 → researcher");
		expect(out.details).toEqual({ to: "researcher", jobId: "d7" });
		expect(submitJob).toHaveBeenCalledTimes(1);
		const req = submitJob.mock.calls[0]?.[0];
		expect(req.message).toBe("slow question");
		expect(req.params).toEqual({ a: 1 });
		expect(req.target.name).toBe("researcher");
	});
});
