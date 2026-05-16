import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultCrashReportDir,
	loadCrashReportsForSession,
} from "../crash-reports.js";

function makeReport(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		schemaVersion: 1,
		timestamp: "2026-05-16T17:30:00.000Z",
		origin: "uncaughtException",
		error: { name: "Error", message: "boom", stack: "Error: boom\n  at fn" },
		state: {
			mode: "auto",
			stage: "executing",
			branch: "feat/x",
			planSlug: "p",
			activePhaseId: "ph",
		},
		session: { id: "sess-1", file: "~/.pi/agent/sess-1.jsonl" },
		recentEntries: [{ role: "user", text: "go" }],
		redactionHits: [],
		...over,
	});
}

describe("loadCrashReportsForSession", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "derp-crash-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns [] when the directory does not exist", () => {
		const r = loadCrashReportsForSession("sess", join(dir, "missing"));
		expect(r).toEqual([]);
	});

	it("returns [] when sessionId is empty", () => {
		const r = loadCrashReportsForSession("", dir);
		expect(r).toEqual([]);
	});

	it("loads matching reports, newest first", () => {
		writeFileSync(
			join(dir, "2026-05-16T17-00-00-000Z-sess-1.json"),
			makeReport({ timestamp: "2026-05-16T17:00:00Z" }),
		);
		writeFileSync(
			join(dir, "2026-05-16T17-30-00-000Z-sess-1.json"),
			makeReport({ timestamp: "2026-05-16T17:30:00Z" }),
		);
		const r = loadCrashReportsForSession("sess-1", dir);
		expect(r).toHaveLength(2);
		// newest first by filename (ISO timestamp embedded — see source)
		expect(r[0]?.sourcePath).toContain("17-30");
	});

	it("skips reports whose session.id does not match (filename collision defence)", () => {
		// Filename includes "sess-1" but inner payload is for sess-9
		writeFileSync(
			join(dir, "2026-05-16T17-00-00-sess-1-evil.json"),
			makeReport({ session: { id: "sess-9", file: null } }),
		);
		expect(loadCrashReportsForSession("sess-1", dir)).toEqual([]);
	});

	it("skips files with the wrong schemaVersion", () => {
		writeFileSync(
			join(dir, "2026-05-16T17-00-00-sess-1.json"),
			makeReport({ schemaVersion: 2 }),
		);
		expect(loadCrashReportsForSession("sess-1", dir)).toEqual([]);
	});

	it("skips malformed JSON", () => {
		writeFileSync(join(dir, "2026-05-16T17-00-00-sess-1.json"), "{not json");
		expect(loadCrashReportsForSession("sess-1", dir)).toEqual([]);
	});

	it("ignores non-.json files", () => {
		writeFileSync(join(dir, "sess-1.txt"), "not a report");
		expect(loadCrashReportsForSession("sess-1", dir)).toEqual([]);
	});

	it("ignores files whose name does not contain the sessionId", () => {
		writeFileSync(join(dir, "other.json"), makeReport());
		expect(loadCrashReportsForSession("sess-1", dir)).toEqual([]);
	});

	it("populates the parsed shape end-to-end", () => {
		writeFileSync(join(dir, "2026-05-16T17-00-00-sess-1.json"), makeReport());
		const [r] = loadCrashReportsForSession("sess-1", dir);
		expect(r?.error.message).toBe("boom");
		expect(r?.state.activePhaseId).toBe("ph");
		expect(r?.recentEntries[0]?.text).toBe("go");
		expect(r?.redactionHits).toEqual([]);
	});
});

describe("defaultCrashReportDir", () => {
	it("composes ~/.pi/agent/modes/crash-reports", () => {
		expect(defaultCrashReportDir("/home/u")).toBe(
			"/home/u/.pi/agent/modes/crash-reports",
		);
	});
});
