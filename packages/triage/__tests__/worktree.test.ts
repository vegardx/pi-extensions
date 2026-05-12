import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTriageWorktree,
	type PrInfo,
	parseWorktreeList,
	triageWorktreePath,
} from "../worktree.js";

// ---- parseWorktreeList -----------------------------------------------

describe("parseWorktreeList", () => {
	it("returns the path of a non-main worktree holding the branch", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/main",
			"",
			"worktree /repos/wt/feature",
			"HEAD 1111111111111111",
			"branch refs/heads/feature",
			"",
		].join("\n");
		expect(parseWorktreeList(out, "feature")).toBe("/repos/wt/feature");
	});

	it("returns the main worktree path when the branch lives there", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/feature",
			"",
		].join("\n");
		expect(parseWorktreeList(out, "feature")).toBe("/repos/main");
	});

	it("returns null when the branch is not checked out anywhere", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/main",
			"",
		].join("\n");
		expect(parseWorktreeList(out, "feature")).toBeNull();
	});

	it("ignores worktrees with a detached HEAD", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/main",
			"",
			"worktree /repos/wt/detached",
			"HEAD 2222222222222222",
			"detached",
			"",
		].join("\n");
		expect(parseWorktreeList(out, "main")).toBe("/repos/main");
		expect(parseWorktreeList(out, "anything")).toBeNull();
	});

	it("tolerates locked and prunable annotations", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/main",
			"",
			"worktree /repos/wt/feature",
			"HEAD 1111111111111111",
			"branch refs/heads/feature",
			"locked stale",
			"prunable gitdir file points to non-existent location",
			"",
		].join("\n");
		expect(parseWorktreeList(out, "feature")).toBe("/repos/wt/feature");
	});

	it("handles output without a trailing blank line", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/feature",
		].join("\n");
		expect(parseWorktreeList(out, "feature")).toBe("/repos/main");
	});

	it("matches the exact branch name (no prefix collisions)", () => {
		const out = [
			"worktree /repos/main",
			"HEAD abcdef0123456789",
			"branch refs/heads/feature-extended",
			"",
		].join("\n");
		expect(parseWorktreeList(out, "feature")).toBeNull();
	});
});

// ---- createTriageWorktree (integration) ------------------------------

const hasGit = (() => {
	const r = spawnSync("git", ["--version"], { encoding: "utf8" });
	return (r.status ?? -1) === 0;
})();

/**
 * Run `git` with a hermetic environment so tests don't pick up the
 * developer's `~/.gitconfig` or system defaults. The empty config file
 * lives inside the test repo so cleanup removes it.
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
		const reason = r.error ? r.error.message : r.stderr || "unknown";
		throw new Error(`git ${args.join(" ")} failed: ${reason}`);
	}
}

interface Repo {
	dir: string;
	git: (...args: string[]) => void;
}

function mkRepo(): Repo {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-triage-wt-"));
	const configGlobal = join(dir, ".empty-gitconfig");
	writeFileSync(configGlobal, "");
	const gitInRepo = (...args: string[]) => runGit(dir, configGlobal, ...args);
	gitInRepo("init", "--quiet", "--initial-branch=main");
	writeFileSync(join(dir, "seed"), "");
	gitInRepo("add", "seed");
	gitInRepo("commit", "--quiet", "-m", "seed");
	return { dir, git: gitInRepo };
}

const PR: PrInfo = {
	number: 42,
	title: "test pr",
	headRefName: "feature",
};

describe.skipIf(!hasGit)("createTriageWorktree (integration)", () => {
	it("adopts a pre-existing clean worktree as reused: true", () => {
		const repo = mkRepo();
		// Create a sibling worktree at a non-canonical path so we know
		// reuse isn't relying on the canonical-path early return.
		const adopted = join(repo.dir, "..", "adopted-wt");
		try {
			repo.git("branch", "feature");
			repo.git("worktree", "add", adopted, "feature");

			const result = createTriageWorktree(PR, repo.dir);

			expect(result.reused).toBe(true);
			// `git worktree add` may resolve symlinks on macOS (e.g. /tmp ->
			// /private/tmp); compare basename instead of absolute path.
			expect(result.path.endsWith("adopted-wt")).toBe(true);
		} finally {
			rmSync(repo.dir, { recursive: true, force: true });
			rmSync(adopted, { recursive: true, force: true });
		}
	});

	it("throws when the existing worktree is dirty", () => {
		const repo = mkRepo();
		const adopted = join(repo.dir, "..", "adopted-wt-dirty");
		try {
			repo.git("branch", "feature");
			repo.git("worktree", "add", adopted, "feature");
			writeFileSync(join(adopted, "wip.txt"), "uncommitted work\n");

			expect(() => createTriageWorktree(PR, repo.dir)).toThrow(
				/uncommitted changes/,
			);
		} finally {
			rmSync(repo.dir, { recursive: true, force: true });
			rmSync(adopted, { recursive: true, force: true });
		}
	});

	it("creates a fresh worktree at the canonical path when no existing one holds the branch", () => {
		const repo = mkRepo();
		const canonical = triageWorktreePath(repo.dir, "feature");
		try {
			repo.git("branch", "feature");

			const result = createTriageWorktree(PR, repo.dir);

			expect(result.reused).toBe(false);
			expect(result.path).toBe(canonical);
		} finally {
			rmSync(repo.dir, { recursive: true, force: true });
			rmSync(canonical, { recursive: true, force: true });
		}
	});
});
