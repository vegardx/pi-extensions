import type { DerpContext } from "../context.js";
import type { CrashReportSummary } from "../crash-reports.js";
import {
	applyTitlePrefix,
	buildFallbackIssue,
	buildPolishTask,
	validatePolishOutput,
} from "../template.js";

function makeCtx(overrides: Partial<DerpContext> = {}): DerpContext {
	return {
		userText: "ghost text overlaps the input on iTerm",
		date: "2026-05-10",
		sessionId: "session-abc",
		sessionName: "test session",
		piVersion: "0.73.0",
		recentEntries: [
			{ role: "user", text: "fix the thing" },
			{ role: "assistant", text: "done" },
		],
		crashReports: [],
		...overrides,
	};
}

describe("applyTitlePrefix", () => {
	it("prepends the prefix when missing", () => {
		expect(applyTitlePrefix("a bug", "[derp] ")).toBe("[derp] a bug");
	});

	it("does not double up an existing prefix", () => {
		expect(applyTitlePrefix("[derp] a bug", "[derp] ")).toBe("[derp] a bug");
	});

	it("collapses internal whitespace", () => {
		expect(applyTitlePrefix("  a   bug\nbar", "")).toBe("a bug bar");
	});

	it("clamps to 80 chars including prefix", () => {
		const long = "x".repeat(200);
		const r = applyTitlePrefix(long, "[derp] ");
		expect(r.length).toBeLessThanOrEqual(80);
		expect(r.endsWith("…")).toBe(true);
	});

	it("respects an empty prefix", () => {
		expect(applyTitlePrefix("a bug", "")).toBe("a bug");
	});
});

describe("validatePolishOutput", () => {
	it("accepts well-formed output", () => {
		const r = validatePolishOutput({ title: "x", body: "y" });
		expect(r).toEqual({ title: "x", body: "y" });
	});

	it("trims the title", () => {
		const r = validatePolishOutput({ title: "  x  ", body: "y" });
		expect(r?.title).toBe("x");
	});

	it("rejects missing fields", () => {
		expect(validatePolishOutput({ title: "x" })).toBeNull();
		expect(validatePolishOutput({ body: "y" })).toBeNull();
		expect(validatePolishOutput(null)).toBeNull();
		expect(validatePolishOutput("string")).toBeNull();
	});

	it("rejects empty title", () => {
		expect(validatePolishOutput({ title: "  ", body: "y" })).toBeNull();
	});

	it("rejects non-string fields", () => {
		expect(validatePolishOutput({ title: 1, body: "y" })).toBeNull();
		expect(validatePolishOutput({ title: "x", body: 2 })).toBeNull();
	});
});

describe("buildPolishTask", () => {
	it("includes the user text", () => {
		const t = buildPolishTask(makeCtx());
		expect(t).toContain("ghost text overlaps the input on iTerm");
	});

	it("includes the environment block", () => {
		const t = buildPolishTask(makeCtx());
		expect(t).toContain("github.com/vegardx/pi-extensions");
		expect(t).toContain("Filed against");
		expect(t).toContain("0.73.0");
	});

	it("does not include cwd-relative fields", () => {
		const t = buildPolishTask(makeCtx());
		expect(t).not.toContain("Origin (cwd)");
		expect(t).not.toContain("Branch");
		expect(t).not.toContain("HEAD");
		expect(t).not.toContain("Working tree");
	});

	it("includes the recent-entries section", () => {
		const t = buildPolishTask(makeCtx());
		expect(t).toContain("fix the thing");
		expect(t).toContain("done");
	});

	it("renders an empty session activity placeholder", () => {
		const t = buildPolishTask(makeCtx({ recentEntries: [] }));
		expect(t).toContain("(no recent session entries)");
	});

	it("requires a JSON-only response", () => {
		const t = buildPolishTask(makeCtx());
		expect(t).toContain("Return JSON only");
	});
});

describe("buildFallbackIssue", () => {
	it("uses the first line of user text as the title", () => {
		const ctx = makeCtx({
			userText: "ghost text overlaps\nlong follow-up details",
		});
		const r = buildFallbackIssue(ctx, "[derp] ");
		expect(r.title).toBe("[derp] ghost text overlaps");
	});

	it("includes the raw report verbatim", () => {
		const ctx = makeCtx({ userText: "exact words" });
		const r = buildFallbackIssue(ctx, "");
		expect(r.body).toContain("exact words");
	});

	it("notes that polish was skipped", () => {
		const r = buildFallbackIssue(makeCtx(), "");
		expect(r.body).toContain("polish step skipped");
	});

	it("does not include a working-tree section", () => {
		const r = buildFallbackIssue(makeCtx(), "");
		expect(r.body).not.toContain("## Working tree");
	});

	it("omits the recent-activity section when entries are empty", () => {
		const r = buildFallbackIssue(makeCtx({ recentEntries: [] }), "");
		expect(r.body).not.toContain("## Recent session activity");
	});
});

function makeCrashReport(
	over: Partial<CrashReportSummary> = {},
): CrashReportSummary {
	return {
		schemaVersion: 1,
		timestamp: "2026-05-16T17:30:00.000Z",
		origin: "uncaughtException",
		error: {
			name: "TypeError",
			message: "undefined is not a function",
			stack: "TypeError: undefined is not a function\n    at run (/x.js:1:1)",
		},
		state: {
			mode: "auto",
			stage: "executing",
			branch: "feat/x",
			planSlug: "p",
			activePhaseId: "ph",
		},
		session: { id: "sess-1", file: "~/.pi/agent/sess-1.jsonl" },
		recentEntries: [{ role: "user", text: "do thing" }],
		redactionHits: [],
		sourcePath: "/tmp/2026-05-16T17-30-00-sess-1.json",
		...over,
	};
}

describe("crash-report rendering", () => {
	it("buildPolishTask omits the section when no reports", () => {
		const t = buildPolishTask(makeCtx({ crashReports: [] }));
		expect(t).not.toContain("## Crash reports");
	});

	it("buildPolishTask includes a Crash reports section with verbatim instructions", () => {
		const t = buildPolishTask(makeCtx({ crashReports: [makeCrashReport()] }));
		expect(t).toContain("## Crash reports");
		expect(t).toContain("verbatim");
		expect(t).toContain("`TypeError`");
		expect(t).toContain("undefined is not a function");
		expect(t).toContain("`feat/x`");
		expect(t).toContain("`p`");
		expect(t).toContain("`ph`");
	});

	it("buildFallbackIssue includes the section when reports exist", () => {
		const r = buildFallbackIssue(
			makeCtx({ crashReports: [makeCrashReport()] }),
			"",
		);
		expect(r.body).toContain("## Crash reports");
		expect(r.body).toContain("undefined is not a function");
		expect(r.body).toContain("<details><summary>Stack</summary>");
	});

	it("buildFallbackIssue surfaces redactionHits when non-empty", () => {
		const r = buildFallbackIssue(
			makeCtx({
				crashReports: [makeCrashReport({ redactionHits: ["secret-token"] })],
			}),
			"",
		);
		expect(r.body).toContain("Redaction hits");
		expect(r.body).toContain("`secret-token`");
	});

	it("separates multiple reports with a horizontal rule", () => {
		const r = buildFallbackIssue(
			makeCtx({
				crashReports: [makeCrashReport(), makeCrashReport()],
			}),
			"",
		);
		expect((r.body.match(/\n---\n/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});
});
