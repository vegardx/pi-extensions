/**
 * `pi-ext-caffeinate` — the user-facing half of the keep-awake feature.
 *
 * The actual subprocess management and refcounting lives in
 * `@vegardx/pi-extensions-shared/caffeinate.js`. This extension only:
 *
 *   1. Self-declares so `/extensions` reports the schema (`enabled`,
 *      `flags`).
 *   2. Renders a footer pill ("caffeinate: active (develop, review)" /
 *      "caffeinate: inactive") via `ctx.ui.setStatus`.
 *   3. Exposes `/caffeinate` for on-demand status, and
 *      `/caffeinate test` to verify the wiring (acquires for 10s).
 *   4. Cleans up the footer on `session_shutdown`.
 *
 * Consumers (`modes`, `/review`, …) call `acquireKeepAwake(reason, ctx)`
 * directly. They do not depend on this extension being installed —
 * the shared helper is a no-op when settings disable it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	acquireKeepAwake,
	EXT_ID,
	getKeepAwakeState,
	type KeepAwakeState,
	subscribeKeepAwake,
} from "@vegardx/pi-extensions-shared/caffeinate.js";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";

/**
 * Build the footer pill text. Pure so the test suite can pin every
 * branch without a TUI.
 *
 * Examples:
 *   - linux/windows:                "caffeinate: unsupported (mac only)"
 *   - mac, opt-in disabled:         "caffeinate: disabled"
 *   - mac, enabled, idle:           "caffeinate: inactive"
 *   - mac, enabled, one holder:     "caffeinate: active (develop)"
 *   - mac, enabled, three holders:  "caffeinate: active (develop, review)"
 */
export function renderStatusLine(state: KeepAwakeState): string {
	if (!state.supported) return "caffeinate: unsupported (mac only)";
	if (!state.enabled && state.holders === 0) return "caffeinate: disabled";
	if (!state.active) return "caffeinate: inactive";
	const reasons = state.reasons.length ? ` (${state.reasons.join(", ")})` : "";
	return `caffeinate: active${reasons}`;
}

/**
 * Returns the pill string for the footer, or `undefined` to clear it.
 *
 * Visibility rules:
 *  - unsupported (non-darwin): always hidden — no actionable signal.
 *  - enabled + active: show "caffeinate: active (reason)".
 *  - enabled + idle: hidden — working as intended, no noise.
 *  - disabled + mid-hold (edge case, user toggled off live): hidden.
 *  - disabled + idle: show "caffeinate: disabled (run /caffeinate on)"
 *    so the feature is discoverable without needing to know the command.
 */
export function statusPill(state: KeepAwakeState): string | undefined {
	if (!state.supported) return undefined;
	if (state.active && state.enabled) {
		const reasons = state.reasons.length
			? ` (${state.reasons.join(", ")})`
			: "";
		return `caffeinate: active${reasons}`;
	}
	// Supported but opt-in not taken: discoverability pill.
	if (!state.enabled && !state.active) {
		return "caffeinate: disabled (run /caffeinate on)";
	}
	return undefined;
}

/**
 * Absolute path to the per-machine flag file that suppresses the one-time
 * first-run hint after it has been shown once.
 *
 * Exported so tests can override the path via the `hintShown` argument to
 * `shouldShowFirstRunHint` rather than poking the real filesystem.
 */
export function hintFlagPath(): string {
	return join(homedir(), ".pi", "agent", ".caffeinate-hinted");
}

/**
 * Returns true when the first-run discoverability hint should fire:
 * the platform is supported, the user hasn't opted in yet, and the hint
 * hasn't been shown before.
 *
 * Exported as a pure function so it can be unit-tested without touching
 * the real filesystem.
 */
export function shouldShowFirstRunHint(
	state: KeepAwakeState,
	hintAlreadyShown: boolean,
): boolean {
	return state.supported && !state.enabled && !hintAlreadyShown;
}

/**
 * One-shot human-readable status (used by `/caffeinate` with no args).
 * Renders multiple lines; we hand the join'd string to `ctx.ui.notify`.
 */
export function renderStatusReport(state: KeepAwakeState): string[] {
	const lines: string[] = [];
	lines.push(renderStatusLine(state));
	lines.push(`  supported: ${state.supported ? "yes (darwin)" : "no"}`);
	lines.push(
		`  enabled:   ${state.enabled ? "yes" : "no (opt-in via settings)"}`,
	);
	lines.push(`  active:    ${state.active ? "yes" : "no"}`);
	lines.push(`  holders:   ${state.holders}`);
	if (state.reasons.length) {
		lines.push(`  reasons:   ${state.reasons.join(", ")}`);
	}
	return lines;
}

/**
 * Read project `.pi/settings.json`, mutate `extensionConfig.caffeinate.enabled`,
 * write back. Pure-ish: returns the resolved file path so the command
 * handler can show the user where the change landed. Creates the file
 * (and parent dir) if missing.
 *
 * Exported for the test suite. The shape we care about is small enough
 * that we read the file as raw JSON and edit in place rather than
 * round-tripping through pi's typed `SettingsManager` (which has no
 * `extensionConfig` setter).
 */
export function setEnabledInProjectSettings(
	cwd: string,
	enabled: boolean,
): { path: string; previous: boolean } {
	const dir = join(cwd, ".pi");
	const path = join(dir, "settings.json");
	let raw: Record<string, unknown> = {};
	try {
		const body = readFileSync(path, "utf8");
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			raw = parsed as Record<string, unknown>;
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const extensionConfig =
		raw.extensionConfig &&
		typeof raw.extensionConfig === "object" &&
		!Array.isArray(raw.extensionConfig)
			? (raw.extensionConfig as Record<string, unknown>)
			: {};
	const caffeinateEntry =
		extensionConfig[EXT_ID] &&
		typeof extensionConfig[EXT_ID] === "object" &&
		!Array.isArray(extensionConfig[EXT_ID])
			? (extensionConfig[EXT_ID] as Record<string, unknown>)
			: {};

	const previous = caffeinateEntry.autoAcquire === true;
	caffeinateEntry.autoAcquire = enabled;
	// Drop the legacy key when present so the file ends up canonical.
	delete caffeinateEntry.enabled;
	extensionConfig[EXT_ID] = caffeinateEntry;
	raw.extensionConfig = extensionConfig;

	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
	return { path, previous };
}

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Hold the Mac awake while other extensions run unattended work.",
		configSchema: [
			{
				key: "autoAcquire",
				type: "boolean",
				default: false,
				doc: "When true, every acquireKeepAwake() call spawns/refcounts a caffeinate subprocess. When false, all acquires are no-ops.",
			},
			{
				key: "flags",
				type: "string[]",
				default: ["-i", "-m"],
				doc: 'caffeinate(8) flags passed at spawn time. `-w <pi-pid>` is always appended automatically. Default: ["-i", "-m"] (prevent idle sleep and disk-idle sleep; omits display sleep -d and AC-only -s).',
			},
		],
	},
	(pi: ExtensionAPI) => {
		let unsubscribe: (() => void) | null = null;

		const refresh = (ctx: ExtensionContext) => {
			const state = getKeepAwakeState(ctx);
			ctx.ui.setStatus(EXT_ID, statusPill(state));
		};

		pi.on("session_start", (_event, ctx) => {
			// Subscribe once per session — `session_shutdown` tears it down so
			// a fresh subscription installs on the next session_start.
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
			unsubscribe = subscribeKeepAwake(() => {
				// Re-render the pill on every refcount/state change. We
				// re-read state via ctx so `enabled` reflects the live
				// settings value — the snapshot passed by the shared helper
				// has no ctx and falls back to `enabled: holders > 0`, which
				// would show "disabled" after the last holder releases even
				// when the user opted in.
				ctx.ui.setStatus(EXT_ID, statusPill(getKeepAwakeState(ctx)));
			});
			refresh(ctx);

			// First-run discoverability hint: fire once per machine when the
			// feature is supported but the user hasn't opted in yet. A flag
			// file in ~/.pi/agent/ gates it so it never repeats.
			const hintShown = existsSync(hintFlagPath());
			if (shouldShowFirstRunHint(getKeepAwakeState(ctx), hintShown)) {
				try {
					mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
					writeFileSync(hintFlagPath(), "1");
				} catch {
					// Non-fatal: hint fires but flag write failed. It will
					// show again next session, which is acceptable.
				}
				ctx.ui.notify(
					"caffeinate is supported on this Mac but not yet enabled — " +
						"run /caffeinate on to prevent sleep during long sessions.",
					"info",
				);
			}
		});

		pi.on("session_shutdown", (_event, ctx) => {
			if (unsubscribe) {
				unsubscribe();
				unsubscribe = null;
			}
			// Clear the pill so a stale "active" string can't paint over the
			// next session's footer before its first state event.
			ctx.ui.setStatus(EXT_ID, undefined);
		});

		pi.registerCommand(EXT_ID, {
			description:
				"Show or toggle keep-awake. Subcommands: `status` (default) shows supported/enabled/active/holders; " +
				"`on` / `off` flip `extensionConfig.caffeinate.autoAcquire` in the project settings.json; " +
				"`test` acquires for 10s to verify the wiring.",
			handler: async (args, ctx) => {
				const arg = (args ?? "").trim();
				if (arg === "on" || arg === "off") {
					const next = arg === "on";
					try {
						const { path, previous } = setEnabledInProjectSettings(
							ctx.cwd,
							next,
						);
						if (previous === next) {
							ctx.ui.notify(`caffeinate: already ${arg} (${path})`, "info");
						} else {
							ctx.ui.notify(
								`caffeinate: turned ${arg} — wrote ${path}. Future acquires will ${
									next ? "spawn caffeinate" : "be no-ops"
								}; live holders are unaffected.`,
								"info",
							);
						}
						// Re-paint the pill: the `enabled` flag changed and there
						// may be no live holders to trigger a state event.
						refresh(ctx);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(
							`caffeinate: failed to write settings — ${msg}`,
							"error",
						);
					}
					return;
				}
				if (arg === "test") {
					if (!getKeepAwakeState(ctx).enabled) {
						ctx.ui.notify(
							"caffeinate: cannot test — run `/caffeinate on` first (or set extensionConfig.caffeinate.autoAcquire=true in settings.json).",
							"warning",
						);
						return;
					}
					const lock = acquireKeepAwake("caffeinate-test", ctx);
					ctx.ui.notify(
						"caffeinate: held for 10s — check the footer pill.",
						"info",
					);
					setTimeout(() => {
						lock.release();
						ctx.ui.notify("caffeinate: test hold released.", "info");
					}, 10_000);
					return;
				}
				if (arg && arg !== "status") {
					ctx.ui.notify(
						`caffeinate: unknown subcommand "${arg}" — expected status | on | off | test`,
						"warning",
					);
					return;
				}
				const state = getKeepAwakeState(ctx);
				ctx.ui.notify(renderStatusReport(state).join("\n"), "info");
			},
		});
	},
);
