/**
 * Smoke test for the `nonInteractive` flag on `runCommit`. Verifies
 * that the early-abort gates never invoke `ctx.ui.*` — the test
 * `ctx.ui.select` / `ui.confirm` / `ui.input` / `ui.editor` throw if
 * called, so a regression that adds an interactive prompt to the
 * non-interactive path will fail loudly.
 *
 * The full pipeline (plan generation, agent execute, push, PR) is
 * not exercised — those depend on an LLM round-trip and a real
 * remote. We test the policy boundaries that don't.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommit } from "../core.js";

interface UiCallLog {
	calls: Array<{ method: string; args: unknown[] }>;
}

function makeThrowingUi(log: UiCallLog) {
	const trap = (method: string) =>
		((...args: unknown[]) => {
			log.calls.push({ method, args });
			throw new Error(
				`nonInteractive runCommit invoked ctx.ui.${method} — should never happen`,
			);
		}) as never;
	return {
		select: trap("select"),
		confirm: trap("confirm"),
		input: trap("input"),
		editor: trap("editor"),
		notify: () => {},
	};
}

function makeFakePi() {
	return {
		on: () => () => {},
		off: () => {},
		sendMessage: () => {},
		getCommands: () => [],
	} as unknown as Parameters<typeof runCommit>[0]["pi"];
}

function makeCtx(cwd: string, ui: ReturnType<typeof makeThrowingUi>) {
	return {
		cwd,
		hasUI: true,
		ui,
		notify: () => {},
		isIdle: () => true,
		sessionManager: { getMessages: () => [] },
	} as unknown as Parameters<typeof runCommit>[0]["ctx"];
}

/**
 * Build a minimal repo whose `.git` is initialised and whose working
 * tree may be either clean or dirty. The `GIT_CONFIG_GLOBAL` file is
 * placed outside the repo so it doesn't surface as an untracked file.
 */
function mkRepo(opts: {
	branch: string;
	withOrigin: boolean;
	dirty: boolean;
}): { dir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "pi-ext-commit-noninteractive-"));
	const configGlobal = join(root, "empty-gitconfig");
	writeFileSync(configGlobal, "");
	const dir = join(root, "repo");
	const env = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: configGlobal,
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	const git = (cwd: string, ...args: string[]): void => {
		const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
		if (r.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr || "unknown"}`);
		}
	};

	if (opts.withOrigin) {
		const bare = join(root, "origin.git");
		git(root, "init", "-q", "--bare", bare);
		git(root, "init", "-q", "-b", opts.branch, dir);
		git(dir, "remote", "add", "origin", bare);
	} else {
		git(root, "init", "-q", "-b", opts.branch, dir);
	}

	writeFileSync(join(dir, "README.md"), "seed\n");
	git(dir, "add", "README.md");
	git(dir, "commit", "-q", "-m", "seed");
	if (opts.withOrigin) {
		git(dir, "push", "-q", "-u", "origin", opts.branch);
		git(dir, "remote", "set-head", "origin", opts.branch);
	}
	if (opts.dirty) {
		writeFileSync(join(dir, "README.md"), "seed\nchanged\n");
	}
	return {
		dir,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("runCommit({ nonInteractive: true })", () => {
	it("refuses to commit on the default branch without prompting", async () => {
		// Repo with `origin/main` so detectDefaultBranch resolves to `main`,
		// HEAD on `main`, dirty tree → hits the default-branch policy gate.
		const repo = mkRepo({ branch: "main", withOrigin: true, dirty: true });
		try {
			const log: UiCallLog = { calls: [] };
			const ui = makeThrowingUi(log);
			const result = await runCommit({
				ctx: makeCtx(repo.dir, ui),
				pi: makeFakePi(),
				nonInteractive: true,
			});
			expect(result.ran).toBe(false);
			expect(result.abortReason).toBe("unsafe-branch");
			expect(log.calls).toEqual([]);
		} finally {
			repo.cleanup();
		}
	});

	it("returns clean-tree without prompting when nothing has changed", async () => {
		const repo = mkRepo({ branch: "feat/x", withOrigin: false, dirty: false });
		try {
			const log: UiCallLog = { calls: [] };
			const ui = makeThrowingUi(log);
			const result = await runCommit({
				ctx: makeCtx(repo.dir, ui),
				pi: makeFakePi(),
				nonInteractive: true,
			});
			expect(result.ran).toBe(false);
			expect(result.abortReason).toBe("clean-tree");
			expect(log.calls).toEqual([]);
		} finally {
			repo.cleanup();
		}
	});

	it("returns not-git without prompting when cwd isn't a git repo", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-ext-commit-notgit-"));
		try {
			const log: UiCallLog = { calls: [] };
			const ui = makeThrowingUi(log);
			const result = await runCommit({
				ctx: makeCtx(dir, ui),
				pi: makeFakePi(),
				nonInteractive: true,
			});
			expect(result.ran).toBe(false);
			expect(result.abortReason).toBe("not-git");
			expect(log.calls).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
