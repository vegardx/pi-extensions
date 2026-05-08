import type {
	AgentConfig,
	AgentProgress,
	OneshotResult,
	OneshotTask,
	PersistentAgent,
	UsageStats,
} from "../subagent-pool.js";

/**
 * Type-level tests for the SubagentPool public API surface.
 *
 * We can't unit-test the full lifecycle without spawning real pi
 * processes. These tests pin the interface contracts so drift is
 * caught at typecheck time and verify basic structural expectations.
 */

describe("UsageStats", () => {
	it("has the expected shape", () => {
		const usage: UsageStats = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			cost: 0.0042,
			turns: 3,
		};
		expect(usage.input).toBe(1000);
		expect(usage.cost).toBe(0.0042);
		expect(usage.turns).toBe(3);
	});
});

describe("AgentConfig", () => {
	it("requires provider, model, systemPromptPath, cwd", () => {
		const config: AgentConfig = {
			provider: "anthropic",
			model: "claude-opus-4-7",
			systemPromptPath: "/tmp/prompt.md",
			cwd: "/tmp",
		};
		expect(config.provider).toBe("anthropic");
		expect(config.tools).toBeUndefined();
		expect(config.followUpMode).toBeUndefined();
	});

	it("accepts optional tools, followUpMode, onProgress", () => {
		const calls: AgentProgress[] = [];
		const config: AgentConfig = {
			provider: "anthropic",
			model: "claude-opus-4-7",
			systemPromptPath: "/tmp/prompt.md",
			cwd: "/tmp",
			tools: ["read", "grep", "bash"],
			followUpMode: "one-at-a-time",
			onProgress: (p) => calls.push(p),
		};
		expect(config.tools).toEqual(["read", "grep", "bash"]);
		expect(config.followUpMode).toBe("one-at-a-time");
		expect(config.onProgress).toBeDefined();
	});
});

describe("OneshotTask", () => {
	it("requires task, systemPromptPath, provider, model, cwd", () => {
		const task: OneshotTask = {
			task: "Review this code",
			systemPromptPath: "/tmp/reviewer.md",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			cwd: "/tmp",
		};
		expect(task.task).toBe("Review this code");
		expect(task.timeoutMs).toBeUndefined();
	});

	it("accepts optional timeoutMs and onProgress", () => {
		const task: OneshotTask = {
			task: "check",
			systemPromptPath: "/dev/null",
			provider: "p",
			model: "m",
			cwd: "/tmp",
			timeoutMs: 300_000,
			onProgress: () => {},
		};
		expect(task.timeoutMs).toBe(300_000);
	});
});

describe("OneshotResult", () => {
	it("carries text and usage", () => {
		const result: OneshotResult = {
			text: "No issues found.",
			usage: {
				input: 5000,
				output: 200,
				cacheRead: 4000,
				cacheWrite: 500,
				cost: 0.012,
				turns: 1,
			},
		};
		expect(result.text).toBe("No issues found.");
		expect(result.error).toBeUndefined();
		expect(result.usage.cost).toBe(0.012);
	});

	it("carries error on failure", () => {
		const result: OneshotResult = {
			text: "",
			error: "timeout",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		};
		expect(result.error).toBe("timeout");
	});
});

describe("PersistentAgent interface", () => {
	it("exposes expected readonly properties", () => {
		// Type-only assertion — we verify the shape compiles.
		const agentShape: Pick<PersistentAgent, "id" | "usage" | "busy" | "disposed"> = {
			id: "reviewer-primary",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			busy: false,
			disposed: false,
		};
		expect(agentShape.id).toBe("reviewer-primary");
		expect(agentShape.busy).toBe(false);
	});
});
