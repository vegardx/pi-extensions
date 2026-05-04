import { spawnSync } from "node:child_process";

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Run a command without a shell, never throws. Callers inspect `ok` /
 * `exitCode` and handle non-zero paths themselves. Used for every git
 * and gh invocation in this package.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: { cwd?: string; stdin?: string } = {},
): ShellResult {
	const result = spawnSync(command, args, {
		cwd: opts.cwd,
		input: opts.stdin,
		encoding: "utf8",
		shell: false,
		env: process.env,
	});
	const exitCode = typeof result.status === "number" ? result.status : -1;
	return {
		ok: exitCode === 0,
		stdout: (result.stdout ?? "").toString(),
		stderr: (result.stderr ?? "").toString(),
		exitCode,
	};
}

// ---- Repo + branch introspection -----------------------------------

export function isGitRepo(cwd: string): boolean {
	return runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

export function currentBranch(cwd: string): string | null {
	const r = runCommand("git", ["branch", "--show-current"], { cwd });
	if (!r.ok) return null;
	const b = r.stdout.trim();
	return b.length > 0 ? b : null;
}

export function detectDefaultBranch(cwd: string): string | null {
	const head = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
	});
	if (head.ok) {
		const m = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (m?.[1]) return m[1];
	}
	for (const candidate of ["main", "master"]) {
		if (
			runCommand(
				"git",
				["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
				{ cwd },
			).ok
		) {
			return candidate;
		}
	}
	return null;
}

export function headSha(cwd: string): string | null {
	const r = runCommand("git", ["rev-parse", "HEAD"], { cwd });
	return r.ok ? r.stdout.trim() : null;
}

/** Working tree + index status via `--porcelain`. Empty string = clean. */
export function gitStatusPorcelain(cwd: string): string {
	const r = runCommand("git", ["status", "--porcelain"], { cwd });
	return r.ok ? r.stdout : "";
}

export function hasAnyChanges(cwd: string): boolean {
	return gitStatusPorcelain(cwd).trim().length > 0;
}

// ---- Remote URL / origin ----------------------------------------------

export function originUrl(cwd: string): string | null {
	const r = runCommand("git", ["remote", "get-url", "origin"], { cwd });
	if (!r.ok) return null;
	const url = r.stdout.trim();
	return url.length > 0 ? url : null;
}

// ---- Tracking issue -------------------------------------------------

/**
 * Read `branch.<name>.tracking-issue` — typically set by `/develop`'s
 * park path. Returns null when the config key is unset.
 */
export function readTrackingIssue(cwd: string, branch: string): string | null {
	const r = runCommand(
		"git",
		["config", "--get", `branch.${branch}.tracking-issue`],
		{ cwd },
	);
	if (!r.ok) return null;
	const v = r.stdout.trim();
	return v.length > 0 ? v : null;
}

export function writeTrackingIssue(
	cwd: string,
	branch: string,
	issue: string,
): ShellResult {
	return runCommand(
		"git",
		["config", `branch.${branch}.tracking-issue`, issue],
		{ cwd },
	);
}

// ---- Push helpers ---------------------------------------------------

/**
 * `git merge-base --is-ancestor <ref> HEAD` — exit 0 when HEAD is a
 * descendant of ref (fast-forward push is safe).
 */
export function isAncestor(cwd: string, ref: string): boolean {
	return runCommand("git", ["merge-base", "--is-ancestor", ref, "HEAD"], {
		cwd,
	}).ok;
}

/**
 * `git rev-parse --verify --quiet <ref>` — exit 0 when ref resolves.
 * Use this before drift detection to tell "first push" (no
 * remote-tracking ref yet) apart from "remote moved"; the latter's
 * merge-base / ancestor checks silently fail on a missing ref and we'd
 * otherwise fall through to a scary-but-wrong "remote has commits we
 * don't have" prompt.
 */
export function refExists(cwd: string, ref: string): boolean {
	return runCommand("git", ["rev-parse", "--verify", "--quiet", ref], {
		cwd,
	}).ok;
}

/** `git merge-base <ref1> <ref2>` — shared ancestor SHA, or null. */
export function mergeBase(
	cwd: string,
	ref1: string,
	ref2: string,
): string | null {
	const r = runCommand("git", ["merge-base", ref1, ref2], { cwd });
	return r.ok ? r.stdout.trim() || null : null;
}

/**
 * `git diff --quiet <a> <b>` — exit 0 when trees are identical. Used for
 * "author amended/rebased but content is the same" detection.
 */
export function treesIdentical(cwd: string, a: string, b: string): boolean {
	return runCommand("git", ["diff", "--quiet", a, b], { cwd }).ok;
}

export function rebaseOnto(
	cwd: string,
	newbase: string,
	oldbase: string,
): ShellResult {
	return runCommand("git", ["rebase", "--onto", newbase, oldbase, "HEAD"], {
		cwd,
	});
}

export function addRemoteIdempotent(
	cwd: string,
	name: string,
	url: string,
): void {
	runCommand("git", ["remote", "add", name, url], { cwd });
	// `git remote add` errors with exit 128 when the remote already exists;
	// the caller doesn't care. Ignore.
}

export function fetchRef(
	cwd: string,
	remote: string,
	ref: string,
): ShellResult {
	return runCommand("git", ["fetch", remote, ref], { cwd });
}

export function pushRefspec(
	cwd: string,
	target: string,
	refspec: string,
	force: boolean,
): ShellResult {
	const args = ["push"];
	if (force) args.push("--force-with-lease");
	args.push(target, refspec);
	return runCommand("git", args, { cwd });
}

export function checkoutAndPull(
	cwd: string,
	branch: string,
): { ok: boolean; message: string } {
	const co = runCommand("git", ["checkout", branch], { cwd });
	if (!co.ok)
		return { ok: false, message: `checkout ${branch}: ${co.stderr.trim()}` };
	const pull = runCommand("git", ["pull", "--ff-only", "origin", branch], {
		cwd,
	});
	if (!pull.ok) return { ok: false, message: `pull: ${pull.stderr.trim()}` };
	return { ok: true, message: "" };
}
