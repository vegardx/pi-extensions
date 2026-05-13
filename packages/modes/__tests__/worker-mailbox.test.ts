/**
 * Tests for WorkerMailbox — the per-chain wrapper around a pi
 * subagent.
 *
 * Strategy mirrors `explore-mailbox.test.ts`: hand-rolled MockAgent
 * exposes the PersistentAgent surface, deps inject a stub readPlan
 * so we don't touch disk.
 */
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Plan } from "../plan/schema.js";
import {
	diffWorkerEvents,
	WorkerMailbox,
	type WorkerMailboxDeps,
} from "../plan/worker-mailbox.js";
import type { WorkerNotification } from "../plan/worker-protocol.js";

interface MockAgent {
	prompt: ReturnType<typeof vi.fn>;
	getLastText: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	onEvent: (listener: (event: AgentEvent) => void) => () => void;
	emit: (event: AgentEvent) => void;
}

function makeMockAgent(): MockAgent {
	const listeners = new Set<(event: AgentEvent) => void>();
	const agent: MockAgent = {
		prompt: vi.fn().mockResolvedValue(undefined),
		getLastText: vi.fn(async () => ""),
		dispose: vi.fn().mockResolvedValue(undefined),
		onEvent: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (event) => {
			for (const l of listeners) l(event);
		},
	};
	return agent;
}

const CTX = { cwd: "/fake/repo", hasUI: false } as never;

function makeDeps(
	agent: MockAgent,
	plans: Plan[],
): { deps: WorkerMailboxDeps; readPlan: ReturnType<typeof vi.fn> } {
	let i = 0;
	const readPlan = vi.fn(() => plans[Math.min(i++, plans.length - 1)] ?? null);
	const deps: WorkerMailboxDeps = {
		spawnAgent: vi.fn(async () => ({
			agent: agent as unknown as Parameters<
				WorkerMailboxDeps["spawnAgent"]
			>[0] extends never
				? never
				: Awaited<ReturnType<WorkerMailboxDeps["spawnAgent"]>>["agent"],
			dispose: vi.fn().mockResolvedValue(undefined),
		})),
		readPlan,
	};
	return { deps, readPlan };
}

function plan(
	phases: Array<{ id: string; status: string; prNumber?: number }>,
): Plan {
	return {
		slug: "test",
		title: "t",
		summary: "",
		phases: phases.map((p, i) => ({
			id: p.id,
			title: p.id,
			goal: "",
			status: p.status as never,
			tasks: [],
			updatedAt: new Date(2026, 0, 1, 0, i).toISOString(),
			...(p.prNumber !== undefined ? { prNumber: p.prNumber } : {}),
			...(i > 0 ? { dependsOn: [phases[i - 1]!.id] } : {}),
		})) as never,
		updatedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		repo: { path: "/repo" },
		schemaVersion: 2,
	} as Plan;
}

describe("diffWorkerEvents", () => {
	it("emits phase-started when a phase flips to active", () => {
		const before = { p1: "planned" as const };
		const after = plan([{ id: "p1", status: "active" }]);
		after.phases[0]!.branch = "feat/p1";
		const events = diffWorkerEvents(before, after, "p1", "p1");
		expect(events).toContainEqual({
			kind: "phase-started",
			phaseId: "p1",
			branch: "feat/p1",
		} satisfies WorkerNotification);
	});

	it("emits phase-shipped with prNumber when a phase reaches in-review", () => {
		const before = { p1: "active" as const };
		const after = plan([{ id: "p1", status: "in-review", prNumber: 42 }]);
		const events = diffWorkerEvents(before, after, "p1", "p1");
		expect(events).toContainEqual({
			kind: "phase-shipped",
			phaseId: "p1",
			prNumber: 42,
		});
	});

	it("emits chain-complete when the head phase has no non-shipped descendant", () => {
		const before = { p1: "in-review" as const, p2: "planned" as const };
		const after = plan([
			{ id: "p1", status: "shipped" },
			{ id: "p2", status: "shipped" },
		]);
		const events = diffWorkerEvents(before, after, "p1", "p1");
		expect(events.find((e) => e.kind === "chain-complete")).toEqual({
			kind: "chain-complete",
			chainId: "p1",
		});
	});

	it("does NOT emit chain-complete while non-shipped descendants remain", () => {
		const before = { p1: "active" as const, p2: "planned" as const };
		const after = plan([
			{ id: "p1", status: "shipped" },
			{ id: "p2", status: "active" },
		]);
		const events = diffWorkerEvents(before, after, "p1", "p1");
		expect(events.find((e) => e.kind === "chain-complete")).toBeUndefined();
	});

	it("ignores phase status that didn't change", () => {
		const before = { p1: "active" as const };
		const after = plan([{ id: "p1", status: "active" }]);
		const events = diffWorkerEvents(before, after, "p1", "p1");
		expect(events).toEqual([]);
	});
});

describe("WorkerMailbox", () => {
	it("spawns the subagent and prompts /implement <chainHeadId>", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent, [plan([{ id: "p1", status: "planned" }])]);
		const mailbox = new WorkerMailbox(
			CTX,
			{ chainId: "p1", chainHeadId: "p1", planSlug: "test", cwd: "/repo" },
			deps,
		);
		await mailbox.start();
		expect(deps.spawnAgent).toHaveBeenCalledOnce();
		expect(agent.prompt).toHaveBeenCalledWith("/implement p1");
		expect(mailbox.getState().status).toBe("running");
	});

	it("emits phase-started and phase-shipped events as the plan progresses", async () => {
		const agent = makeMockAgent();
		const before = plan([{ id: "p1", status: "planned" }]);
		const afterStart = plan([{ id: "p1", status: "active" }]);
		afterStart.phases[0]!.branch = "feat/p1";
		const afterShip = plan([{ id: "p1", status: "in-review", prNumber: 7 }]);
		afterShip.phases[0]!.branch = "feat/p1";
		const { deps } = makeDeps(agent, [before, afterStart, afterShip]);
		const mailbox = new WorkerMailbox(
			CTX,
			{ chainId: "p1", chainHeadId: "p1", planSlug: "test", cwd: "/repo" },
			deps,
		);
		const events: WorkerNotification[] = [];
		mailbox.onEvent((e) => events.push(e));
		await mailbox.start();
		// First agent_end: status flipped planned → active.
		agent.emit({ type: "agent_end", messages: [] });
		// Second agent_end: status flipped active → in-review.
		agent.emit({ type: "agent_end", messages: [] });
		expect(events.find((e) => e.kind === "phase-started")).toEqual({
			kind: "phase-started",
			phaseId: "p1",
			branch: "feat/p1",
		});
		expect(events.find((e) => e.kind === "phase-shipped")).toEqual({
			kind: "phase-shipped",
			phaseId: "p1",
			prNumber: 7,
		});
	});

	it("captures tool execution summaries as live progress", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent, [plan([{ id: "p1", status: "planned" }])]);
		const mailbox = new WorkerMailbox(
			CTX,
			{ chainId: "p1", chainHeadId: "p1", planSlug: "test", cwd: "/repo" },
			deps,
		);
		await mailbox.start();
		agent.emit({
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "1",
			args: { command: "npm test" },
		} as unknown as AgentEvent);
		expect(mailbox.getState().lastToolSummary).toBe("$ npm test");
	});

	it("transitions to ended on agent_end and notifies onEnd handlers", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent, [plan([{ id: "p1", status: "planned" }])]);
		const mailbox = new WorkerMailbox(
			CTX,
			{ chainId: "p1", chainHeadId: "p1", planSlug: "test", cwd: "/repo" },
			deps,
		);
		await mailbox.start();
		const onEnd = vi.fn();
		mailbox.onEnd(onEnd);
		agent.emit({ type: "agent_end", messages: [] });
		expect(onEnd).toHaveBeenCalledOnce();
		expect(mailbox.getState().status).toBe("ended");
	});

	it("dispose() is idempotent", async () => {
		const agent = makeMockAgent();
		const { deps } = makeDeps(agent, [plan([{ id: "p1", status: "planned" }])]);
		const mailbox = new WorkerMailbox(
			CTX,
			{ chainId: "p1", chainHeadId: "p1", planSlug: "test", cwd: "/repo" },
			deps,
		);
		await mailbox.start();
		await mailbox.dispose();
		await mailbox.dispose();
		// No throw.
	});
});
