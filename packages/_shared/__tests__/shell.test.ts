import { nonInteractiveEnv, runCommand, runCommandAsync } from "../shell.js";

describe("runCommand", () => {
	it("runs a simple command and captures stdout", () => {
		const result = runCommand("echo", ["hello"]);
		expect(result.ok).toBe(true);
		expect(result.stdout.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
	});

	it("captures stderr and non-zero exit code", () => {
		const result = runCommand("sh", ["-c", "echo err >&2; exit 1"]);
		expect(result.ok).toBe(false);
		expect(result.stderr.trim()).toBe("err");
		expect(result.exitCode).toBe(1);
	});

	it("reports timeout", () => {
		const result = runCommand("sleep", ["10"], { timeoutMs: 50 });
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(result.stderr).toContain("timed out");
	});

	it("handles non-existent command gracefully", () => {
		const result = runCommand("nonexistent-binary-xyz", []);
		expect(result.ok).toBe(false);
	});

	it("passes stdin to command", () => {
		const result = runCommand("cat", [], { stdin: "hello from stdin" });
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("hello from stdin");
	});
});

describe("runCommandAsync", () => {
	it("runs a simple command", async () => {
		const result = await runCommandAsync("echo", ["async hello"]);
		expect(result.ok).toBe(true);
		expect(result.stdout.trim()).toBe("async hello");
	});

	it("handles abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runCommandAsync("sleep", ["10"], {
			signal: controller.signal,
		});
		expect(result.ok).toBe(false);
		expect(result.aborted).toBe(true);
	});

	it("reports timeout", async () => {
		const result = await runCommandAsync("sleep", ["10"], { timeoutMs: 50 });
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
	});
});

describe("nonInteractiveEnv", () => {
	it("sets GIT_TERMINAL_PROMPT=0", () => {
		const env = nonInteractiveEnv();
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
	});

	it("sets GH_PROMPT_DISABLED=1", () => {
		const env = nonInteractiveEnv();
		expect(env.GH_PROMPT_DISABLED).toBe("1");
	});

	it("clears SSH_ASKPASS", () => {
		const env = nonInteractiveEnv();
		expect(env.SSH_ASKPASS).toBe("");
	});

	it("preserves existing GIT_SSH_COMMAND", () => {
		const original = process.env.GIT_SSH_COMMAND;
		process.env.GIT_SSH_COMMAND = "my-custom-ssh";
		try {
			const env = nonInteractiveEnv();
			expect(env.GIT_SSH_COMMAND).toBe("my-custom-ssh");
		} finally {
			if (original === undefined) delete process.env.GIT_SSH_COMMAND;
			else process.env.GIT_SSH_COMMAND = original;
		}
	});

	it("sets default SSH batch mode when GIT_SSH_COMMAND is unset", () => {
		const original = process.env.GIT_SSH_COMMAND;
		delete process.env.GIT_SSH_COMMAND;
		try {
			const env = nonInteractiveEnv();
			expect(env.GIT_SSH_COMMAND).toBe("ssh -oBatchMode=yes");
		} finally {
			if (original !== undefined) process.env.GIT_SSH_COMMAND = original;
		}
	});
});
