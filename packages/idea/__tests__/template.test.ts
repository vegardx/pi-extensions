import type { IdeaContext } from "../context.js";
import {
	applyTitlePrefix,
	buildFallbackIssue,
	buildPolishTask,
} from "../template.js";

function fixture(overrides: Partial<IdeaContext> = {}): IdeaContext {
	return {
		userText: "make picker keyboard-navigable",
		date: "2026-05-16",
		sessionId: "session-1",
		sessionName: null,
		piVersion: "0.42.0",
		recentEntries: [],
		origin: {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			slug: "github.com/acme/widgets",
		},
		...overrides,
	};
}

describe("applyTitlePrefix", () => {
	it("adds prefix when missing", () => {
		expect(applyTitlePrefix("make picker bigger", "[idea] ")).toBe(
			"[idea] make picker bigger",
		);
	});

	it("does not double-add prefix", () => {
		expect(applyTitlePrefix("[idea] already prefixed", "[idea] ")).toBe(
			"[idea] already prefixed",
		);
	});

	it("normalises whitespace", () => {
		expect(applyTitlePrefix("  make   picker   bigger  ", "[idea] ")).toBe(
			"[idea] make picker bigger",
		);
	});

	it("clamps to 80 chars with ellipsis", () => {
		const long = "x".repeat(120);
		const r = applyTitlePrefix(long, "[idea] ");
		expect(r.length).toBe(80);
		expect(r.endsWith("…")).toBe(true);
	});

	it("works with empty prefix", () => {
		expect(applyTitlePrefix("plain title", "")).toBe("plain title");
	});
});

describe("buildPolishTask", () => {
	it("includes user text, environment, session ref, and JSON contract", () => {
		const task = buildPolishTask(fixture());
		expect(task).toContain("make picker keyboard-navigable");
		expect(task).toContain("github.com/acme/widgets");
		expect(task).toContain("0.42.0");
		expect(task).toContain("session-1");
		expect(task).toContain("Return JSON only");
	});

	it("notes empty session activity grammatically", () => {
		const task = buildPolishTask(fixture({ recentEntries: [] }));
		expect(task).toContain("_(no recent session entries)_");
	});

	it("renders recent entries as fenced blocks", () => {
		const task = buildPolishTask(
			fixture({
				recentEntries: [
					{ role: "user", text: "I want X" },
					{ role: "assistant", text: "Y is the issue" },
				],
			}),
		);
		expect(task).toContain("**user:**");
		expect(task).toContain("I want X");
		expect(task).toContain("**assistant:**");
		expect(task).toContain("Y is the issue");
	});

	it("includes session name when present", () => {
		const task = buildPolishTask(fixture({ sessionName: "implementing #163" }));
		expect(task).toContain("implementing #163");
	});
});

describe("buildFallbackIssue", () => {
	it("uses the first line of userText as the title", () => {
		const draft = buildFallbackIssue(
			fixture({ userText: "first line\nmore detail\nstill more" }),
			"[idea] ",
		);
		expect(draft.title).toBe("[idea] first line");
		expect(draft.body).toContain("first line");
		expect(draft.body).toContain("more detail");
	});

	it("flags it as a polish-skipped raw note", () => {
		const draft = buildFallbackIssue(fixture(), "[idea] ");
		expect(draft.body).toContain("polish step skipped");
	});

	it("includes Environment + Session reference sections", () => {
		const draft = buildFallbackIssue(
			fixture({ sessionName: "implementing #163" }),
			"[idea] ",
		);
		expect(draft.body).toContain("## Environment");
		expect(draft.body).toContain("github.com/acme/widgets");
		expect(draft.body).toContain("## Session reference");
		expect(draft.body).toContain("implementing #163");
	});

	it("omits Recent activity section when there are no entries", () => {
		const draft = buildFallbackIssue(fixture({ recentEntries: [] }), "");
		expect(draft.body).not.toContain("## Recent session activity");
	});

	it("includes Recent activity section when there are entries", () => {
		const draft = buildFallbackIssue(
			fixture({
				recentEntries: [{ role: "user", text: "context here" }],
			}),
			"",
		);
		expect(draft.body).toContain("## Recent session activity");
		expect(draft.body).toContain("context here");
	});
});
