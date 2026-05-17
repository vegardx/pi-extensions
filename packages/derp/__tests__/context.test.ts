import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	gatherDerpContext,
	parseOriginUrl,
	readPiVersion,
	summariseEntries,
} from "../context.js";

// ---------------------------------------------------------------------------
// parseOriginUrl
// ---------------------------------------------------------------------------

describe("parseOriginUrl", () => {
	it("parses SSH github.com URLs", () => {
		const r = parseOriginUrl("git@github.com:vegardx/pi-extensions.git");
		expect(r).toEqual({
			host: "github.com",
			owner: "vegardx",
			repo: "pi-extensions",
			slug: "github.com/vegardx/pi-extensions",
		});
	});

	it("parses SSH GHE URLs", () => {
		const r = parseOriginUrl("git@dnb.ghe.com:org/some-repo.git");
		expect(r?.host).toBe("dnb.ghe.com");
		expect(r?.slug).toBe("dnb.ghe.com/org/some-repo");
	});

	it("parses SSH URLs without the .git suffix", () => {
		const r = parseOriginUrl("git@github.com:owner/repo");
		expect(r?.repo).toBe("repo");
	});

	it("parses HTTPS github.com URLs", () => {
		const r = parseOriginUrl("https://github.com/owner/repo.git");
		expect(r?.host).toBe("github.com");
		expect(r?.owner).toBe("owner");
		expect(r?.repo).toBe("repo");
	});

	it("parses HTTPS URLs without .git", () => {
		const r = parseOriginUrl("https://github.com/owner/repo");
		expect(r?.repo).toBe("repo");
	});

	it("parses HTTPS URLs with embedded credentials", () => {
		const r = parseOriginUrl("https://user:token@dnb.ghe.com/org/repo.git");
		expect(r?.host).toBe("dnb.ghe.com");
	});

	it("parses ssh:// URLs", () => {
		const r = parseOriginUrl("ssh://git@github.com/owner/repo.git");
		expect(r?.host).toBe("github.com");
		expect(r?.repo).toBe("repo");
	});

	it("rejects empty strings", () => {
		expect(parseOriginUrl("")).toBeNull();
		expect(parseOriginUrl("   ")).toBeNull();
	});

	it("rejects garbage input", () => {
		expect(parseOriginUrl("not a url")).toBeNull();
		expect(parseOriginUrl("https://")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// summariseEntries
// ---------------------------------------------------------------------------

describe("summariseEntries", () => {
	it("returns the last N entries", () => {
		const entries = [
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "c" },
		];
		const r = summariseEntries(entries, 2);
		expect(r).toHaveLength(2);
		expect(r[0]?.text).toBe("b");
		expect(r[1]?.text).toBe("c");
	});

	it("normalises common role names", () => {
		const entries = [
			{ role: "human", content: "x" },
			{ role: "model", content: "y" },
			{ type: "tool_use", content: "z" },
		];
		const r = summariseEntries(entries, 5);
		expect(r.map((e) => e.role)).toEqual(["user", "assistant", "tool"]);
	});

	it("flattens structured content blocks", () => {
		const entries = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
			},
		];
		const r = summariseEntries(entries, 5);
		expect(r[0]?.text).toBe("hello\nworld");
	});

	it("truncates very long entries", () => {
		const long = "x".repeat(5000);
		const entries = [{ role: "assistant", content: long }];
		const r = summariseEntries(entries, 1);
		expect(r[0]?.text.length).toBeLessThan(long.length);
		expect(r[0]?.text).toContain("…[truncated");
	});

	it("returns [] for count <= 0", () => {
		expect(summariseEntries([{ role: "user", content: "a" }], 0)).toEqual([]);
	});

	it("skips entries with no readable text", () => {
		const entries = [{ role: "user" }, { role: "assistant", content: "ok" }];
		const r = summariseEntries(entries, 5);
		expect(r).toHaveLength(1);
		expect(r[0]?.text).toBe("ok");
	});
});

// ---------------------------------------------------------------------------
// readPiVersion
// ---------------------------------------------------------------------------

describe("readPiVersion", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "derp-ver-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds the package one level up", () => {
		const pkgDir = join(
			dir,
			"node_modules",
			"@mariozechner",
			"pi-coding-agent",
		);
		execFileSync("mkdir", ["-p", pkgDir]);
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ version: "1.2.3" }),
		);
		expect(readPiVersion(dir)).toBe("1.2.3");
	});

	it("returns null when the package is missing", () => {
		expect(readPiVersion(dir)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// gatherDerpContext — integration with a real temp git repo
// ---------------------------------------------------------------------------

describe("gatherDerpContext", () => {
	let repo: string;

	function git(...args: string[]): void {
		execFileSync("git", args, { cwd: repo, stdio: "ignore" });
	}

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "derp-repo-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		git("remote", "add", "origin", "git@github.com:vegardx/pi-extensions.git");
		writeFileSync(join(repo, "README.md"), "hello\n");
		git("add", ".");
		git("commit", "-q", "-m", "initial");
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("bails on empty input", () => {
		const r = gatherDerpContext({
			cwd: repo,
			userText: "   ",
			sessionId: "s1",
			entries: [],
			recentEntryCount: 0,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("empty-input");
	});

	it("returns full context for a normal repo", () => {
		const r = gatherDerpContext({
			cwd: repo,
			userText: "  ghost text overlaps input on iTerm  ",
			sessionId: "abcdef1234",
			sessionName: "test session",
			entries: [
				{ role: "user", content: "go" },
				{ role: "assistant", content: "ok" },
			],
			recentEntryCount: 2,
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.ctx.userText).toBe("ghost text overlaps input on iTerm");
		expect(r.ctx.recentEntries).toHaveLength(2);
		expect(r.ctx.sessionId).toBe("abcdef1234");
		expect(r.ctx.sessionName).toBe("test session");
		expect(r.ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(r.ctx.crashReports).toEqual([]);
	});

	it("attaches crash reports tagged with the session id", () => {
		const crashDir = mkdtempSync(join(tmpdir(), "derp-crash-ctx-"));
		try {
			writeFileSync(
				join(crashDir, "2026-05-16T17-30-00-sess-9.json"),
				JSON.stringify({
					schemaVersion: 1,
					timestamp: "2026-05-16T17:30:00.000Z",
					origin: "uncaughtException",
					error: { name: "Error", message: "boom", stack: null },
					state: {
						mode: "auto",
						stage: "executing",
						branch: null,
						planSlug: null,
						activePhaseId: null,
					},
					session: { id: "sess-9", file: null },
					recentEntries: [],
					redactionHits: [],
				}),
			);
			const r = gatherDerpContext({
				cwd: repo,
				userText: "thing crashed",
				sessionId: "sess-9",
				entries: [],
				recentEntryCount: 0,
				crashReportsDir: crashDir,
			});
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.ctx.crashReports).toHaveLength(1);
			expect(r.ctx.crashReports[0]?.error.message).toBe("boom");
		} finally {
			rmSync(crashDir, { recursive: true, force: true });
		}
	});
});
