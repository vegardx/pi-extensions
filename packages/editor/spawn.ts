/**
 * Spawn helper for /editor.
 *
 * Fires `command argv` detached and unref'd so closing pi doesn't kill
 * the editor. PATH-miss is detected via the spawned child's `error`
 * event (ENOENT) — no extra `which` round-trip; race-free.
 */

import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnDeps {
	/**
	 * `child_process.spawn`-shaped factory. Injectable so tests can
	 * verify argv / detach without running real binaries.
	 */
	spawn: typeof nodeSpawn;
}

export interface LaunchEditorInput {
	command: string;
	args: readonly string[];
	cwd: string;
	detach: boolean;
	/**
	 * Optional sink for `error` events that fire AFTER the launch has
	 * already settled (e.g. an EACCES that arrives post-spawn). Without
	 * this hook late failures are silently swallowed; with it the
	 * caller can surface them via `ctx.ui.notify`.
	 */
	onLateError?: (err: NodeJS.ErrnoException) => void;
}

export type LaunchOutcome =
	| { ok: true }
	| {
			ok: false;
			reason: "not-found" | "spawn-failed";
			detail: string;
	  };

const DEFAULT_DEPS: SpawnDeps = { spawn: nodeSpawn };

/**
 * Launch the configured editor. Returns once we know whether the
 * spawn succeeded — but does NOT wait for the editor to exit. When
 * `detach: true` (the default), the child is detached and unref'd so
 * pi can exit independently.
 *
 * The success path resolves on `spawn` (child PID assigned). The
 * failure path resolves on the first `error` event (the only way to
 * detect ENOENT in detached mode with `stdio: "ignore"`). We race
 * the two with a 100ms grace window — if neither has fired by then,
 * the spawn is "in flight" and we treat it as success since the
 * child has accepted the fork.
 */
export async function launchEditor(
	input: LaunchEditorInput,
	deps: SpawnDeps = DEFAULT_DEPS,
): Promise<LaunchOutcome> {
	return new Promise<LaunchOutcome>((resolve) => {
		let settled = false;
		const settle = (outcome: LaunchOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		try {
			const child = deps.spawn(input.command, [...input.args], {
				cwd: input.cwd,
				detached: input.detach,
				stdio: "ignore",
			});

			child.on("error", (err: NodeJS.ErrnoException) => {
				if (settled) {
					// Late `error` after we've already settled (e.g. EACCES that
					// arrives post-spawn). Surface to the optional callback so
					// callers can notify the user; otherwise silently swallow.
					input.onLateError?.(err);
					return;
				}
				if (err.code === "ENOENT") {
					settle({
						ok: false,
						reason: "not-found",
						detail: `command not found on PATH: ${input.command}`,
					});
				} else {
					settle({
						ok: false,
						reason: "spawn-failed",
						detail: err.message ?? String(err),
					});
				}
			});

			child.on("spawn", () => {
				if (input.detach) child.unref();
				settle({ ok: true });
			});

			// Some platforms / mocks don't emit `spawn` synchronously even
			// when the child is up. Bail out positively after a short grace
			// — by then any ENOENT would already have surfaced via `error`.
			// When the grace path settles, we still need to `unref()` so the
			// detach guarantee holds even when `spawn` never fires.
			setTimeout(() => {
				if (input.detach) {
					try {
						child.unref();
					} catch {
						/* best-effort: the child may have died already */
					}
				}
				settle({ ok: true });
			}, 100).unref?.();
		} catch (err) {
			settle({
				ok: false,
				reason: "spawn-failed",
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	});
}
