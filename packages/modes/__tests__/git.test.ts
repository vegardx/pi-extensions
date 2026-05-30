import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	currentBranch,
	detectDefaultBranch,
	isGitRepo,
	runCommand,
	runCommandAsync,
	workingTreeClean,
} from "../git.js";

function runGit(cwd: string, configGlobal: string, ...args: string[]): void {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: configGlobal,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (r.status !== 0) {
		const reason = r.error ? r.error.message : r.stderr || "unknown";
		throw new Error(`git ${args.join(" ")} failed: ${reason}`);
	}
}

interface Repo {
	dir: string;
	git: (...args: string[]) => void;
	cfgDir: string;
}

/**
 * Create a temp git repo. The global gitconfig file is stored outside the
 * repo dir so it never appears as an untracked file in workingTreeClean tests.
 */
function mkRepo(init: { bare?: boolean; branch?: string } = {}): Repo {
	const cfgDir = mkdtempSync(join(tmpdir(), "pi-ext-modes-gitcfg-"));
	const configGlobal = join(cfgDir, "config");
	writeFileSync(configGlobal, "");
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-modes-gittest-"));
	const git = (...args: string[]) => runGit(dir, configGlobal, ...args);
	if (init.bare) {
		git("init", "--quiet", "--bare");
	} else {
		git("init", "--quiet", `--initial-branch=${init.branch ?? "main"}`);
		writeFileSync(join(dir, "seed"), "");
		git("add", "seed");
		git("commit", "--quiet", "-m", "seed");
	}
	return { dir, git, cfgDir };
}

function cleanup(repo: Repo): void {
	rmSync(repo.dir, { recursive: true, force: true });
	rmSync(repo.cfgDir, { recursive: true, force: true });
}

describe("isGitRepo", () => {
	it("returns true inside a git repo", () => {
		const repo = mkRepo();
		try {
			expect(isGitRepo(repo.dir)).toBe(true);
		} finally {
			cleanup(repo);
		}
	});

	it("returns false outside a git repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-modes-nogit-"));
		try {
			expect(isGitRepo(dir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("currentBranch", () => {
	it("returns the current branch name", () => {
		const repo = mkRepo({ branch: "main" });
		try {
			expect(currentBranch(repo.dir)).toBe("main");
		} finally {
			cleanup(repo);
		}
	});

	it("returns null on detached HEAD", () => {
		const repo = mkRepo({ branch: "main" });
		try {
			const r = spawnSync("git", ["rev-parse", "HEAD"], {
				cwd: repo.dir,
				encoding: "utf8",
			});
			const sha = r.stdout.trim();
			repo.git("checkout", "--quiet", "--detach", sha);
			expect(currentBranch(repo.dir)).toBeNull();
		} finally {
			cleanup(repo);
		}
	});
});

describe("detectDefaultBranch", () => {
	it("returns the default branch via origin/HEAD", () => {
		const bare = mkRepo({ bare: true });
		const repo = mkRepo({ branch: "main" });
		try {
			repo.git("remote", "add", "origin", bare.dir);
			repo.git("push", "--quiet", "-u", "origin", "main");
			// Use explicit form — --auto requires transport to the remote.
			repo.git("remote", "set-head", "origin", "main");
			expect(detectDefaultBranch(repo.dir)).toBe("main");
		} finally {
			cleanup(repo);
			cleanup(bare);
		}
	});

	it("falls back to 'main' when origin/HEAD is absent but main exists", () => {
		const bare = mkRepo({ bare: true });
		const repo = mkRepo({ branch: "main" });
		try {
			repo.git("remote", "add", "origin", bare.dir);
			repo.git("push", "--quiet", "-u", "origin", "main");
			// Deliberately do NOT set origin/HEAD — exercises the fallback path.
			expect(detectDefaultBranch(repo.dir)).toBe("main");
		} finally {
			cleanup(repo);
			cleanup(bare);
		}
	});

	it("returns null when no remote is configured", () => {
		const repo = mkRepo({ branch: "main" });
		try {
			expect(detectDefaultBranch(repo.dir)).toBeNull();
		} finally {
			cleanup(repo);
		}
	});
});

describe("runCommand hang-prevention", () => {
	it("kills a command that exceeds its timeout and reports timedOut", () => {
		const start = Date.now();
		const r = runCommand("sleep", ["30"], { timeoutMs: 200 });
		const elapsed = Date.now() - start;
		expect(r.timedOut).toBe(true);
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain("timed out");
		// The whole point: the call returns promptly instead of hanging.
		expect(elapsed).toBeLessThan(5_000);
	});

	it("sets non-interactive prompt vars in the child env", () => {
		// shell:false, so invoke printenv directly (no shell expansion).
		const r = runCommand("printenv", ["GIT_TERMINAL_PROMPT"]);
		expect(r.ok).toBe(true);
		expect(r.stdout.trim()).toBe("0");
	});

	it("disables gh interactive prompts in the child env", () => {
		const r = runCommand("printenv", ["GH_PROMPT_DISABLED"]);
		expect(r.ok).toBe(true);
		expect(r.stdout.trim()).toBe("1");
	});

	it("runs fast commands normally with timedOut false", () => {
		const r = runCommand("git", ["--version"]);
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.stdout).toContain("git version");
	});
});

describe("runCommandAsync (abortable network runner)", () => {
	it("runs a fast command and captures stdout", async () => {
		const r = await runCommandAsync("git", ["--version"]);
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("git version");
		expect(r.timedOut).toBeUndefined();
		expect(r.aborted).toBeUndefined();
	});

	it("kills a command that exceeds its timeout and reports timedOut", async () => {
		const start = Date.now();
		const r = await runCommandAsync("sleep", ["30"], { timeoutMs: 200 });
		const elapsed = Date.now() - start;
		expect(r.timedOut).toBe(true);
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain("timed out");
		expect(elapsed).toBeLessThan(5_000);
	});

	it("kills a running command when the signal aborts (Esc)", async () => {
		const controller = new AbortController();
		const start = Date.now();
		const promise = runCommandAsync("sleep", ["30"], {
			signal: controller.signal,
			timeoutMs: 30_000,
		});
		setTimeout(() => controller.abort(), 100);
		const r = await promise;
		const elapsed = Date.now() - start;
		expect(r.aborted).toBe(true);
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain("aborted");
		expect(elapsed).toBeLessThan(5_000);
	});

	it("resolves immediately when the signal is already aborted", async () => {
		const r = await runCommandAsync("sleep", ["30"], {
			signal: AbortSignal.abort(),
		});
		expect(r.aborted).toBe(true);
		expect(r.ok).toBe(false);
	});

	it("applies the non-interactive env on the async path", async () => {
		const prompt = await runCommandAsync("printenv", ["GIT_TERMINAL_PROMPT"]);
		expect(prompt.ok).toBe(true);
		expect(prompt.stdout.trim()).toBe("0");
		const gh = await runCommandAsync("printenv", ["GH_PROMPT_DISABLED"]);
		expect(gh.ok).toBe(true);
		expect(gh.stdout.trim()).toBe("1");
	});

	it("reports a non-ok result when the binary is missing", async () => {
		const r = await runCommandAsync("definitely-not-a-real-binary-xyz", []);
		expect(r.ok).toBe(false);
		expect(r.exitCode).toBe(-1);
	});
});

describe("workingTreeClean", () => {
	it("returns true on a clean tree", () => {
		const repo = mkRepo();
		try {
			expect(workingTreeClean(repo.dir)).toBe(true);
		} finally {
			cleanup(repo);
		}
	});

	it("returns false when there are untracked files", () => {
		const repo = mkRepo();
		try {
			writeFileSync(join(repo.dir, "untracked.ts"), "");
			expect(workingTreeClean(repo.dir)).toBe(false);
		} finally {
			cleanup(repo);
		}
	});

	it("returns false when there are staged changes", () => {
		const repo = mkRepo();
		try {
			writeFileSync(join(repo.dir, "new.ts"), "");
			repo.git("add", "new.ts");
			expect(workingTreeClean(repo.dir)).toBe(false);
		} finally {
			cleanup(repo);
		}
	});
});
