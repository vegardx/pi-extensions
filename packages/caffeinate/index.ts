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
 * Consumers (`/develop`, `/review`, …) call `acquireKeepAwake(reason, ctx)`
 * directly. They do not depend on this extension being installed —
 * the shared helper is a no-op when settings disable it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	acquireKeepAwake,
	DEFAULT_FLAGS,
	EXT_ID,
	getKeepAwakeState,
	type KeepAwakeState,
	subscribeKeepAwake,
} from "@vegardx/pi-extensions-shared/caffeinate.js";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";

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

	const previous = caffeinateEntry.enabled === true;
	caffeinateEntry.enabled = enabled;
	extensionConfig[EXT_ID] = caffeinateEntry;
	raw.extensionConfig = extensionConfig;

	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
	return { path, previous };
}

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Hold the Mac awake while other extensions run unattended work.",
		configSchema: [
			{
				key: "enabled",
				type: "boolean",
				default: false,
				doc: "Master opt-in. When false, every acquireKeepAwake() returns a no-op handle and no caffeinate subprocess is ever spawned.",
			},
			{
				key: "flags",
				type: "string",
				default: [...DEFAULT_FLAGS],
				doc: "Argv passed to caffeinate(8) before the auto-appended `-w <pi-pid>`. Default: ['-i','-m'] — idle + disk-idle, no display, no AC-only system sleep.",
			},
		],
	});

	let unsubscribe: (() => void) | null = null;

	const refresh = (ctx: ExtensionContext) => {
		const state = getKeepAwakeState(ctx);
		ctx.ui.setStatus(EXT_ID, renderStatusLine(state));
	};

	pi.on("session_start", (_event, ctx) => {
		// Subscribe once per session — `session_shutdown` tears it down so
		// a fresh subscription installs on the next session_start.
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		unsubscribe = subscribeKeepAwake((state) => {
			// Re-render the pill on every refcount/state change. The
			// shared helper hands us a fresh snapshot; we render pure.
			ctx.ui.setStatus(EXT_ID, renderStatusLine(state));
		});
		refresh(ctx);
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
			"`on` / `off` flip `extensionConfig.caffeinate.enabled` in the project settings.json; " +
			"`test` acquires for 10s to verify the wiring.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "on" || arg === "off") {
				const next = arg === "on";
				try {
					const { path, previous } = setEnabledInProjectSettings(ctx.cwd, next);
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
						"caffeinate: cannot test — run `/caffeinate on` first (or set extensionConfig.caffeinate.enabled=true in settings.json).",
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
}
