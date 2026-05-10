import type { DerpContext } from "../context.js";
import {
	applyTitlePrefix,
	buildFallbackIssue,
	buildPolishTask,
	validatePolishOutput,
} from "../template.js";

function makeCtx(overrides: Partial<DerpContext> = {}): DerpContext {
	return {
		userText: "ghost text overlaps the input on iTerm",
		origin: {
			host: "github.com",
			owner: "vegardx",
			repo: "pi-extensions",
			slug: "github.com/vegardx/pi-extensions",
		},
		branch: "feat/foo",
		headShort: "abc1234",
		statusShort: "M packages/foo/index.ts",
		cwd: "/tmp/repo",
		date: "2026-05-10",
		sessionId: "session-abc",
		sessionFile: "/tmp/sess.jsonl",
		sessionName: "test session",
		piVersion: "0.73.0",
		recentEntries: [
			{ role: "user", text: "fix the thing" },
			{ role: "assistant", text: "done" },
		],
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
		expect(t).toContain("feat/foo");
		expect(t).toContain("abc1234");
		expect(t).toContain("0.73.0");
	});

	it("omits the origin row when origin is null", () => {
		const t = buildPolishTask(makeCtx({ origin: null }));
		expect(t).toContain("Filed against");
		expect(t).not.toContain("Origin (cwd)");
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

	it("omits the working-tree section when status is empty", () => {
		const r = buildFallbackIssue(makeCtx({ statusShort: "" }), "");
		expect(r.body).not.toContain("## Working tree");
	});

	it("omits the recent-activity section when entries are empty", () => {
		const r = buildFallbackIssue(makeCtx({ recentEntries: [] }), "");
		expect(r.body).not.toContain("## Recent session activity");
	});
});
