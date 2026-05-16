import type { GitRunner } from "@vegardx/pi-extensions-shared/git-origin.js";
import {
	gatherIdeaContext,
	readPiVersion,
	summariseEntries,
} from "../context.js";

const SSH_ORIGIN = "git@github.com:acme/widgets.git";

const okGit: GitRunner = () => ({
	status: 0,
	stdout: `${SSH_ORIGIN}\n`,
	stderr: "",
});
const failGit: GitRunner = () => ({ status: 1, stdout: "", stderr: "" });

describe("summariseEntries", () => {
	it("returns empty for empty input or zero count", () => {
		expect(summariseEntries([], 6)).toEqual([]);
		expect(summariseEntries([{ role: "user", text: "x" }], 0)).toEqual([]);
	});

	it("normalises roles", () => {
		const r = summariseEntries(
			[
				{ role: "user", text: "u" },
				{ role: "assistant", text: "a" },
				{ role: "tool_use", text: "t" },
				{ role: "system", text: "s" },
			],
			6,
		);
		expect(r.map((e) => e.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"other",
		]);
	});

	it("reads array-shaped content", () => {
		const r = summariseEntries(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "text", text: "world" },
					],
				},
			],
			6,
		);
		expect(r[0]?.text).toBe("hello\nworld");
	});

	it("truncates long entries", () => {
		const long = "x".repeat(2000);
		const r = summariseEntries([{ role: "user", text: long }], 6);
		expect(r[0]?.text.length).toBeLessThan(long.length);
		expect(r[0]?.text).toContain("[truncated");
	});

	it("only takes the tail", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			role: "user",
			text: `m${i}`,
		}));
		const r = summariseEntries(entries, 3);
		expect(r.map((e) => e.text)).toEqual(["m7", "m8", "m9"]);
	});
});

describe("readPiVersion", () => {
	it("returns null when package not found", () => {
		expect(readPiVersion("/nonexistent/path")).toBeNull();
	});
});

describe("gatherIdeaContext", () => {
	it("returns ok with parsed origin and trimmed userText", () => {
		const r = gatherIdeaContext({
			cwd: "/repo",
			userText: "  improve picker UX  ",
			sessionId: "session-1",
			entries: [],
			recentEntryCount: 6,
			gitRunner: okGit,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.ctx.userText).toBe("improve picker UX");
		expect(r.ctx.origin.slug).toBe("github.com/acme/widgets");
		expect(r.ctx.origin.host).toBe("github.com");
		expect(r.ctx.sessionId).toBe("session-1");
		expect(r.ctx.sessionName).toBeNull();
		expect(r.ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("bails on empty input", () => {
		const r = gatherIdeaContext({
			cwd: "/repo",
			userText: "  \n  ",
			sessionId: "x",
			entries: [],
			recentEntryCount: 6,
			gitRunner: okGit,
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.reason).toBe("empty-input");
	});

	it("bails when cwd has no origin", () => {
		const r = gatherIdeaContext({
			cwd: "/repo",
			userText: "improve dialog",
			sessionId: "x",
			entries: [],
			recentEntryCount: 6,
			gitRunner: failGit,
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.reason).toBe("no-origin");
		expect(r.detail).toContain("not inside a git repo");
	});

	it("bails when origin URL is unparseable", () => {
		const r = gatherIdeaContext({
			cwd: "/repo",
			userText: "improve",
			sessionId: "x",
			entries: [],
			recentEntryCount: 6,
			gitRunner: () => ({ status: 0, stdout: "garbage url\n", stderr: "" }),
		});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.reason).toBe("no-origin");
	});

	it("threads sessionName, recentEntries through", () => {
		const r = gatherIdeaContext({
			cwd: "/repo",
			userText: "x",
			sessionId: "s",
			sessionName: "implementing #161",
			entries: [
				{ role: "user", text: "first" },
				{ role: "assistant", text: "second" },
			],
			recentEntryCount: 2,
			gitRunner: okGit,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.ctx.sessionName).toBe("implementing #161");
		expect(r.ctx.recentEntries.map((e) => e.text)).toEqual(["first", "second"]);
	});
});
