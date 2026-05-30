import { spawnSync } from "node:child_process";

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	/** True when the command was killed for exceeding its timeout. */
	timedOut?: boolean;
}

/**
 * Default ceiling for any git/gh subprocess. `spawnSync` blocks the single
 * Node event loop for the child's entire lifetime, so an unbounded command
 * (network stall, held `index.lock`) would freeze the TUI — including Esc.
 * 60s is generous for network ops while still guaranteeing the loop frees.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Build a non-interactive environment for git/gh. A credential helper or
 * SSH passphrase prompt opens `/dev/tty` and blocks forever waiting on
 * input that never comes — turning a transient auth hiccup into a
 * permanently frozen event loop. These vars make git/gh fail fast instead
 * of prompting. User-provided values win where it's safe (SSH command).
 */
function nonInteractiveEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// git: never prompt for HTTP(S) credentials on the terminal.
	env.GIT_TERMINAL_PROMPT = "0";
	// git credential manager: never pop an interactive prompt.
	env.GCM_INTERACTIVE = "never";
	// SSH: fail instead of asking for a passphrase. Respect an existing
	// GIT_SSH_COMMAND so a user's custom ssh wrapper still applies.
	if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
	// Stop GUI askpass helpers: clear the askpass hooks and drop DISPLAY so
	// ssh can't spawn an X11 passphrase dialog.
	env.GIT_ASKPASS = "";
	env.SSH_ASKPASS = "";
	env.SSH_ASKPASS_REQUIRE = "never";
	delete env.DISPLAY;
	// gh: disable interactive prompts + the update-check network call.
	env.GH_PROMPT_DISABLED = "1";
	env.GH_NO_UPDATE_NOTIFIER = "1";
	return env;
}

/**
 * Thin wrapper around `spawnSync` tuned for git/gh commands: captures stdout
 * and stderr, never throws. Callers branch on `ok` / `exitCode` / `timedOut`.
 *
 * Always runs non-interactively (no credential/passphrase prompts) with a
 * closed stdin and a hard timeout, so a hung subprocess can't brick the
 * event loop. For genuinely interruptible network ops prefer the async
 * runner — `spawnSync` still freezes the loop for up to `timeoutMs`.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {},
): ShellResult {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const result = spawnSync(command, args, {
		cwd: opts.cwd,
		// Closed stdin (empty input) → any reader gets EOF instead of blocking
		// on a pipe that never produces data.
		input: opts.stdin ?? "",
		encoding: "utf8",
		// Belt-and-braces: no shell interpolation, no env inheritance surprises.
		shell: false,
		env: nonInteractiveEnv(),
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: 32 * 1024 * 1024,
	});
	const timedOut =
		(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
		result.signal === "SIGKILL";
	const exitCode = typeof result.status === "number" ? result.status : -1;
	return {
		ok: exitCode === 0 && !timedOut,
		stdout: (result.stdout ?? "").toString(),
		stderr: timedOut
			? `timed out after ${timeoutMs}ms`
			: (result.stderr ?? "").toString(),
		exitCode,
		timedOut,
	};
}

/** `true` if `cwd` is inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
	return runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd }).ok;
}

/** Current branch or `null` on detached HEAD / bare repo. */
export function currentBranch(cwd: string): string | null {
	const r = runCommand("git", ["branch", "--show-current"], { cwd });
	if (!r.ok) return null;
	const trimmed = r.stdout.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the default branch from the remote's HEAD symbolic-ref, falling
 * back to `main` → `master` existence checks. Returns `null` if neither
 * approach pins down a branch.
 */
export function detectDefaultBranch(cwd: string): string | null {
	const head = runCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
		cwd,
	});
	if (head.ok) {
		const match = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		const exists = runCommand(
			"git",
			["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
			{ cwd },
		);
		if (exists.ok) return candidate;
	}
	return null;
}

/** `true` if the working tree is clean (no modified, staged, or untracked). */
export function workingTreeClean(cwd: string): boolean {
	const r = runCommand("git", ["status", "--porcelain"], { cwd });
	return r.ok && r.stdout.trim().length === 0;
}

/** Git-branch a name. No-throws — returns the raw shell result. */
export function checkoutBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", branch], { cwd });
}

export function pullFastForward(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["pull", "--ff-only", "origin", branch], { cwd });
}

export function createBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", "-b", branch], { cwd });
}

/** Wrapper around `git config` setting a branch-scoped key. */
export function setBranchConfig(
	cwd: string,
	branch: string,
	key: string,
	value: string,
): ShellResult {
	return runCommand("git", ["config", `branch.${branch}.${key}`, value], {
		cwd,
	});
}
