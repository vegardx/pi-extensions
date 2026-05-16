/**
 * Tests for the #159b seed-and-children dispatch model on ExploreMailbox.
 *
 * Coverage:
 *   - Default `related: true` (and unspecified) keeps everything on
 *     seed FIFO — back-compat anchor.
 *   - `related: false` while seed idle → still seed (children are
 *     contention-only).
 *   - `related: false` while seed busy → spawns child agent in
 *     parallel; child id starts with `c`.
 *   - Child receives a Q/A snapshot prefix from the seed journal.
 *   - Child mailbox does not block seed; both run concurrently.
 *   - Graceful degradation when `spawnChildAgent` is omitted.
 *   - Graceful degradation when `spawnChildAgent` rejects (falls
 *     back to seed FIFO; ask still resolves).
 *   - Process-count assertion: each child = +1 spawn invocation.
 *   - check() / wait() / getState() merge seed + child results.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	ExploreMailbox,
	type MailboxDeps,
	renderJournalForChild,
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

interface ChildSpawn {
	agent: MockAgent;
	disposeSpy: ReturnType<typeof vi.fn>;
}

interface DepsHarness {
	deps: MailboxDeps;
	seedAgent: MockAgent;
	seedDisposeSpy: ReturnType<typeof vi.fn>;
	spawnAgentSpy: ReturnType<typeof vi.fn>;
	spawnChildAgentSpy: ReturnType<typeof vi.fn>;
	childSpawns: ChildSpawn[];
	/** Seed test in advance: the next N children's mock agents. */
	queueChild: (agent: MockAgent) => void;
}

function makeHarness(opts?: { withChild?: boolean }): DepsHarness {
	const seedAgent = makeMockAgent();
	const seedDisposeSpy = vi.fn().mockResolvedValue(undefined);
	const spawnAgentSpy = vi.fn(async () => ({
		agent: seedAgent as never,
		dispose: seedDisposeSpy,
	}));

	const queue: MockAgent[] = [];
	const childSpawns: ChildSpawn[] = [];
	const spawnChildAgentSpy = vi.fn(async () => {
		const agent = queue.shift() ?? makeMockAgent();
		const disposeSpy = vi.fn().mockResolvedValue(undefined);
		childSpawns.push({ agent, disposeSpy });
		return {
			agent: agent as never,
			dispose: disposeSpy,
		};
	});

	const deps: MailboxDeps = {
		spawnAgent: spawnAgentSpy,
		...(opts?.withChild !== false
			? { spawnChildAgent: spawnChildAgentSpy }
			: {}),
	};

	return {
		deps,
		seedAgent,
		seedDisposeSpy,
		spawnAgentSpy,
		spawnChildAgentSpy,
		childSpawns,
		queueChild: (a: MockAgent) => {
			queue.push(a);
		},
	};
}

const CTX = { cwd: "/fake/repo", hasUI: false } as never;

function completeTurn(agent: MockAgent, answer: string): void {
	agent.setLastText(answer);
	agent.emit({ type: "agent_start" });
	agent.emit({ type: "agent_end", messages: [] });
}

async function flush(): Promise<void> {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

describe("ExploreMailbox seed-and-children (#159b)", () => {
	describe("seed reuse — default related and explicit related: true", () => {
		it("default ask routes to seed (no child spawn)", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps);

			const { id } = await mailbox.ask("first");

			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});

		it("related: true uses seed even when seed is busy", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps);

			const { id: id1 } = await mailbox.ask("first", { related: true });
			expect(id1).toMatch(/^q/);
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			// Seed is now busy. Related: true should still queue on seed.
			const { id: id2 } = await mailbox.ask("second", { related: true });
			expect(id2).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();

			// Verify FIFO ordering on the seed.
			const state = mailbox.getState();
			expect(state.tasks.map((t) => t.id)).toEqual([id1, id2]);
		});

		it("related: false while seed idle still routes to seed", async () => {
			const h = makeHarness();
			const mailbox = new ExploreMailbox(CTX, h.deps);

			const { id } = await mailbox.ask("orthogonal but seed is idle", {
				related: false,
			});

			expect(id).toMatch(/^q/);
			expect(h.spawnChildAgentSpy).not.toHaveBeenCalled();
		});
	});

	describe("child spawn — related: false while seed busy", () => {
		it("spawns a child agent and assigns a `c` id", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			// Get seed busy.
			const { id: seedId } = await mailbox.ask("seed work");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			// Now an orthogonal question.
			const { id: childId } = await mailbox.ask("totally different topic", {
				related: false,
			});

			expect(seedId).toMatch(/^q/);
			expect(childId).toMatch(/^c/);
			await flush();

			expect(h.spawnChildAgentSpy).toHaveBeenCalledOnce();
			expect(childAgent.prompt).toHaveBeenCalledOnce();
		});

		it("each child invocation is +1 spawnChildAgent call (process-count)", async () => {
			const h = makeHarness();
			h.queueChild(makeMockAgent());
			h.queueChild(makeMockAgent());

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			await mailbox.ask("orth 1", { related: false });
			await mailbox.ask("orth 2", { related: false });
			await flush();

			expect(h.spawnChildAgentSpy).toHaveBeenCalledTimes(2);
			// Seed only spawned once.
			expect(h.spawnAgentSpy).toHaveBeenCalledTimes(1);
		});

		it("seed and children dispatch in parallel — both prompt() in flight", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			await mailbox.ask("child q", { related: false });
			await flush();

			// Both agents have received prompt() concurrently.
			expect(h.seedAgent.prompt).toHaveBeenCalledOnce();
			expect(childAgent.prompt).toHaveBeenCalledOnce();

			const state = mailbox.getState();
			expect(state.tasks).toHaveLength(2);
			// Seed running, child running (after agent_start emitted).
			childAgent.emit({ type: "agent_start" });
			const post = mailbox.getState();
			expect(post.tasks.find((t) => t.id.startsWith("q"))?.status).toBe(
				"running",
			);
			expect(post.tasks.find((t) => t.id.startsWith("c"))?.status).toBe(
				"running",
			);
		});

		it("child agent is disposed after its task completes", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id } = await mailbox.ask("child q", { related: false });
			await flush();
			completeTurn(childAgent, "child answer");
			await flush();

			expect(h.childSpawns[0]?.disposeSpy).toHaveBeenCalledOnce();
			const state = mailbox.check({ id });
			expect(state.tasks[0]?.status).toBe("done");
			expect(state.tasks[0]?.text).toBe("child answer");
		});
	});

	describe("snapshot context handoff", () => {
		it("renderJournalForChild returns empty when journal is empty", () => {
			expect(renderJournalForChild([])).toBe("");
		});

		it("renderJournalForChild includes prior Q/A pairs", () => {
			const rendered = renderJournalForChild([
				{ question: "where is auth?", answer: "in src/auth/." },
				{ question: "who calls login()?", answer: "the login route." },
			]);
			expect(rendered).toContain("prior exploration context");
			expect(rendered).toContain("Q: where is auth?");
			expect(rendered).toContain("A: in src/auth/.");
			expect(rendered).toContain("Q: who calls login()?");
			expect(rendered).toContain("Now answer the next question");
		});

		it("renderJournalForChild caps at 6 most recent pairs", () => {
			const journal = Array.from({ length: 10 }, (_, i) => ({
				question: `q${i}`,
				answer: `a${i}`,
			}));
			const rendered = renderJournalForChild(journal);
			// Only the last 6 should appear.
			expect(rendered).not.toContain("Q: q0");
			expect(rendered).not.toContain("Q: q3");
			expect(rendered).toContain("Q: q4");
			expect(rendered).toContain("Q: q9");
		});

		it("renderJournalForChild truncates over-long entries", () => {
			const longAnswer = "x".repeat(2000);
			const rendered = renderJournalForChild([
				{ question: "hi", answer: longAnswer },
			]);
			// Per-entry budget is 600 chars; truncated marker present.
			expect(rendered).toContain("…");
			expect(rendered.length).toBeLessThan(2200);
		});

		it("child receives prior seed Q/A as a prompt prefix", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			// Seed a completed exchange so journal has an entry.
			await mailbox.ask("where is auth?");
			completeTurn(h.seedAgent, "in src/auth");
			await flush();

			// Second seed task starts (busy).
			await mailbox.ask("who calls login()?");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			// Child fires.
			await mailbox.ask("how does the build work?", { related: false });
			await flush();

			expect(childAgent.prompt).toHaveBeenCalledOnce();
			const promptText = childAgent.prompt.mock.calls[0]?.[0] as string;
			expect(promptText).toContain("prior exploration context");
			expect(promptText).toContain("Q: where is auth?");
			expect(promptText).toContain("A: in src/auth");
			expect(promptText).toContain("how does the build work?");
		});

		it("child gets bare question (no prefix) when seed has no completed asks", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			// Seed task running but never completed.
			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			await mailbox.ask("child q", { related: false });
			await flush();

			const promptText = childAgent.prompt.mock.calls[0]?.[0] as string;
			expect(promptText).toBe("child q");
			expect(promptText).not.toContain("prior exploration");
		});
	});

	describe("graceful degradation", () => {
		it("falls back to seed when spawnChildAgent is undefined", async () => {
			const h = makeHarness({ withChild: false });
			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			const { id } = await mailbox.ask("orthogonal q", { related: false });
			expect(id).toMatch(/^q/);
		});

		it("falls back to seed when spawnChildAgent rejects", async () => {
			const seedAgent = makeMockAgent();
			const spawnAgentSpy = vi.fn(async () => ({
				agent: seedAgent as never,
				dispose: vi.fn().mockResolvedValue(undefined),
			}));
			const spawnChildAgentSpy = vi
				.fn()
				.mockRejectedValue(new Error("child boot failed"));
			const deps: MailboxDeps = {
				spawnAgent: spawnAgentSpy,
				spawnChildAgent: spawnChildAgentSpy,
			};
			const mailbox = new ExploreMailbox(CTX, deps);

			// Get seed busy.
			await mailbox.ask("seed");
			await flush();
			seedAgent.emit({ type: "agent_start" });

			// Child enqueue itself succeeds (returns id with `c` prefix);
			// the error surfaces as the child task's terminal status.
			const { id } = await mailbox.ask("child", { related: false });
			expect(id).toMatch(/^c/);
			await flush();

			const result = mailbox.check({ id });
			expect(result.tasks[0]?.status).toBe("error");
			expect(result.tasks[0]?.error).toMatch(/child boot failed/);

			// Subsequent ask still works (mailbox not poisoned).
			completeTurn(seedAgent, "seed answer");
			await flush();
			const { id: id2 } = await mailbox.ask("after");
			expect(id2).toMatch(/^q/);
		});
	});

	describe("merged surface — check / wait / getState", () => {
		it("getState() merges seed and child tasks", async () => {
			const h = makeHarness();
			h.queueChild(makeMockAgent());

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });

			await mailbox.ask("child q", { related: false });
			await flush();

			const state = mailbox.getState();
			expect(state.tasks).toHaveLength(2);
			expect(state.tasks.some((t) => t.id.startsWith("q"))).toBe(true);
			expect(state.tasks.some((t) => t.id.startsWith("c"))).toBe(true);
		});

		it("check() drains terminal tasks across both mailboxes", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });
			await mailbox.ask("child q", { related: false });
			await flush();

			completeTurn(h.seedAgent, "seed answer");
			completeTurn(childAgent, "child answer");
			await flush();

			const drained = mailbox.check();
			expect(drained.tasks).toHaveLength(2);
			const remaining = mailbox.getState();
			expect(remaining.tasks).toHaveLength(0);
		});

		it("wait() routes by id prefix", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });
			const { id: childId } = await mailbox.ask("child q", { related: false });
			await flush();

			const waitPromise = mailbox.wait(childId, 5000);
			completeTurn(childAgent, "child answer");
			await flush();
			const result = await waitPromise;
			expect(result.text).toBe("child answer");
		});

		it("hasInFlight reflects either mailbox", async () => {
			const h = makeHarness();
			h.queueChild(makeMockAgent());

			const mailbox = new ExploreMailbox(CTX, h.deps);
			expect(mailbox.hasInFlight).toBe(false);

			await mailbox.ask("seed q");
			expect(mailbox.hasInFlight).toBe(true);

			await flush();
			h.seedAgent.emit({ type: "agent_start" });
			completeTurn(h.seedAgent, "answer");
			await flush();
			mailbox.check();
			expect(mailbox.hasInFlight).toBe(false);
		});

		it("onChange listener fires for both seed and child transitions", async () => {
			const h = makeHarness();
			const childAgent = makeMockAgent();
			h.queueChild(childAgent);

			const mailbox = new ExploreMailbox(CTX, h.deps);
			const listener = vi.fn();
			mailbox.onChange(listener);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });
			await mailbox.ask("child q", { related: false });
			await flush();
			completeTurn(childAgent, "child answer");
			await flush();

			// Multiple transitions fired across both mailboxes.
			expect(listener.mock.calls.length).toBeGreaterThan(3);
		});
	});

	describe("dispose", () => {
		it("dispose tears down both mailboxes", async () => {
			const h = makeHarness();
			h.queueChild(makeMockAgent());

			const mailbox = new ExploreMailbox(CTX, h.deps);

			await mailbox.ask("seed q");
			await flush();
			h.seedAgent.emit({ type: "agent_start" });
			await mailbox.ask("child q", { related: false });
			await flush();

			await mailbox.dispose();

			expect(h.seedDisposeSpy).toHaveBeenCalledOnce();
			await expect(mailbox.ask("after")).rejects.toThrow(/disposed/);
		});
	});
});
