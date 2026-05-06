/**
 * Shared "keep the Mac awake while we work" helper for the extensions
 * in this monorepo.
 *
 * ## Why
 *
 * Long unattended runs — `/develop`'s auto-verify + auto-review loops,
 * `/review`'s seven-reviewer fan-out — can chew through several minutes
 * of LLM + tool work while the user is away from the keyboard. macOS
 * idle-sleep kills the network sockets and the agent silently stalls.
 * `caffeinate(8)` is the canonical, pre-installed mac fix.
 *
 * ## Shape
 *
 * Caller-driven, refcounted, single subprocess:
 *
 *     const lock = acquireKeepAwake("review", ctx);
 *     try { await runReview(...); } finally { lock.release(); }
 *
 * - First acquire (refcount 0→1) spawns `caffeinate -i -m -w <pi-pid>`.
 * - Subsequent acquires bump the refcount and reuse the child.
 * - `release()` is idempotent. Last release (1→0) sends SIGTERM to the
 *   child; the `-w <pid>` flag is belt-and-braces so the kernel reaps
 *   the process if pi crashes before we can.
 *
 * ## Opt-in
 *
 * `acquireKeepAwake` checks `extensionConfig.caffeinate.enabled` in
 * settings.json. When unset or `false`, every acquire returns a no-op
 * handle — consumers don't need to special-case the "user hasn't
 * opted in" path. Same for non-darwin platforms.
 *
 * ## Footer state
 *
 * The standalone `caffeinate` extension renders the active/inactive
 * footer pill. It subscribes via `subscribeKeepAwake(listener)` and
 * gets notified on every refcount change.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getExtensionConfigBoolean,
	readRelevantSettings,
} from "./extension-settings.js";

export const EXT_ID = "caffeinate";

/**
 * Default `caffeinate` flags. Idle + disk-idle, but not display
 * (`-d`) — agents work headless, screen sleep is fine — and not `-s`
 * (only relevant on AC; `-i` covers idle sleep on either power source).
 *
 * `-w <pi-pid>` is appended at spawn time so the OS reaps the child
 * if pi dies abruptly.
 */
export const DEFAULT_FLAGS: readonly string[] = ["-i", "-m"];

/**
 * Snapshot of the keep-awake state. The footer renderer treats this
 * as immutable; mutators publish a fresh snapshot.
 */
export interface KeepAwakeState {
	/** True when `extensionConfig.caffeinate.enabled` is `true` in the layered settings. */
	enabled: boolean;
	/**
	 * True when the host platform is `darwin`. On other platforms every
	 * `acquireKeepAwake` returns a no-op handle and `active` stays
	 * false forever.
	 */
	supported: boolean;
	/** True when refcount > 0 and a `caffeinate` child is currently running. */
	active: boolean;
	/** Distinct reasons currently holding the lock (deduped, sorted). */
	reasons: readonly string[];
	/** Total live token count (a single reason can hold multiple tokens). */
	holders: number;
}

export interface KeepAwakeHandle {
	readonly reason: string;
	/**
	 * Drop this handle's reference. Idempotent — calling it twice does
	 * nothing on the second call.
	 */
	release(): void;
}

type Listener = (state: KeepAwakeState) => void;

interface Holder {
	id: symbol;
	reason: string;
}

interface Internals {
	holders: Map<symbol, Holder>;
	child: ChildProcess | null;
	listeners: Set<Listener>;
	/**
	 * Test seam. When set, `acquireKeepAwake` calls this instead of
	 * `node:child_process.spawn`. The returned object only needs
	 * `kill()` and `pid` for our purposes.
	 */
	spawner: typeof spawn;
	/**
	 * Cached "is darwin" — let tests pretend to be on a mac without
	 * touching `process.platform`.
	 */
	platform: NodeJS.Platform;
	exitListenerInstalled: boolean;
}

const internals: Internals = {
	holders: new Map(),
	child: null,
	listeners: new Set(),
	spawner: spawn,
	platform: process.platform,
	exitListenerInstalled: false,
};

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function snapshot(enabledOverride?: boolean): KeepAwakeState {
	// `enabled` is a per-acquire computation (it depends on the live
	// settings.json). For listener notifications we don't have a ctx,
	// so we only flip `enabled` to a known value when explicitly told.
	// Snapshots emitted from `acquireKeepAwake`/`release` carry the
	// correct value; passive `getKeepAwakeState()` calls without a ctx
	// report `enabled: holders > 0` (i.e. trust the live refcount —
	// holders only exist if some prior acquire saw `enabled=true`).
	const reasons = new Set<string>();
	for (const h of internals.holders.values()) reasons.add(h.reason);
	const sorted = [...reasons].sort();
	const active = internals.child !== null;
	const supported = internals.platform === "darwin";
	return {
		enabled: enabledOverride ?? (supported && internals.holders.size > 0),
		supported,
		active,
		reasons: sorted,
		holders: internals.holders.size,
	};
}

function notify(state: KeepAwakeState): void {
	for (const fn of internals.listeners) {
		try {
			fn(state);
		} catch {
			// Listener errors shouldn't poison the refcount.
		}
	}
}

function readEnabled(ctx: ExtensionContext): boolean {
	const settings = readRelevantSettings(ctx.cwd);
	return getExtensionConfigBoolean(settings, EXT_ID, "enabled", false);
}

function readFlags(ctx: ExtensionContext): readonly string[] {
	const settings = readRelevantSettings(ctx.cwd);
	const raw = settings.extensionConfig?.[EXT_ID]?.flags;
	if (Array.isArray(raw) && raw.every((f) => typeof f === "string")) {
		return raw as string[];
	}
	return DEFAULT_FLAGS;
}

// ---------------------------------------------------------------------------
// Subprocess management
// ---------------------------------------------------------------------------

function ensureExitListener(): void {
	if (internals.exitListenerInstalled) return;
	internals.exitListenerInstalled = true;
	// Best-effort: kill the child if pi dies in a way that bypasses
	// session_shutdown. `-w <pid>` is the real safety net; this just
	// shaves a few seconds off in the normal exit path.
	const cleanup = () => {
		if (internals.child && !internals.child.killed) {
			try {
				internals.child.kill("SIGTERM");
			} catch {
				// already gone
			}
		}
	};
	process.once("exit", cleanup);
}

function startChild(flags: readonly string[]): void {
	if (internals.child) return;
	const args = [...flags, "-w", String(process.pid)];
	const child = internals.spawner("caffeinate", args, {
		stdio: "ignore",
		detached: false,
	});
	child.on("error", () => {
		// `caffeinate` not found, perms denied, etc. Drop the reference;
		// further acquires will retry on the next 0→1 transition.
		if (internals.child === child) {
			internals.child = null;
			notify(snapshot());
		}
	});
	child.on("exit", () => {
		if (internals.child === child) {
			internals.child = null;
			notify(snapshot());
		}
	});
	// Don't keep node alive on this child — pi's own event loop owns
	// the lifetime, and the kernel will SIGKILL caffeinate once pi (the
	// `-w` target) goes away.
	if (typeof child.unref === "function") child.unref();
	internals.child = child;
	ensureExitListener();
}

function stopChild(): void {
	const child = internals.child;
	if (!child) return;
	internals.child = null;
	if (!child.killed) {
		try {
			child.kill("SIGTERM");
		} catch {
			// already gone
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const NOOP_HANDLE: KeepAwakeHandle = Object.freeze({
	reason: "(noop)",
	release() {},
});

/**
 * Acquire a keep-awake token. Spawns `caffeinate` on the first live
 * holder and reuses it across subsequent acquires.
 *
 * Returns a no-op handle (and never spawns) when:
 *   - the host is not macOS, or
 *   - `extensionConfig.caffeinate.enabled` is not `true` in the
 *     project/global settings layered view at the time of acquire.
 *
 * The opt-in check happens **once per acquire**, by design. Toggling
 * `enabled` mid-session affects future acquires but does not retro-
 * actively release existing holders — a long-running consumer that
 * acquired before the toggle keeps the laptop awake until it
 * releases. That's the expected behavior: a flag flip should not
 * abort an in-flight operation.
 */
export function acquireKeepAwake(
	reason: string,
	ctx: ExtensionContext,
): KeepAwakeHandle {
	if (internals.platform !== "darwin") return NOOP_HANDLE;
	const enabled = readEnabled(ctx);
	if (!enabled) {
		// Re-publish state so the footer reflects the current `enabled`
		// value even if nothing actually changed in the holder set.
		notify(snapshot(false));
		return NOOP_HANDLE;
	}

	const id = Symbol("keep-awake-token");
	const cleanReason = reason.trim() || "(unnamed)";
	internals.holders.set(id, { id, reason: cleanReason });
	if (internals.holders.size === 1) {
		startChild(readFlags(ctx));
	}
	notify(snapshot(true));

	let released = false;
	return {
		reason: cleanReason,
		release() {
			if (released) return;
			released = true;
			internals.holders.delete(id);
			if (internals.holders.size === 0) stopChild();
			notify(snapshot(internals.holders.size > 0));
		},
	};
}

/**
 * Read the current state without acquiring anything. Pass `ctx` to
 * get an accurate `enabled` flag (reads settings.json). Without it
 * the helper reports `enabled = holders > 0`, which is good enough
 * for the footer pill but not for "should I bother offering the
 * keep-awake to the user" branches.
 */
export function getKeepAwakeState(ctx?: ExtensionContext): KeepAwakeState {
	if (ctx) return snapshot(readEnabled(ctx));
	return snapshot();
}

/**
 * Subscribe to state changes. The listener fires on every acquire and
 * release (and on child-process death). Returns an unsubscribe
 * function.
 *
 * The subscriber is *not* called immediately with the current state —
 * pull it via `getKeepAwakeState()` once at registration time if you
 * need the initial paint.
 */
export function subscribeKeepAwake(listener: Listener): () => void {
	internals.listeners.add(listener);
	return () => {
		internals.listeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Test-only seams
// ---------------------------------------------------------------------------

/**
 * Test-only: drop every holder, kill any child, clear listeners, and
 * reset the spawner / platform overrides to their defaults.
 */
export function __resetForTests(): void {
	for (const id of [...internals.holders.keys()]) internals.holders.delete(id);
	if (internals.child) {
		try {
			internals.child.kill("SIGTERM");
		} catch {
			// ignore
		}
		internals.child = null;
	}
	internals.listeners.clear();
	internals.spawner = spawn;
	internals.platform = process.platform;
}

/**
 * Test-only: install a fake `spawn` so tests can assert on argv
 * without actually launching `caffeinate`. Call `__resetForTests()`
 * after the test to restore.
 */
export function __setSpawnerForTests(fn: typeof spawn): void {
	internals.spawner = fn;
}

/**
 * Test-only: pretend to be on a different platform.
 */
export function __setPlatformForTests(p: NodeJS.Platform): void {
	internals.platform = p;
}

/** Test-only: peek at the active child reference (or null). */
export function __getChildForTests(): ChildProcess | null {
	return internals.child;
}
