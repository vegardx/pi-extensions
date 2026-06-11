import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCrashReport,
	type CrashHandlerDeps,
	type CrashReport,
	crashReportDir,
	crashReportFilename,
	installCrashHandler,
	type SessionAccessor,
} from "../crash-report.js";

// `uncaughtExceptionMonitor` is a real Node event but its name is
// not in `process.emit`'s typed overloads. Cast through the looser
// EventEmitter shape so the test reflects actual runtime usage.
const emit = (
	event: "uncaughtExceptionMonitor" | "unhandledRejection",
	...args: unknown[]
): void => {
	(process as unknown as NodeJS.EventEmitter).emit(event, ...args);
};

describe("buildCrashReport", () => {
	const baseInput = {
		timestamp: new Date("2026-05-16T17:30:00Z"),
		origin: "uncaughtException" as const,
		state: {
			mode: "auto",
			stage: "executing",
			branch: "feat/foo",
			planSlug: "demo-plan",
			activePhaseId: "phase-a",
		},
		session: { id: "sess-123", file: "/tmp/sess-123.jsonl" },
		entries: [],
	};

	it("captures error name, message, and stack from an Error instance", () => {
		const err = new Error("boom");
		err.name = "RuntimeError";
		const report = buildCrashReport({ ...baseInput, error: err });
		expect(report.error.name).toBe("RuntimeError");
		expect(report.error.message).toBe("boom");
		expect(report.error.stack).toContain("Error: boom");
	});

	it("normalises non-Error throws (string, object, primitive)", () => {
		const stringReport = buildCrashReport({ ...baseInput, error: "raw" });
		expect(stringReport.error.message).toBe("raw");
		expect(stringReport.error.stack).toBeNull();

		const objReport = buildCrashReport({
			...baseInput,
			error: { message: "shaped", stack: "  at fn" },
		});
		expect(objReport.error.message).toBe("shaped");
		expect(objReport.error.stack).toBe("  at fn");

		const numReport = buildCrashReport({ ...baseInput, error: 42 });
		expect(numReport.error.message).toBe("42");
	});

	it("propagates state + session fields verbatim", () => {
		const r = buildCrashReport({ ...baseInput, error: new Error("x") });
		expect(r.state).toEqual(baseInput.state);
		expect(r.session.id).toBe("sess-123");
	});

	it("redacts secret-shaped tokens in the error message + stack", () => {
		const err = new Error("token leak: ghp_AbCdEf1234567890ZzYy oops");
		err.stack = `Error: token leak: ghp_AbCdEf1234567890ZzYy\n    at fn`;
		const r = buildCrashReport({ ...baseInput, error: err });
		expect(r.error.message).not.toContain("ghp_AbCdEf1234567890ZzYy");
		expect(r.error.message).toContain("[REDACTED:");
		expect(r.error.stack).not.toContain("ghp_AbCdEf1234567890ZzYy");
		expect(r.redactionHits).toContain("secret-token");
	});

	it("collapses absolute home paths in session file + stack", () => {
		const err = new Error("at /Users/alice/code/oops.js:5");
		const r = buildCrashReport({
			...baseInput,
			error: err,
			session: { id: "sess", file: "/Users/alice/.pi/agent/sess.jsonl" },
		});
		expect(r.session.file).toContain("~/.pi/agent");
		expect(r.session.file).not.toContain("/Users/alice");
		expect(r.error.message).not.toContain("/Users/alice");
	});

	it("summarises last 6 session entries with role + truncation", () => {
		const entries: unknown[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push({ role: "user", content: `msg ${i}` });
		}
		const r = buildCrashReport({
			...baseInput,
			error: new Error("x"),
			entries,
		});
		expect(r.recentEntries).toHaveLength(6);
		expect(r.recentEntries[0]?.text).toBe("msg 4");
		expect(r.recentEntries[5]?.text).toBe("msg 9");
	});

	it("truncates long entry text with a marker", () => {
		const long = "x".repeat(2000);
		const r = buildCrashReport({
			...baseInput,
			error: new Error("x"),
			entries: [{ role: "assistant", content: long }],
		});
		expect(r.recentEntries[0]?.text).toContain("…[truncated");
		expect(r.recentEntries[0]?.text.length).toBeLessThan(long.length);
	});

	it("handles content as part array", () => {
		const r = buildCrashReport({
			...baseInput,
			error: new Error("x"),
			entries: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "first" },
						{ type: "text", text: "second" },
					],
				},
			],
		});
		expect(r.recentEntries[0]?.text).toBe("first\nsecond");
	});

	it("normalises unknown role to 'other'", () => {
		const r = buildCrashReport({
			...baseInput,
			error: new Error("x"),
			entries: [{ role: "system", content: "hi" }],
		});
		expect(r.recentEntries[0]?.role).toBe("other");
	});

	it("returns empty redactionHits when nothing matched", () => {
		const r = buildCrashReport({
			...baseInput,
			error: new Error("plain message"),
			session: { id: "sess", file: "/tmp/sess.jsonl" },
			entries: [{ role: "user", content: "hello" }],
		});
		expect(r.redactionHits).toEqual([]);
	});

	it("dedupes redaction-hit kinds", () => {
		const err = new Error("a ghp_AAAAAAAAAAAAAAAA b ghp_BBBBBBBBBBBBBBBB");
		const r = buildCrashReport({ ...baseInput, error: err });
		const tokenHits = r.redactionHits.filter((k) => k === "secret-token");
		expect(tokenHits).toHaveLength(1);
	});
});

describe("crashReportFilename", () => {
	it("is filesystem-safe", () => {
		const name = crashReportFilename({
			timestamp: new Date("2026-05-16T17:30:00.123Z"),
			sessionId: "sess/with:bad?chars",
		});
		expect(name).not.toMatch(/[/:?]/);
		expect(name.endsWith(".json")).toBe(true);
	});

	it("falls back to 'unknown' when sessionId is null", () => {
		const name = crashReportFilename({
			timestamp: new Date("2026-05-16T17:30:00Z"),
			sessionId: null,
		});
		expect(name).toContain("unknown");
	});
});

describe("crashReportDir", () => {
	it("composes <agent-dir>/modes/crash-reports", () => {
		expect(crashReportDir("/home/u/agent")).toBe(
			"/home/u/agent/modes/crash-reports",
		);
	});
});

describe("installCrashHandler", () => {
	let dispose: (() => void) | null = null;
	let tmp: string;
	const writes: Array<{ path: string; payload: string }> = [];

	beforeEach(() => {
		writes.length = 0;
		tmp = mkdtempSync(join(tmpdir(), "crash-test-"));
	});

	afterEach(() => {
		dispose?.();
		dispose = null;
		rmSync(tmp, { recursive: true, force: true });
	});

	const session: SessionAccessor = {
		getSessionId: () => "sid",
		getSessionFile: () => "/tmp/sid.jsonl",
		getEntries: () => [{ role: "user", content: "hi" }],
	};

	function deps(over: Partial<CrashHandlerDeps> = {}): CrashHandlerDeps {
		return {
			getModeSnapshot: () => ({
				mode: "auto",
				stage: "executing",
				branch: "feat/x",
				planSlug: "p",
				activePhaseId: "ph",
			}),
			getSessionAccessor: () => session,
			writeReport: (path, payload) => writes.push({ path, payload }),
			agentDir: () => tmp,
			now: () => new Date("2026-05-16T17:30:00Z"),
			...over,
		};
	}

	it("does NOT fire when stage is not 'executing'", async () => {
		dispose = installCrashHandler(
			deps({
				getModeSnapshot: () => ({
					mode: "plan",
					stage: "planning",
					branch: null,
					planSlug: "p",
					activePhaseId: null,
				}),
			}),
		);
		// Simulate uncaughtException via direct emit
		emit("uncaughtExceptionMonitor", new Error("ignored"), "uncaughtException");
		expect(writes).toHaveLength(0);
	});

	it("fires on uncaughtExceptionMonitor when executing", () => {
		dispose = installCrashHandler(deps());
		emit("uncaughtExceptionMonitor", new Error("crash"), "uncaughtException");
		expect(writes).toHaveLength(1);
		const write = writes[0];
		if (!write) throw new Error("expected a crash write");
		const report = JSON.parse(write.payload) as CrashReport;
		expect(report.origin).toBe("uncaughtException");
		expect(report.error.message).toBe("crash");
		expect(report.session.id).toBe("sid");
		expect(write.path).toContain("crash-reports");
	});

	it("fires on unhandledRejection (note: this changes process semantics)", () => {
		dispose = installCrashHandler(deps());
		// `unhandledRejection` listeners receive (reason, promise). We
		// only care that our listener writes a report; we don't reject
		// a real Promise here because that would fail the test runner.
		// NOTE: registering this listener suppresses Node's default
		// terminate-on-unhandled-rejection — a deliberate tradeoff
		// documented in `crash-report.ts` (capturing a TUI session's
		// crash context is more valuable than a silent termination).
		emit("unhandledRejection", new Error("rejected"), Promise.resolve());
		expect(writes).toHaveLength(1);
		const write = writes[0];
		if (!write) throw new Error("expected a crash write");
		const report = JSON.parse(write.payload) as CrashReport;
		expect(report.origin).toBe("unhandledRejection");
		expect(report.error.message).toBe("rejected");
	});

	it("never throws when getSessionAccessor returns null", () => {
		dispose = installCrashHandler(deps({ getSessionAccessor: () => null }));
		expect(() => {
			emit("uncaughtExceptionMonitor", new Error("crash"), "uncaughtException");
		}).not.toThrow();
		expect(writes).toHaveLength(1);
		const write = writes[0];
		if (!write) throw new Error("expected a crash write");
		const report = JSON.parse(write.payload) as CrashReport;
		expect(report.session.id).toBeNull();
		expect(report.recentEntries).toEqual([]);
	});

	it("swallows errors thrown inside the handler (crash-in-crash safety)", () => {
		dispose = installCrashHandler(
			deps({
				getModeSnapshot: () => {
					throw new Error("getter exploded");
				},
			}),
		);
		expect(() => {
			emit("uncaughtExceptionMonitor", new Error("crash"), "uncaughtException");
		}).not.toThrow();
		expect(writes).toHaveLength(0);
	});

	it("writes to disk when no writeReport seam is provided", () => {
		dispose = installCrashHandler({
			getModeSnapshot: () => ({
				mode: "auto",
				stage: "executing",
				branch: "feat/x",
				planSlug: "p",
				activePhaseId: "ph",
			}),
			getSessionAccessor: () => session,
			agentDir: () => tmp,
			now: () => new Date("2026-05-16T17:30:00Z"),
		});
		emit(
			"uncaughtExceptionMonitor",
			new Error("real-disk"),
			"uncaughtException",
		);
		const dir = crashReportDir(tmp);
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const file = files[0];
		if (!file) throw new Error("expected a crash report file");
		const content = readFileSync(join(dir, file), "utf8");
		const report = JSON.parse(content) as CrashReport;
		expect(report.error.message).toBe("real-disk");
	});

	it("dispose() removes both listeners", () => {
		dispose = installCrashHandler(deps());
		dispose();
		dispose = null;
		emit(
			"uncaughtExceptionMonitor",
			new Error("after-dispose"),
			"uncaughtException",
		);
		expect(writes).toHaveLength(0);
	});
});
