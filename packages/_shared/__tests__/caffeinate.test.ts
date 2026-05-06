import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	__getChildForTests,
	__resetForTests,
	__setPlatformForTests,
	__setSpawnerForTests,
	acquireKeepAwake,
	DEFAULT_FLAGS,
	getKeepAwakeState,
	subscribeKeepAwake,
} from "../caffeinate.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Minimal `caffeinate` stand-in: tracks args, exposes a kill(), and
 * looks enough like a ChildProcess for the helper's runtime path
 * (.on('error'), .on('exit'), .kill(), .killed, .unref()).
 */
class FakeChild extends EventEmitter {
	killed = false;
	readonly pid = 12345;
	constructor(public readonly args: readonly string[]) {
		super();
	}
	kill(_signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		// emit synchronously so the helper's `exit` listener can clear
		// `internals.child` before the test inspects it.
		this.emit("exit", null, "SIGTERM");
		return true;
	}
	unref(): this {
		return this;
	}
}

/** spawn() stub that records every call and returns a FakeChild. */
function makeRecordingSpawner() {
	const calls: Array<{ command: string; args: readonly string[] }> = [];
	let lastChild: FakeChild | null = null;
	const fn = ((command: string, args: readonly string[]) => {
		calls.push({ command, args });
		const child = new FakeChild(args);
		lastChild = child;
		return child as unknown as ReturnType<
			typeof import("node:child_process").spawn
		>;
	}) as unknown as typeof import("node:child_process").spawn;
	return {
		fn,
		calls,
		get last() {
			return lastChild;
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers — isolated cwd + global settings dir
// ---------------------------------------------------------------------------

function mkTempCwd(): string {
	return mkdtempSync(join(tmpdir(), "pi-ext-caffeinate-test-"));
}

function writeProjectSettings(cwd: string, body: unknown): void {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(body));
}

function withIsolatedAgentDir<T>(fn: () => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-caffeinate-test-agent-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
}

function ctxFor(cwd: string): ExtensionContext {
	// We only use ctx.cwd in the shared helper. Cast to satisfy the type.
	return { cwd } as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("caffeinate (shared)", () => {
	beforeEach(() => {
		__resetForTests();
	});

	afterEach(() => {
		__resetForTests();
	});

	it("returns a no-op handle on non-darwin and never spawns", () => {
		__setPlatformForTests("linux");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				// enabled in settings — but platform is wrong, so still no-op.
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});
				const lock = acquireKeepAwake("test", ctxFor(cwd));
				expect(spawner.calls).toHaveLength(0);
				expect(getKeepAwakeState().active).toBe(false);
				expect(getKeepAwakeState().supported).toBe(false);
				lock.release(); // idempotent, must not throw
				lock.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("returns a no-op handle on darwin when enabled is unset (opt-in)", () => {
		__setPlatformForTests("darwin");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				// no settings written → enabled defaults to false
				const lock = acquireKeepAwake("test", ctxFor(cwd));
				expect(spawner.calls).toHaveLength(0);
				expect(getKeepAwakeState().active).toBe(false);
				lock.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("returns a no-op handle when enabled is explicitly false", () => {
		__setPlatformForTests("darwin");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: false } },
				});
				const lock = acquireKeepAwake("test", ctxFor(cwd));
				expect(spawner.calls).toHaveLength(0);
				lock.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("spawns caffeinate on the first acquire and reuses the child", () => {
		__setPlatformForTests("darwin");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});

				const a = acquireKeepAwake("alpha", ctxFor(cwd));
				expect(spawner.calls).toHaveLength(1);
				expect(spawner.calls[0]?.command).toBe("caffeinate");
				expect(spawner.calls[0]?.args).toEqual([
					...DEFAULT_FLAGS,
					"-w",
					String(process.pid),
				]);

				const b = acquireKeepAwake("beta", ctxFor(cwd));
				// Reuses the same child — no second spawn.
				expect(spawner.calls).toHaveLength(1);

				const state = getKeepAwakeState();
				expect(state.active).toBe(true);
				expect(state.holders).toBe(2);
				expect(state.reasons).toEqual(["alpha", "beta"]);

				a.release();
				expect(__getChildForTests()).not.toBeNull(); // beta still holding
				b.release();
				expect(__getChildForTests()).toBeNull(); // child killed on 1→0
				expect(getKeepAwakeState().active).toBe(false);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("dedupes reasons in the snapshot", () => {
		__setPlatformForTests("darwin");
		__setSpawnerForTests(makeRecordingSpawner().fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});
				const a = acquireKeepAwake("develop", ctxFor(cwd));
				const b = acquireKeepAwake("develop", ctxFor(cwd));
				const c = acquireKeepAwake("review", ctxFor(cwd));
				const state = getKeepAwakeState();
				expect(state.holders).toBe(3);
				expect(state.reasons).toEqual(["develop", "review"]);
				a.release();
				b.release();
				c.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("honors a custom flags array from settings", () => {
		__setPlatformForTests("darwin");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: {
						caffeinate: { enabled: true, flags: ["-i", "-d", "-m"] },
					},
				});
				const lock = acquireKeepAwake("test", ctxFor(cwd));
				expect(spawner.calls[0]?.args).toEqual([
					"-i",
					"-d",
					"-m",
					"-w",
					String(process.pid),
				]);
				lock.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("falls back to DEFAULT_FLAGS when settings.flags is malformed", () => {
		__setPlatformForTests("darwin");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: {
						caffeinate: { enabled: true, flags: "not-an-array" },
					},
				});
				const lock = acquireKeepAwake("test", ctxFor(cwd));
				expect(spawner.calls[0]?.args).toEqual([
					...DEFAULT_FLAGS,
					"-w",
					String(process.pid),
				]);
				lock.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("releases idempotently — second release is a no-op", () => {
		__setPlatformForTests("darwin");
		__setSpawnerForTests(makeRecordingSpawner().fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});
				const a = acquireKeepAwake("a", ctxFor(cwd));
				const b = acquireKeepAwake("b", ctxFor(cwd));
				a.release();
				a.release(); // double-release must not double-decrement
				expect(getKeepAwakeState().holders).toBe(1);
				b.release();
				expect(getKeepAwakeState().holders).toBe(0);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("notifies subscribers on acquire, release, and disabled-acquire", () => {
		__setPlatformForTests("darwin");
		__setSpawnerForTests(makeRecordingSpawner().fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				const states: Array<ReturnType<typeof getKeepAwakeState>> = [];
				const unsubscribe = subscribeKeepAwake((s) => states.push(s));

				// disabled acquire → still notifies (so the footer sees `enabled: false`)
				const noop = acquireKeepAwake("x", ctxFor(cwd));
				expect(states.at(-1)?.enabled).toBe(false);
				expect(states.at(-1)?.active).toBe(false);
				noop.release();

				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});

				const a = acquireKeepAwake("a", ctxFor(cwd));
				expect(states.at(-1)).toMatchObject({
					enabled: true,
					active: true,
					holders: 1,
					reasons: ["a"],
				});
				a.release();
				expect(states.at(-1)).toMatchObject({
					active: false,
					holders: 0,
					reasons: [],
				});

				unsubscribe();
				const b = acquireKeepAwake("b", ctxFor(cwd));
				const before = states.length;
				b.release();
				// no further notifications after unsubscribe
				expect(states.length).toBe(before);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("clears child reference if the subprocess emits 'error'", () => {
		__setPlatformForTests("darwin");
		const spawner = makeRecordingSpawner();
		__setSpawnerForTests(spawner.fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});
				const lock = acquireKeepAwake("test", ctxFor(cwd));
				const child = spawner.last;
				expect(child).not.toBeNull();
				// Simulate `caffeinate not found` etc.
				child?.emit("error", new Error("ENOENT"));
				expect(__getChildForTests()).toBeNull();
				expect(getKeepAwakeState().active).toBe(false);
				// Holder is still alive — release must remain valid.
				lock.release();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("getKeepAwakeState(ctx) reads enabled from settings even with no holders", () => {
		__setPlatformForTests("darwin");
		__setSpawnerForTests(makeRecordingSpawner().fn);

		withIsolatedAgentDir(() => {
			const cwd = mkTempCwd();
			try {
				writeProjectSettings(cwd, {
					extensionConfig: { caffeinate: { enabled: true } },
				});
				const state = getKeepAwakeState(ctxFor(cwd));
				expect(state.enabled).toBe(true);
				expect(state.holders).toBe(0);
				expect(state.active).toBe(false);
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});
