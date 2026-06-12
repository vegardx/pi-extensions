/**
 * Canonical shell runner for the pi-extensions monorepo.
 *
 * Provides sync + async command execution with:
 * - Non-interactive environment (git/gh/ssh never prompt)
 * - Hard timeout (default 60s) to prevent frozen event loops
 * - Abort signal support (async only)
 * - Output capping (32 MiB)
 *
 * All extensions should use this instead of rolling their own spawnSync
 * wrapper. Domain-specific git helpers live in each package's git.ts
 * and call through here.
 */

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

/** Largest stdout/stderr we'll buffer from a child. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Default ceiling for any subprocess. `spawnSync` blocks the Node event
 * loop for the child's entire lifetime, so an unbounded command (network
 * stall, held `index.lock`) would freeze the TUI — including Esc.
 * 60s is generous for network ops while still guaranteeing the loop frees.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export interface RunCommandOpts {
	cwd?: string;
	stdin?: string;
	timeoutMs?: number;
	/**
	 * When true, inherits `process.env` directly instead of applying the
	 * non-interactive overlay. Use for commands where prompts are desired
	 * or where the non-interactive env causes issues.
	 */
	inheritEnv?: boolean;
}

export interface RunCommandAsyncOpts extends RunCommandOpts {
	signal?: AbortSignal;
}

/**
 * Build a non-interactive environment for git/gh. A credential helper or
 * SSH passphrase prompt opens `/dev/tty` and blocks forever waiting on
 * input that never comes — turning a transient auth hiccup into a
 * permanently frozen event loop. These vars make git/gh fail fast instead
 * of prompting. User-provided values win where it's safe (SSH command).
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
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
 * Thin wrapper around `spawnSync` that captures stdout/stderr, never
 * throws. Callers branch on `ok` / `exitCode` / `timedOut`.
 *
 * By default runs non-interactively (no credential/passphrase prompts)
 * with a closed stdin and a hard timeout, so a hung subprocess can't
 * brick the event loop. For genuinely interruptible network ops prefer
 * {@link runCommandAsync}.
 */
export function runCommand(
	command: string,
	args: readonly string[],
	opts: RunCommandOpts = {},
): ShellResult {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const env = opts.inheritEnv ? process.env : nonInteractiveEnv();
	const result = spawnSync(command, args, {
		cwd: opts.cwd,
		input: opts.stdin ?? "",
		encoding: "utf8",
		shell: false,
		env,
		timeout: timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: MAX_OUTPUT_BYTES,
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
	opts: RunCommandAsyncOpts = {},
): Promise<ShellResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

	if (opts.signal?.aborted) {
		return Promise.resolve({
			ok: false,
			stdout: "",
			stderr: "aborted",
			exitCode: -1,
			aborted: true,
		});
	}

	const env = opts.inheritEnv ? process.env : nonInteractiveEnv();

	return new Promise<ShellResult>((resolve) => {
		const child = spawn(command, [...args], {
			cwd: opts.cwd,
			shell: false,
			env,
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

		if (child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(opts.stdin ?? "");
		}
	});
}
