import { spawn, spawnSync } from "node:child_process";

export interface ShellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	/** True when the command was killed for exceeding its timeout. */
	timedOut?: boolean;
	/** True when the command was killed by an external AbortSignal (e.g. Esc). */
	aborted?: boolean;
}

/** Largest stdout/stderr we'll buffer from a child — matches spawnSync's cap. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Default ceiling for any git/gh subprocess. `spawnSync` blocks the single
 * Node event loop for the child's entire lifetime, so an unbounded command
 * (network stall, held `index.lock`) would freeze the TUI — including Esc.
 * 60s is generous for network ops while still guaranteeing the loop frees.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

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

/**
 * Async, abortable sibling of {@link runCommand} for genuinely
 * interruptible network ops (push, pull, `gh pr create`). Unlike
 * `spawnSync`, this uses `spawn` so the Node event loop keeps turning
 * while the child runs — the TUI stays responsive and Esc actually
 * works. Cancellation comes from two sources, both ending in SIGKILL:
 *
 * - `opts.signal` (the TUI's Esc/interrupt) → resolves with `aborted`.
 * - `opts.timeoutMs` backstop (default 60s) → resolves with `timedOut`.
 *
 * Mirrors `runCommand`'s contract: never throws, captures stdout/stderr,
 * non-interactive env + closed stdin so auth prompts fail fast.
 */
export function runCommandAsync(
	command: string,
	args: readonly string[],
	opts: {
		cwd?: string;
		stdin?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<ShellResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

	// Already cancelled before we even spawn — don't start the child.
	if (opts.signal?.aborted) {
		return Promise.resolve({
			ok: false,
			stdout: "",
			stderr: "aborted",
			exitCode: -1,
			aborted: true,
		});
	}

	return new Promise<ShellResult>((resolve) => {
		const child = spawn(command, [...args], {
			cwd: opts.cwd,
			shell: false,
			env: nonInteractiveEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutLen = 0;
		let stderrLen = 0;
		let settled = false;
		let timedOut = false;
		let aborted = false;

		const onAbort = () => {
			aborted = true;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const settle = (result: ShellResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutLen >= MAX_OUTPUT_BYTES) return;
			stdoutChunks.push(chunk);
			stdoutLen += chunk.length;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrLen >= MAX_OUTPUT_BYTES) return;
			stderrChunks.push(chunk);
			stderrLen += chunk.length;
		});

		// `error` fires when the binary is missing or can't be spawned.
		child.on("error", (err: Error) => {
			settle({
				ok: false,
				stdout: "",
				stderr: err.message,
				exitCode: -1,
			});
		});

		child.on("close", (code) => {
			const exitCode = typeof code === "number" ? code : -1;
			settle({
				ok: exitCode === 0 && !timedOut && !aborted,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: aborted
					? "aborted"
					: timedOut
						? `timed out after ${timeoutMs}ms`
						: Buffer.concat(stderrChunks).toString("utf8"),
				exitCode,
				timedOut: timedOut || undefined,
				aborted: aborted || undefined,
			});
		});

		// Closed stdin (EOF) — a reader gets EOF instead of blocking on a
		// pipe that never produces data. Swallow EPIPE if the child exits
		// before we finish writing.
		if (child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(opts.stdin ?? "");
		}
	});
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

/**
 * Abortable `git pull --ff-only`. Network op — runs on the async runner
 * so a stalled fetch can't freeze the TUI and Esc can cancel it.
 */
export function pullFastForwardAsync(
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return runCommandAsync("git", ["pull", "--ff-only", "origin", branch], {
		cwd,
		signal,
	});
}

/**
 * Abortable `git push -u origin <branch>`. Network op — see
 * {@link pullFastForwardAsync}.
 */
export function pushBranchAsync(
	cwd: string,
	branch: string,
	signal?: AbortSignal,
): Promise<ShellResult> {
	return runCommandAsync("git", ["push", "-u", "origin", branch], {
		cwd,
		signal,
	});
}

export function createBranch(cwd: string, branch: string): ShellResult {
	return runCommand("git", ["checkout", "-b", branch], { cwd });
}
