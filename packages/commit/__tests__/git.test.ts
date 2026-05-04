import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refExists } from "../git.js";

function git(cwd: string, ...args: string[]): void {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			// Keep the test hermetic: don't honor the user's git config /
			// hooks / templates / signing keys when seeding the repo.
			// GIT_CONFIG_NOSYSTEM suppresses system config portably (POSIX +
			// Windows). For GIT_CONFIG_GLOBAL we can't use /dev/null (not
			// portable) so the caller passes in a path to an empty temp file.
			GIT_CONFIG_NOSYSTEM: "1",
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

function mkRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-commit-gittest-"));
	// Empty global-config file so `git` doesn't read the user's ~/.gitconfig
	// (portable alternative to GIT_CONFIG_GLOBAL=/dev/null).
	const emptyConfig = join(dir, ".empty-gitconfig");
	writeFileSync(emptyConfig, "");
	process.env.GIT_CONFIG_GLOBAL = emptyConfig;
	git(dir, "init", "--quiet", "--initial-branch=main");
	writeFileSync(join(dir, "seed"), "");
	git(dir, "add", "seed");
	git(dir, "commit", "--quiet", "-m", "seed");
	return dir;
}

describe("refExists", () => {
	it("returns false for an unknown ref", () => {
		const repo = mkRepo();
		try {
			expect(refExists(repo, "origin/does-not-exist")).toBe(false);
			expect(refExists(repo, "refs/remotes/origin/does-not-exist")).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("returns true for HEAD in an initialised repo", () => {
		const repo = mkRepo();
		try {
			expect(refExists(repo, "HEAD")).toBe(true);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("returns true for a remote-tracking ref after a push", () => {
		const bare = mkdtempSync(join(tmpdir(), "pi-ext-commit-gittest-bare-"));
		const repo = mkRepo();
		try {
			git(bare, "init", "--quiet", "--bare");
			git(repo, "remote", "add", "origin", bare);
			git(repo, "push", "--quiet", "-u", "origin", "main");
			expect(refExists(repo, "origin/main")).toBe(true);
			// Still false for branches that only exist locally or not at all.
			expect(refExists(repo, "origin/other")).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(bare, { recursive: true, force: true });
		}
	});
});
