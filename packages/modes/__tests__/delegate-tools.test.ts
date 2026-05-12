/**
 * Tests for DelegateAgents.
 *
 * - explore: persistent sub-agent via SubagentPool.
 * - research: one-shot parallel spawns via runSubagent.
 */
import { vi } from "vitest";

vi.mock("@vegardx/pi-extensions-shared/subagent-pool.js", () => ({
	SubagentPool: vi.fn(),
}));

vi.mock("@vegardx/pi-extensions-shared/model-resolver.js", () => ({
	resolveModel: vi.fn(),
}));

vi.mock("@vegardx/pi-extensions-shared/parallel-subagent.js", () => ({
	runSubagent: vi.fn(),
}));

import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { runSubagent } from "@vegardx/pi-extensions-shared/parallel-subagent.js";
import { SubagentPool } from "@vegardx/pi-extensions-shared/subagent-pool.js";
import { DelegateAgents } from "../plan/delegate-tools.js";

// ---- Helpers -------------------------------------------------------------

function makeMockAgent(lastText: string | null = "mock answer") {
	return {
		prompt: vi.fn().mockResolvedValue(undefined),
		waitForIdle: vi.fn().mockResolvedValue(undefined),
		getLastText: vi.fn().mockResolvedValue(lastText),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

type MockAgent = ReturnType<typeof makeMockAgent>;

type MockPool = {
	has: ReturnType<typeof vi.fn>;
	spawn: ReturnType<typeof vi.fn>;
	get: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	_agents: Map<string, MockAgent>;
};

function makeMockPool(): MockPool {
	const agents = new Map<string, MockAgent>();
	return {
		_agents: agents,
		has: vi.fn((id: string) => agents.has(id)),
		spawn: vi.fn(async (id: string, _config: unknown) => {
			const agent = makeMockAgent();
			agents.set(id, agent);
			return agent;
		}),
		get: vi.fn((id: string) => agents.get(id)),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

const MOCK_CTX = {
	cwd: "/fake/repo",
	hasUI: false,
	model: { provider: "anthropic", id: "claude-haiku" },
} as never;

const RESOLVED_MODEL = {
	model: { provider: "anthropic", id: "claude-haiku" },
};

// ---- Tests ---------------------------------------------------------------

describe("DelegateAgents", () => {
	let pool1: MockPool;
	let pool2: MockPool;

	beforeEach(() => {
		vi.resetAllMocks();
		pool1 = makeMockPool();
		pool2 = makeMockPool();
		// First constructor call → pool1 (DelegateAgents constructor).
		// Subsequent calls → pool2 (crash recovery or dispose reset).
		vi.mocked(SubagentPool)
			.mockReturnValueOnce(pool1 as never)
			.mockReturnValue(pool2 as never);
		vi.mocked(resolveModel).mockResolvedValue(RESOLVED_MODEL as never);
		vi.mocked(runSubagent).mockResolvedValue({
			tag: 0,
			rawText: "mock answer",
		});
	});

	describe("explore()", () => {
		it("lazy spawn: first call triggers pool.spawn, returns answer", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			const result = await agents.explore("how does auth work?");

			expect(pool1.spawn).toHaveBeenCalledOnce();
			expect(pool1.spawn).toHaveBeenCalledWith(
				"explore",
				expect.objectContaining({
					provider: "anthropic",
					model: "claude-haiku",
					tools: ["read", "grep", "find", "ls"],
					cwd: "/fake/repo",
					systemPromptPath: expect.stringContaining("explore-agent.md"),
				}),
			);
			expect(result).toBe("mock answer");
		});

		it("second call reuses the same agent — no second spawn", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.explore("first question");
			await agents.explore("second question");

			expect(pool1.spawn).toHaveBeenCalledOnce();
			expect(pool1.get).toHaveBeenCalledTimes(2);
			const agent = pool1._agents.get("explore")!;
			expect(agent.prompt).toHaveBeenCalledTimes(2);
		});

		it("uses read/grep/find/ls — no bash", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.explore("where is the router?");

			expect(pool1.spawn).toHaveBeenCalledWith(
				"explore",
				expect.objectContaining({ tools: ["read", "grep", "find", "ls"] }),
			);
			const spawnCall = vi.mocked(pool1.spawn).mock.calls[0]?.[1] as {
				tools: string[];
			};
			expect(spawnCall.tools).not.toContain("bash");
		});
	});

	describe("research()", () => {
		it("spawns a one-shot subagent with websearch/webfetch tools", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			const result = await agents.research("how does zod v4 work?");

			expect(runSubagent).toHaveBeenCalledOnce();
			expect(runSubagent).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: "anthropic",
					model: "claude-haiku",
					tools: ["websearch", "webfetch"],
					cwd: "/fake/repo",
					systemPromptPath: expect.stringContaining("research-agent.md"),
					task: "how does zod v4 work?",
				}),
			);
			expect(result).toBe("mock answer");
			// research never touches the SubagentPool
			expect(pool1.spawn).not.toHaveBeenCalled();
		});

		it("each call spawns a fresh one-shot process — no reuse", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.research("q1");
			await agents.research("q2");

			expect(runSubagent).toHaveBeenCalledTimes(2);
			expect(pool1.spawn).not.toHaveBeenCalled();
		});

		it("concurrent calls run in parallel", async () => {
			// Stagger resolution to confirm both were in-flight simultaneously.
			let resolveFirst!: () => void;
			const firstStarted = new Promise<void>((r) => (resolveFirst = r));

			vi.mocked(runSubagent)
				.mockImplementationOnce(async (input) => {
					resolveFirst();
					await new Promise<void>((r) => setTimeout(r, 10));
					return { tag: input.tag, rawText: "first" };
				})
				.mockImplementationOnce(async (input) => {
					await firstStarted; // wait until first has started
					return { tag: input.tag, rawText: "second" };
				});

			const agents = new DelegateAgents(MOCK_CTX);
			const [r1, r2] = await Promise.all([
				agents.research("q1"),
				agents.research("q2"),
			]);

			expect(r1).toBe("first");
			expect(r2).toBe("second");
			expect(runSubagent).toHaveBeenCalledTimes(2);
		});

		it("returns error string when runSubagent reports an error", async () => {
			vi.mocked(runSubagent).mockResolvedValueOnce({
				tag: 0,
				rawText: "",
				error: "network timeout",
			});
			const agents = new DelegateAgents(MOCK_CTX);
			const result = await agents.research("q");
			expect(result).toBe("[research error: network timeout]");
		});
	});

	describe("independent agents", () => {
		it("explore uses pool; research uses runSubagent", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.explore("codebase q");
			await agents.research("web q");

			expect(pool1.spawn).toHaveBeenCalledOnce();
			expect(pool1.spawn).toHaveBeenCalledWith("explore", expect.anything());
			expect(runSubagent).toHaveBeenCalledOnce();
		});

		it("research-only path never touches the pool", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.research("web only");

			expect(pool1.spawn).not.toHaveBeenCalled();
			expect(pool1._agents.has("explore")).toBe(false);
		});
	});

	describe("model unavailable", () => {
		it("returns error string and skips spawn when no model configured", async () => {
			vi.mocked(resolveModel).mockResolvedValue(null);
			const agents = new DelegateAgents(MOCK_CTX);
			const result = await agents.explore("q");

			expect(result).toMatch(/\[explore:.*no fast-tier model/);
			expect(pool1.spawn).not.toHaveBeenCalled();
		});

		it("research returns error string when no model configured", async () => {
			vi.mocked(resolveModel).mockResolvedValue(null);
			const agents = new DelegateAgents(MOCK_CTX);
			const result = await agents.research("q");

			expect(result).toMatch(/\[research:.*no fast-tier model/);
			expect(runSubagent).not.toHaveBeenCalled();
		});
	});

	describe("error recovery (explore)", () => {
		it("returns error string when waitForIdle throws", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.explore("first");

			const agent = pool1._agents.get("explore")!;
			agent.waitForIdle.mockRejectedValueOnce(new Error("agent crashed"));

			const result = await agents.explore("crash turn");
			expect(result).toBe("[explore error: agent crashed]");
		});

		it("pool is reset after crash — next call spawns fresh on new pool", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.explore("first");

			const agent = pool1._agents.get("explore")!;
			agent.waitForIdle.mockRejectedValueOnce(new Error("crash"));
			await agents.explore("crash turn"); // pool is reset to pool2 internally

			// Next explore uses pool2
			const result = await agents.explore("after crash");
			expect(pool2.spawn).toHaveBeenCalledWith("explore", expect.anything());
			expect(result).toBe("mock answer");
		});
	});

	describe("dispose()", () => {
		it("disposes the old pool", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.explore("q");
			await agents.dispose();

			expect(pool1.dispose).toHaveBeenCalledOnce();
		});

		it("research still works after dispose — each call is already fresh", async () => {
			const agents = new DelegateAgents(MOCK_CTX);
			await agents.research("first");
			await agents.dispose();

			const result = await agents.research("after dispose");
			expect(result).toBe("mock answer");
			expect(runSubagent).toHaveBeenCalledTimes(2);
		});
	});
});
