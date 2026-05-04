import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refExists } from "../git.js";

/**
 * Run `git` in `cwd` with a hermetic environment:
 * - `GIT_CONFIG_NOSYSTEM=1` suppresses the system config (portable).
 * - `GIT_CONFIG_GLOBAL` points at the caller-supplied empty file so we
 *   don't inherit the developer's `~/.gitconfig`. We pass it through
 *   `env` on the child process only — never touch `process.env` — so
 *   later tests in the same vitest worker can't pick up a dangling
 *   path after our `finally` deletes the temp dir.
 */
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
		// spawnSync sets status=null when the binary itself failed to run;
		// r.error carries the real reason in that case. Surface both so a
		// missing `git` on PATH is diagnosable.
		const reason = r.error ? r.error.message : r.stderr || "unknown";
		throw new Error(`git ${args.join(" ")} failed: ${reason}`);
	}
}

interface Repo {
	dir: string;
	/** git invoked inside this repo with its own scoped global-config. */
	git: (...args: string[]) => void;
}

function mkRepo(init: { bare?: boolean; seed?: boolean } = {}): Repo {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-commit-gittest-"));
	// Per-repo empty global-config file. Kept inside `dir` so the `rmSync`
	// cleanup removes it and nothing leaks between tests.
	const configGlobal = join(dir, ".empty-gitconfig");
	writeFileSync(configGlobal, "");
	const gitInRepo = (...args: string[]) => runGit(dir, configGlobal, ...args);
	if (init.bare) {
		gitInRepo("init", "--quiet", "--bare");
	} else {
		gitInRepo("init", "--quiet", "--initial-branch=main");
	}
	if (init.seed) {
		writeFileSync(join(dir, "seed"), "");
		gitInRepo("add", "seed");
		gitInRepo("commit", "--quiet", "-m", "seed");
	}
	return { dir, git: gitInRepo };
}

describe("refExists", () => {
	it("returns false for an unknown ref", () => {
		const repo = mkRepo({ seed: true });
		try {
			expect(refExists(repo.dir, "origin/does-not-exist")).toBe(false);
			expect(refExists(repo.dir, "refs/remotes/origin/does-not-exist")).toBe(
				false,
			);
		} finally {
			rmSync(repo.dir, { recursive: true, force: true });
		}
	});

	it("returns true for HEAD in an initialised repo", () => {
		const repo = mkRepo({ seed: true });
		try {
			expect(refExists(repo.dir, "HEAD")).toBe(true);
		} finally {
			rmSync(repo.dir, { recursive: true, force: true });
		}
	});

	it("returns true for a remote-tracking ref after a push", () => {
		const bare = mkRepo({ bare: true });
		const repo = mkRepo({ seed: true });
		try {
			repo.git("remote", "add", "origin", bare.dir);
			repo.git("push", "--quiet", "-u", "origin", "main");
			expect(refExists(repo.dir, "origin/main")).toBe(true);
			// Still false for branches that only exist locally or not at all.
			expect(refExists(repo.dir, "origin/other")).toBe(false);
		} finally {
			rmSync(repo.dir, { recursive: true, force: true });
			rmSync(bare.dir, { recursive: true, force: true });
		}
	});
});
