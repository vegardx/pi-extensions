/**
 * Tests for ExploreMailbox — the async send/receive surface that
 * replaced the synchronous explore() tool.
 *
 * Strategy: stub the sub-agent with a hand-rolled mock that exposes
 * the real PersistentAgent surface (prompt, followUp, getLastText,
 * dispose, onEvent). Tests script RPC-style events to drive the
 * mailbox state machine and assert observable behaviour.
 */
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
	ExploreMailbox,
	exploreWidgetShouldHide,
	type MailboxDeps,
} from "../plan/explore-mailbox.js";

// ---- Mock agent -------------------------------------------------------------

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

function makeDeps(agent: MockAgent): {
	deps: MailboxDeps;
	disposeSpy: ReturnType<typeof vi.fn>;
} {
	const disposeSpy = vi.fn().mockResolvedValue(undefined);
	const deps: MailboxDeps = {
		spawnAgent: vi.fn(async () => ({
			// Cast: tests only exercise the methods that ExploreMailbox calls.
			agent: agent as unknown as Parameters<
				MailboxDeps["spawnAgent"]
			>[0] extends never
				? never
				: Awaited<ReturnType<MailboxDeps["spawnAgent"]>>["agent"],
			dispose: disposeSpy,
		})),
	};
	return { deps, disposeSpy };
}

const CTX = { cwd: "/fake/repo", hasUI: false } as never;

// Helper to drive a full agent_start → tool calls → agent_end cycle.
function completeTurn(agent: MockAgent, answer: string): void {
	agent.setLastText(answer);
	agent.emit({ type: "agent_start" });
	agent.emit({ type: "agent_end", messages: [] });
}

// Helper to flush microtasks so completeTask() can resolve.
async function flush(): Promise<void> {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
}

// ---- Tests ------------------------------------------------------------------

describe("ExploreMailbox", () => {
	it("ask returns immediately with a task id", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const { id } = await mailbox.ask("how does X work?");
		expect(id).toBe("q1");

		await flush();

		// Spawned, prompted, but no answer yet.
		expect(agent.prompt).toHaveBeenCalledOnce();
		expect(agent.prompt).toHaveBeenCalledWith("how does X work?");
		const state = mailbox.getState();
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.status).toBe("queued");
	});

	it("dispatches via prompt() one task at a time, never followUp()", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("q1");
		await mailbox.ask("q2");
		await mailbox.ask("q3");

		// Only the head task is dispatched while the agent is busy.
		expect(agent.prompt).toHaveBeenCalledOnce();
		expect(agent.prompt).toHaveBeenCalledWith("q1");
		expect(agent.followUp).not.toHaveBeenCalled();

		completeTurn(agent, "a1");
		await flush();
		expect(agent.prompt).toHaveBeenCalledTimes(2);
		expect(agent.prompt.mock.calls[1]?.[0]).toBe("q2");

		completeTurn(agent, "a2");
		await flush();
		expect(agent.prompt).toHaveBeenCalledTimes(3);
		expect(agent.prompt.mock.calls[2]?.[0]).toBe("q3");

		expect(agent.followUp).not.toHaveBeenCalled();
	});

	it("keeps dispatching after the agent goes idle (regression: dropped follow-ups)", async () => {
		// Real pi only drains agent.followUp() mid-cycle; on an idle agent
		// queued follow-ups never get processed. The mailbox must dispatch
		// each task via a fresh prompt() so every ask gets its own
		// agent_start/agent_end cycle.
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const { id: id1 } = await mailbox.ask("first");
		completeTurn(agent, "answer1");
		await flush();
		expect(mailbox.check({ id: id1 }).tasks[0]?.status).toBe("done");

		// Agent has gone idle. Asking again must dispatch via prompt(),
		// not enqueue via followUp() (which would be silently dropped).
		const { id: id2 } = await mailbox.ask("second");
		expect(agent.prompt).toHaveBeenCalledTimes(2);
		expect(agent.prompt.mock.calls[1]?.[0]).toBe("second");
		expect(agent.followUp).not.toHaveBeenCalled();

		completeTurn(agent, "answer2");
		await flush();
		expect(mailbox.check({ id: id2 }).tasks[0]?.status).toBe("done");
		expect(mailbox.check({ id: id2 }).tasks[0]?.text).toBe("answer2");
	});

	it("agent_start advances the FIFO head to running", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("first");
		await mailbox.ask("second");

		agent.emit({ type: "agent_start" });
		const state = mailbox.getState();
		expect(state.tasks[0]?.status).toBe("running");
		expect(state.tasks[1]?.status).toBe("queued");
	});

	it("agent_end resolves the running task with the agent's last text", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("first");
		completeTurn(agent, "the answer");
		await flush();

		const state = mailbox.getState();
		expect(state.tasks[0]?.status).toBe("done");
		expect(state.tasks[0]?.text).toBe("the answer");
	});

	it("FIFO correlation across multiple turns", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("first");
		await mailbox.ask("second");

		completeTurn(agent, "answer1");
		await flush();
		completeTurn(agent, "answer2");
		await flush();

		const state = mailbox.getState();
		expect(state.tasks[0]?.text).toBe("answer1");
		expect(state.tasks[1]?.text).toBe("answer2");
	});

	it("check() drains terminal tasks but leaves pending ones", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("first");
		await mailbox.ask("second");

		completeTurn(agent, "answer1");
		await flush();

		// One done, one running.
		agent.emit({ type: "agent_start" });

		const result = mailbox.check();
		expect(result.tasks).toHaveLength(2);
		// After draining, the done task is gone but the running one stays.
		const post = mailbox.getState();
		expect(post.tasks).toHaveLength(1);
		expect(post.tasks[0]?.status).toBe("running");
	});

	it("check({ id }) returns a single task without draining", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const { id } = await mailbox.ask("first");
		completeTurn(agent, "answer");
		await flush();

		const peek = mailbox.check({ id });
		expect(peek.tasks).toHaveLength(1);
		expect(peek.tasks[0]?.status).toBe("done");

		// Not drained.
		expect(mailbox.getState().tasks).toHaveLength(1);
	});

	it("check({ drain: false }) leaves everything in place", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("first");
		completeTurn(agent, "answer");
		await flush();

		mailbox.check({ drain: false });
		expect(mailbox.getState().tasks).toHaveLength(1);
	});

	it("notify() events become notifications on the next check", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("trace lifecycle");
		agent.emit({ type: "agent_start" });
		agent.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "notify",
			args: { text: "found suspicious shadowing", kind: "finding" },
		});

		const result = mailbox.check();
		expect(result.notifications).toHaveLength(1);
		expect(result.notifications[0]?.text).toBe("found suspicious shadowing");
		expect(result.notifications[0]?.kind).toBe("finding");
		expect(result.notifications[0]?.taskId).toBe("q1");

		// Drained.
		expect(mailbox.getState().notifications).toHaveLength(0);
	});

	it("notify() with empty text is ignored", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("q");
		agent.emit({ type: "agent_start" });
		agent.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "notify",
			args: { text: "" },
		});

		expect(mailbox.getState().notifications).toHaveLength(0);
	});

	it("non-notify tool calls update lastToolSummary on the running task", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("q");
		agent.emit({ type: "agent_start" });
		agent.emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "read",
			args: { path: "src/foo.ts" },
		});

		const state = mailbox.getState();
		expect(state.tasks[0]?.lastToolSummary).toBe("read src/foo.ts");
		expect(state.notifications).toHaveLength(0);
	});

	it("wait resolves when the task completes", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const { id } = await mailbox.ask("q");
		const waiting = mailbox.wait(id, 5_000);

		completeTurn(agent, "answered");
		await flush();

		const result = await waiting;
		expect(result.status).toBe("done");
		expect(result.text).toBe("answered");
	});

	it("wait returns a synthetic timeout record without disposing the agent", async () => {
		const agent = makeMockAgent();
		const { deps, disposeSpy } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const { id } = await mailbox.ask("q");
		const result = await mailbox.wait(id, 10);
		expect(result.status).toBe("timeout");
		expect(result.error).toMatch(/timed out/);

		// Underlying task is still queued, agent is alive.
		expect(disposeSpy).not.toHaveBeenCalled();
		expect(mailbox.getState().tasks[0]?.status).toBe("queued");

		// And the real completion is still observed when the turn ends.
		completeTurn(agent, "late");
		await flush();
		expect(mailbox.getState().tasks[0]?.status).toBe("done");
		expect(mailbox.getState().tasks[0]?.text).toBe("late");
	});

	it("wait on an already-terminal task returns immediately", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const { id } = await mailbox.ask("q");
		completeTurn(agent, "done");
		await flush();

		const result = await mailbox.wait(id, 10);
		expect(result.status).toBe("done");
	});

	it("wait on an unknown id returns an error record", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		const result = await mailbox.wait("q999", 10);
		expect(result.status).toBe("error");
		expect(result.error).toMatch(/unknown task id/);
	});

	it("ask reports an error when spawn fails — does not crash the mailbox", async () => {
		const failingDeps: MailboxDeps = {
			spawnAgent: vi.fn().mockRejectedValue(new Error("no model")),
		};
		const mailbox = new ExploreMailbox(CTX, failingDeps);
		const { id } = await mailbox.ask("q");
		await flush();
		const result = mailbox.check({ id });
		expect(result.tasks[0]?.status).toBe("error");
		expect(result.tasks[0]?.error).toBe("no model");
	});

	it("dispose tears down the spawned agent and clears state", async () => {
		const agent = makeMockAgent();
		const { deps, disposeSpy } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);

		await mailbox.ask("q");
		await mailbox.dispose();

		expect(disposeSpy).toHaveBeenCalledOnce();
		await expect(mailbox.ask("again")).rejects.toThrow(/disposed/);
	});

	it("onChange listener fires on state transitions", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent);
		const mailbox = new ExploreMailbox(CTX, deps);
		const listener = vi.fn();
		mailbox.onChange(listener);

		await mailbox.ask("q");
		agent.emit({ type: "agent_start" });
		completeTurn(agent, "answer");
		await flush();

		// At least: ask, agent_start (running), agent_end (done).
		expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
	});
});

// ---------------------------------------------------------------------------
// exploreWidgetShouldHide — visibility gate for the explore panel
// ---------------------------------------------------------------------------

describe("exploreWidgetShouldHide", () => {
	it("hides when mailbox is empty", () => {
		expect(exploreWidgetShouldHide([], [])).toBe(true);
	});

	it("hides when all tasks are done and no notifications", () => {
		const tasks = [
			{ id: "a", question: "q", status: "done" as const, enqueuedAt: 0 },
			{ id: "b", question: "q2", status: "error" as const, enqueuedAt: 0 },
		];
		expect(exploreWidgetShouldHide(tasks, [])).toBe(true);
	});

	it("hides when all tasks are timeout and no notifications", () => {
		const tasks = [
			{ id: "a", question: "q", status: "timeout" as const, enqueuedAt: 0 },
		];
		expect(exploreWidgetShouldHide(tasks, [])).toBe(true);
	});

	it("shows when a task is running", () => {
		const tasks = [
			{ id: "a", question: "q", status: "running" as const, enqueuedAt: 0 },
		];
		expect(exploreWidgetShouldHide(tasks, [])).toBe(false);
	});

	it("shows when a task is queued", () => {
		const tasks = [
			{ id: "a", question: "q", status: "queued" as const, enqueuedAt: 0 },
		];
		expect(exploreWidgetShouldHide(tasks, [])).toBe(false);
	});

	it("shows when no tasks but there are notifications", () => {
		const notifications = [{ id: "n1", text: "msg", at: Date.now() }];
		expect(exploreWidgetShouldHide([], notifications)).toBe(false);
	});

	it("shows when all tasks done but notifications pending", () => {
		const tasks = [
			{ id: "a", question: "q", status: "done" as const, enqueuedAt: 0 },
		];
		const notifications = [{ id: "n1", text: "result", at: Date.now() }];
		expect(exploreWidgetShouldHide(tasks, notifications)).toBe(false);
	});
});
