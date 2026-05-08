import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	discoverHandovers,
	normalizeRemote,
	scoreHandover,
} from "../discover.js";
import { parseHandover } from "../frontmatter.js";

// ---------------------------------------------------------------------------
// parseHandover
// ---------------------------------------------------------------------------

describe("parseHandover", () => {
	it("parses valid frontmatter with all fields", () => {
		const content = [
			"---",
			'date: "2026-05-07"',
			'session_id: "019df8aa"',
			'repo: "git@github.com:vegardx/pi-extensions.git"',
			'branch: "feat/webhook-support"',
			'cwd: "/Users/vegardx/src/github.com/vegardx/pi-extensions"',
			"---",
			"",
			"## Session Handover",
			"Body content here.",
		].join("\n");

		const result = parseHandover(content);
		expect(result).not.toBeNull();
		expect(result?.meta.date).toBe("2026-05-07");
		expect(result?.meta.session_id).toBe("019df8aa");
		expect(result?.meta.repo).toBe("git@github.com:vegardx/pi-extensions.git");
		expect(result?.meta.branch).toBe("feat/webhook-support");
		expect(result?.body).toContain("## Session Handover");
	});

	it("parses frontmatter with unquoted values", () => {
		const content = [
			"---",
			"date: 2026-05-07",
			"session_id: 019df8aa",
			"branch: main",
			"---",
			"Body.",
		].join("\n");

		const result = parseHandover(content);
		expect(result).not.toBeNull();
		expect(result?.meta.date).toBe("2026-05-07");
		expect(result?.meta.session_id).toBe("019df8aa");
		expect(result?.meta.branch).toBe("main");
	});

	it("parses frontmatter with single-quoted values", () => {
		const content = [
			"---",
			"date: '2026-05-07'",
			"session_id: '019df8aa'",
			"---",
			"Body.",
		].join("\n");

		const result = parseHandover(content);
		expect(result).not.toBeNull();
		expect(result?.meta.date).toBe("2026-05-07");
	});

	it("returns null when no frontmatter present", () => {
		const content = "## Session Handover\nJust a body.";
		expect(parseHandover(content)).toBeNull();
	});

	it("returns null when closing --- is missing", () => {
		const content = "---\ndate: 2026-05-07\nsession_id: abc\nNo closing.";
		expect(parseHandover(content)).toBeNull();
	});

	it("returns null when date is missing", () => {
		const content = ["---", "session_id: abc12345", "---", "Body."].join("\n");
		expect(parseHandover(content)).toBeNull();
	});

	it("returns null when session_id is missing", () => {
		const content = ["---", "date: 2026-05-07", "---", "Body."].join("\n");
		expect(parseHandover(content)).toBeNull();
	});

	it("optional fields are undefined when absent", () => {
		const content = [
			"---",
			"date: 2026-05-07",
			"session_id: abc12345",
			"---",
			"Body.",
		].join("\n");

		const result = parseHandover(content);
		expect(result?.meta.repo).toBeUndefined();
		expect(result?.meta.branch).toBeUndefined();
		expect(result?.meta.cwd).toBeUndefined();
	});

	it("handles leading whitespace before frontmatter", () => {
		const content = [
			"  ---",
			"date: 2026-05-07",
			"session_id: abc12345",
			"---",
			"Body.",
		].join("\n");

		const result = parseHandover(content);
		expect(result).not.toBeNull();
		expect(result?.meta.date).toBe("2026-05-07");
	});
});

// ---------------------------------------------------------------------------
// normalizeRemote
// ---------------------------------------------------------------------------

describe("normalizeRemote", () => {
	it("normalizes SSH URLs", () => {
		expect(normalizeRemote("git@github.com:vegardx/pi-extensions.git")).toBe(
			"github.com/vegardx/pi-extensions",
		);
	});

	it("normalizes HTTPS URLs", () => {
		expect(
			normalizeRemote("https://github.com/vegardx/pi-extensions.git"),
		).toBe("github.com/vegardx/pi-extensions");
	});

	it("normalizes HTTPS URLs without .git suffix", () => {
		expect(normalizeRemote("https://github.com/vegardx/pi-extensions")).toBe(
			"github.com/vegardx/pi-extensions",
		);
	});

	it("normalizes URLs with access tokens", () => {
		expect(
			normalizeRemote(
				"https://x-access-token:ghs_abc@github.com/vegardx/pi-extensions.git",
			),
		).toBe("github.com/vegardx/pi-extensions");
	});

	it("is case-insensitive", () => {
		expect(normalizeRemote("git@GitHub.com:Vegardx/Pi-Extensions.git")).toBe(
			"github.com/vegardx/pi-extensions",
		);
	});

	it("handles different SSH hosts", () => {
		expect(normalizeRemote("git@dnb.ghe.com:github/kindling.git")).toBe(
			"dnb.ghe.com/github/kindling",
		);
	});
});

// ---------------------------------------------------------------------------
// scoreHandover
// ---------------------------------------------------------------------------

describe("scoreHandover", () => {
	const today = "2026-05-08";

	it("gives +100 for exact branch match", () => {
		const score = scoreHandover(
			{ date: "2026-01-01", session_id: "x", branch: "feat/foo" },
			"feat/foo",
			null,
			today,
		);
		expect(score).toBeGreaterThanOrEqual(100);
	});

	it("gives +50 for matching repo", () => {
		const score = scoreHandover(
			{
				date: "2026-01-01",
				session_id: "x",
				repo: "git@github.com:vegardx/pi-extensions.git",
			},
			null,
			"https://github.com/vegardx/pi-extensions",
			today,
		);
		expect(score).toBeGreaterThanOrEqual(50);
	});

	it("gives recency bonus for same-day handovers", () => {
		const score = scoreHandover(
			{ date: "2026-05-08", session_id: "x" },
			null,
			null,
			today,
		);
		expect(score).toBe(10);
	});

	it("gives decreasing recency for older handovers", () => {
		const score7 = scoreHandover(
			{ date: "2026-05-01", session_id: "x" },
			null,
			null,
			today,
		);
		const score1 = scoreHandover(
			{ date: "2026-05-07", session_id: "x" },
			null,
			null,
			today,
		);
		expect(score1).toBeGreaterThan(score7);
	});

	it("gives 0 recency for handovers older than 10 days", () => {
		const score = scoreHandover(
			{ date: "2026-04-01", session_id: "x" },
			null,
			null,
			today,
		);
		expect(score).toBe(0);
	});

	it("scores are additive: branch + repo + recency", () => {
		const score = scoreHandover(
			{
				date: "2026-05-08",
				session_id: "x",
				branch: "feat/foo",
				repo: "git@github.com:vegardx/pi-extensions.git",
			},
			"feat/foo",
			"https://github.com/vegardx/pi-extensions",
			today,
		);
		// 100 + 50 + 10 = 160
		expect(score).toBe(160);
	});

	it("no match gives 0 (old date, no branch, no repo)", () => {
		const score = scoreHandover(
			{ date: "2025-01-01", session_id: "x" },
			"feat/other",
			"https://other.com/repo",
			today,
		);
		expect(score).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// discoverHandovers — filesystem integration
// ---------------------------------------------------------------------------

describe("discoverHandovers", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "discover-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty when directory does not exist", () => {
		const result = discoverHandovers("/tmp/no-such-dir", {
			configuredDir: "/tmp/no-such-dir/handovers",
		});
		expect(result).toEqual([]);
	});

	it("returns empty when directory has no handover files", () => {
		writeFileSync(join(tmp, "readme.md"), "not a handover");
		const result = discoverHandovers("/tmp", { configuredDir: tmp });
		expect(result).toEqual([]);
	});

	it("ignores files without valid frontmatter", () => {
		writeFileSync(
			join(tmp, "handover-2026-05-07-abc12345.md"),
			"No frontmatter here.",
		);
		const result = discoverHandovers("/tmp", { configuredDir: tmp });
		expect(result).toEqual([]);
	});

	it("discovers and parses valid handover files", () => {
		const content = [
			"---",
			"date: 2026-05-07",
			"session_id: abc12345",
			"branch: main",
			"---",
			"## Session Handover",
			"Body.",
		].join("\n");
		writeFileSync(join(tmp, "handover-2026-05-07-abc12345.md"), content);

		const result = discoverHandovers("/tmp", { configuredDir: tmp });
		expect(result).toHaveLength(1);
		expect(result[0].meta.date).toBe("2026-05-07");
		expect(result[0].meta.branch).toBe("main");
	});

	it("sorts by score descending", () => {
		const highScore = [
			"---",
			"date: 2026-05-08",
			"session_id: high0000",
			"repo: git@github.com:vegardx/pi-extensions.git",
			"---",
			"High score.",
		].join("\n");
		const lowScore = [
			"---",
			"date: 2025-01-01",
			"session_id: low00000",
			"---",
			"Low score.",
		].join("\n");
		writeFileSync(join(tmp, "handover-2026-05-08-high0000.md"), highScore);
		writeFileSync(join(tmp, "handover-2025-01-01-low00000.md"), lowScore);

		// discoverHandovers uses git to get branch/remote from cwd;
		// /tmp isn't a git repo so those will be null. Score difference
		// comes from recency only.
		const result = discoverHandovers("/tmp", { configuredDir: tmp });
		expect(result.length).toBe(2);
		expect(result[0].meta.session_id).toBe("high0000");
	});
});
