import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { launchEditor } from "../spawn.js";

interface FakeChild extends EventEmitter {
	unref: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
	const ee = new EventEmitter() as FakeChild;
	ee.unref = vi.fn();
	return ee;
}

describe("launchEditor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves ok on the spawn event and unrefs detached children", async () => {
		const child = makeChild();
		const spawn = vi.fn().mockReturnValue(child);

		const promise = launchEditor(
			{ command: "code", args: ["foo.ts"], cwd: "/repo", detach: true },
			{ spawn: spawn as never },
		);

		// Emit `spawn` after a microtask so we exercise the event path,
		// not the 100ms grace fallback.
		await Promise.resolve();
		child.emit("spawn");

		const outcome = await promise;
		expect(outcome).toEqual({ ok: true });
		expect(spawn).toHaveBeenCalledWith(
			"code",
			["foo.ts"],
			expect.objectContaining({
				cwd: "/repo",
				detached: true,
				stdio: "ignore",
			}),
		);
		expect(child.unref).toHaveBeenCalledOnce();
	});

	it("does not unref when detach=false", async () => {
		const child = makeChild();
		const spawn = vi.fn().mockReturnValue(child);

		const promise = launchEditor(
			{ command: "vim", args: ["foo.ts"], cwd: "/repo", detach: false },
			{ spawn: spawn as never },
		);
		await Promise.resolve();
		child.emit("spawn");
		await promise;

		expect(child.unref).not.toHaveBeenCalled();
		expect(spawn).toHaveBeenCalledWith(
			"vim",
			["foo.ts"],
			expect.objectContaining({ detached: false }),
		);
	});

	it("reports not-found on ENOENT (PATH miss)", async () => {
		const child = makeChild();
		const spawn = vi.fn().mockReturnValue(child);

		const promise = launchEditor(
			{ command: "missing-tool", args: [], cwd: "/repo", detach: true },
			{ spawn: spawn as never },
		);

		await Promise.resolve();
		const err = Object.assign(new Error("spawn missing-tool ENOENT"), {
			code: "ENOENT",
		});
		child.emit("error", err);

		const outcome = await promise;
		expect(outcome).toMatchObject({
			ok: false,
			reason: "not-found",
		});
		if (!outcome.ok) {
			expect(outcome.detail).toContain("missing-tool");
		}
	});

	it("reports spawn-failed for non-ENOENT errors", async () => {
		const child = makeChild();
		const spawn = vi.fn().mockReturnValue(child);

		const promise = launchEditor(
			{ command: "code", args: [], cwd: "/repo", detach: true },
			{ spawn: spawn as never },
		);
		await Promise.resolve();
		const err = Object.assign(new Error("EACCES: permission denied"), {
			code: "EACCES",
		});
		child.emit("error", err);

		const outcome = await promise;
		expect(outcome).toEqual({
			ok: false,
			reason: "spawn-failed",
			detail: "EACCES: permission denied",
		});
	});

	it("reports spawn-failed when spawn() throws synchronously", async () => {
		const spawn = vi.fn().mockImplementation(() => {
			throw new Error("synchronous spawn failure");
		});

		const outcome = await launchEditor(
			{ command: "code", args: [], cwd: "/repo", detach: true },
			{ spawn: spawn as never },
		);

		expect(outcome).toEqual({
			ok: false,
			reason: "spawn-failed",
			detail: "synchronous spawn failure",
		});
	});

	it("falls through to ok after the 100ms grace if neither event fires", async () => {
		const child = makeChild();
		const spawn = vi.fn().mockReturnValue(child);

		const promise = launchEditor(
			{ command: "code", args: [], cwd: "/repo", detach: true },
			{ spawn: spawn as never },
		);

		// Drive past the 100ms grace without emitting anything.
		await vi.advanceTimersByTimeAsync(150);

		const outcome = await promise;
		expect(outcome).toEqual({ ok: true });
	});

	it("treats the first settle as authoritative — late events are ignored", async () => {
		const child = makeChild();
		const spawn = vi.fn().mockReturnValue(child);

		const promise = launchEditor(
			{ command: "code", args: [], cwd: "/repo", detach: true },
			{ spawn: spawn as never },
		);
		await Promise.resolve();
		child.emit("spawn");
		const outcome = await promise;
		expect(outcome).toEqual({ ok: true });

		// A late error event must not change the resolved value or throw.
		expect(() =>
			child.emit("error", Object.assign(new Error("late"), { code: "ENOENT" })),
		).not.toThrow();
	});
});
