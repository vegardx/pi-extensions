/**
 * Tests for #159c — configurable parallelism + queue-depth knobs on
 * ExploreMailbox.
 *
 * Coverage:
 *   - `parallelism: 1` (default) disables children entirely. Even
 *     `related: false` while seed busy stays on seed FIFO.
 *   - `parallelism: 3 + queueDepthThreshold: huge` — `related: false`
 *     while seed busy spawns children up to the cap.
 *   - Children-cap enforcement: 2 children running + new
 *     `related: false` ask falls back to seed FIFO.
 *   - `queueDepthThreshold: 1` — burst mode promotes default-related
 *     asks to children once seed has any in-flight job.
 *   - Burst mode respects parallelism cap (won't fan out past it).
 *   - Sanitisers: invalid types and out-of-range values fall back to
 *     defaults; `Math.floor` applied to fractional positives.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	DEFAULT_PARALLELISM,
	DEFAULT_QUEUE_DEPTH_THRESHOLD,
	ExploreMailbox,
	type MailboxDeps,
	sanitiseParallelism,
	sanitiseQueueDepthThreshold,
} from "../plan/explore-mailbox.js";

interface MockAgent {
	prompt: ReturnType<typeof vi.fn>;
	followUp: ReturnType<typeof vi.fn>;
	getLastText: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	onEvent: (listener: (event: AgentEvent) => void) => () => void;
	emit: (event: AgentEvent) => void;
	setLastText: (text: string) => void;
}

function makeMockAgent(): MockAgent {
	const listeners = new Set<(event: AgentEvent) => void>();
	let lastText = "";
	const agent: MockAgent = {
		prompt: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		getLastText: vi.fn(async () => lastText),
		dispose: vi.fn().mockResolvedValue(undefined),
		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event) => {
			for (const l of listeners) l(event);
		},
		setLastText: (t) => {
			lastText = t;
		},
	};
	return agent;
}

interface Harness {
	deps: MailboxDeps;
	seedAgent: MockAgent;
	spawnChildAgentSpy: ReturnType<typeof vi.fn>;
	childAgents: MockAgent[];
}

function makeHarness(): Harness {
	const seedAgent = makeMockAgent();
	const spawnAgentSpy = vi.fn(async () => ({
		agent: seedAgent as never,
		dispose: vi.fn().mockResolvedValue(undefined),
	}));
	const childAgents: MockAgent[] = [];
	const spawnChildAgentSpy = vi.fn(async () => {
		const agent = makeMockAgent();
		childAgents.push(agent);
		return {
			agent: agent as never,
			dispose: vi.fn().mockResolvedValue(undefined),
		};
	});
	return {
		deps: {
			spawnAgent: spawnAgentSpy,
			spawnChildAgent: spawnChildAgentSpy,
		},
		seedAgent,
		spawnChildAgentSpy,
		childAgents,
	};
}

const CTX = { cwd: "/fake/repo", hasUI: false } as never;

async function flush(): Promise<void> {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

function completeTurn(agent: MockAgent, text: string): void {
	agent.setLastText(text);
	agent.emit({ type: "agent_start" });
	agent.emit({ type: "agent_end", messages: [] });
}

describe("ExploreMailbox parallelism & queue-depth (#159c)", () => {
	describe("parallelism: 1 (default) — children disabled", () => {
		it("default opts: related: false while seed busy still routes to seed", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id } = await mailbox.ask("second", { related: false });

			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});

		it("explicit parallelism: 1 also keeps children disabled", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, { parallelism: 1 });

			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id } = await mailbox.ask("second", { related: false });

			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});

		it("parallelism: 1 + low queueDepthThreshold still no children (cap wins)", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 1,
				queueDepthThreshold: 1,
			});

			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			// Burst would normally promote this, but parallelism cap = 1
			// means there's no slot for a child.
			const { id } = await mailbox.ask("second");
			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});
	});

	describe("parallelism > 1 — children cap enforced", () => {
		it("parallelism: 3 — first two related: false asks spawn 2 children", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 3,
				queueDepthThreshold: 999,
			});

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id: c1 } = await mailbox.ask("orth 1", { related: false });
			const { id: c2 } = await mailbox.ask("orth 2", { related: false });
			await flush();

			expect(c1).toMatch(/^c/);
			expect(c2).toMatch(/^c/);
			expect(h.spawnChildAgentSpy).toHaveBeenCalledTimes(2);
		});

		it("parallelism: 3 — third orthogonal ask falls back to seed (cap reached)", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 3,
				queueDepthThreshold: 999,
			});

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			await mailbox.ask("orth 1", { related: false });
			await mailbox.ask("orth 2", { related: false });
			await flush();

			// Both children now in flight; cap is 2 (= parallelism - 1).
			// Next orthogonal ask must fall back to seed FIFO.
			const { id: third } = await mailbox.ask("orth 3", { related: false });

			expect(third).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).toHaveBeenCalledTimes(2);
		});

		it("parallelism: 2 — exactly 1 child slot", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 2,
				queueDepthThreshold: 999,
			});

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id: c1 } = await mailbox.ask("orth 1", { related: false });
			expect(c1).toMatch(/^c/);

			const { id: c2 } = await mailbox.ask("orth 2", { related: false });
			expect(c2).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("queueDepthThreshold — burst-mode promotion", () => {
		it("threshold: 1 — second default-related ask while seed busy spawns child", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 3,
				queueDepthThreshold: 1,
			});

			// Seed depth = 0, ask 1 routes to seed.
			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			// Seed depth = 1 >= threshold; default-related now bursts.
			const { id } = await mailbox.ask("second");
			expect(id).toMatch(/^c/);
			expect(h.spawnChildAgentSpy).toHaveBeenCalledOnce();
		});

		it("threshold: 999 — burst never fires; default-related stays on seed", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 3,
				queueDepthThreshold: 999,
			});

			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id } = await mailbox.ask("second");
			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});

		it("burst still respects parallelism cap", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 2,
				queueDepthThreshold: 1,
			});

			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			// First burst-promotion goes to child.
			const { id: c1 } = await mailbox.ask("second");
			expect(c1).toMatch(/^c/);

			// Second burst-promotion can't — child slot saturated.
			const { id: q1 } = await mailbox.ask("third");
			expect(q1).toMatch(/^q/);
		});

		it("acceptance: parallelism: 3 + queueDepthThreshold: 1, three default-related asks → ≥2 children", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: 3,
				queueDepthThreshold: 1,
			});

			const ids: string[] = [];
			ids.push((await mailbox.ask("q1")).id);
			await flush();
			h.seedAgent.emit({ type: "agent_start" });
			ids.push((await mailbox.ask("q2")).id);
			ids.push((await mailbox.ask("q3")).id);
			await flush();

			const childCount = ids.filter((id) => id.startsWith("c")).length;
			expect(childCount).toBeGreaterThanOrEqual(2);
		});
	});

	describe("sanitisers — invalid input falls back to defaults", () => {
		it("sanitiseParallelism: rejects strings, NaN, Infinity, zero, negatives", () => {
			expect(sanitiseParallelism("3" as unknown)).toBe(DEFAULT_PARALLELISM);
			expect(sanitiseParallelism(Number.NaN)).toBe(DEFAULT_PARALLELISM);
			expect(sanitiseParallelism(Number.POSITIVE_INFINITY)).toBe(
				DEFAULT_PARALLELISM,
			);
			expect(sanitiseParallelism(0)).toBe(DEFAULT_PARALLELISM);
			expect(sanitiseParallelism(-2)).toBe(DEFAULT_PARALLELISM);
			expect(sanitiseParallelism(undefined)).toBe(DEFAULT_PARALLELISM);
			expect(sanitiseParallelism(null)).toBe(DEFAULT_PARALLELISM);
		});

		it("sanitiseParallelism: floors fractional positives", () => {
			expect(sanitiseParallelism(2.7)).toBe(2);
			expect(sanitiseParallelism(1.0)).toBe(1);
			expect(sanitiseParallelism(10)).toBe(10);
		});

		it("sanitiseQueueDepthThreshold: same rules", () => {
			expect(sanitiseQueueDepthThreshold("4" as unknown)).toBe(
				DEFAULT_QUEUE_DEPTH_THRESHOLD,
			);
			expect(sanitiseQueueDepthThreshold(0)).toBe(
				DEFAULT_QUEUE_DEPTH_THRESHOLD,
			);
			expect(sanitiseQueueDepthThreshold(-1)).toBe(
				DEFAULT_QUEUE_DEPTH_THRESHOLD,
			);
			expect(sanitiseQueueDepthThreshold(2)).toBe(2);
			expect(sanitiseQueueDepthThreshold(2.9)).toBe(2);
			expect(sanitiseQueueDepthThreshold(undefined)).toBe(
				DEFAULT_QUEUE_DEPTH_THRESHOLD,
			);
		});

		it("constructor accepts sanitised values", async () => {
			const h = makeHarness();
			// Garbage values → mailbox falls back to defaults
			// (parallelism: 1, threshold: 4) → children disabled.
			const mailbox = new ExploreMailbox(CTX, h.deps, {
				parallelism: -5 as unknown as number,
				queueDepthThreshold: "not a number" as unknown as number,
			});

			await mailbox.ask("first");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id } = await mailbox.ask("second", { related: false });
			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});
	});

	// Suppress vitest's unused-mock noise for `completeTurn`. The helper is
	// kept available in case future tests need to drain seed turns.
	void completeTurn;
});
