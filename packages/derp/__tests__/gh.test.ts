import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildIssueArgv,
	createIssue,
	type GhRunner,
	isAuthError,
	isUnknownLabelError,
	parseIssueUrl,
	pendingFilePath,
	writePendingReport,
} from "../gh.js";
import type { IssueDraft } from "../template.js";

function fakeGh(
	responses: Array<{ status: number | null; stdout?: string; stderr?: string }>,
): { runner: GhRunner; calls: Array<{ argv: string[]; stdin: string }> } {
	const calls: Array<{ argv: string[]; stdin: string }> = [];
	let i = 0;
	const runner: GhRunner = (argv, stdin, _cwd) => {
		calls.push({ argv: [...argv], stdin });
		const r = responses[i++] ?? { status: 1, stderr: "no more responses" };
		return {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
		};
	};
	return { runner, calls };
}

function makeDraft(): IssueDraft {
	return { title: "[derp] something broke", body: "details here" };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildIssueArgv", () => {
	it("includes -R, title, and body-file flags", () => {
		const r = buildIssueArgv({
			title: "a bug",
			labels: [],
			targetRepo: "github.com/vegardx/pi-extensions",
		});
		expect(r).toEqual([
			"issue",
			"create",
			"-R",
			"github.com/vegardx/pi-extensions",
			"--title",
			"a bug",
			"--body-file",
			"-",
		]);
	});

	it("appends one --label per label", () => {
		const r = buildIssueArgv({
			title: "x",
			labels: ["bug", "harness"],
			targetRepo: "github.com/vegardx/pi-extensions",
		});
		expect(r.filter((a) => a === "--label")).toHaveLength(2);
		expect(r).toContain("bug");
		expect(r).toContain("harness");
	});

	it("ignores empty labels", () => {
		const r = buildIssueArgv({
			title: "x",
			labels: ["", "bug"],
			targetRepo: "github.com/vegardx/pi-extensions",
		});
		expect(r.filter((a) => a === "--label")).toHaveLength(1);
	});
});

describe("parseIssueUrl", () => {
	it("returns the URL on the last line", () => {
		const out = "Creating issue\n\nhttps://github.com/owner/repo/issues/42\n";
		expect(parseIssueUrl(out)).toBe("https://github.com/owner/repo/issues/42");
	});

	it("returns null when no URL is present", () => {
		expect(parseIssueUrl("nope")).toBeNull();
		expect(parseIssueUrl("")).toBeNull();
	});

	it("ignores trailing blank lines", () => {
		const out = "https://x.example/x\n\n\n";
		expect(parseIssueUrl(out)).toBe("https://x.example/x");
	});
});

describe("error detection", () => {
	it("flags label-not-found errors", () => {
		expect(isUnknownLabelError("could not add label: 'foo' not found")).toBe(
			true,
		);
		expect(isUnknownLabelError("network error")).toBe(false);
	});

	it("flags auth errors", () => {
		expect(isAuthError("error: gh auth login required")).toBe(true);
		expect(isAuthError("not logged into github.com")).toBe(true);
		expect(isAuthError("issue created")).toBe(false);
	});
});

describe("pendingFilePath", () => {
	it("uses an iso timestamp and host", () => {
		const path = pendingFilePath({
			host: "github.com",
			at: new Date("2026-05-10T12:34:56.789Z"),
			dir: "/tmp/x",
		});
		expect(path).toBe("/tmp/x/2026-05-10T12-34-56-789Z-github.com.md");
	});

	it("sanitises hostnames", () => {
		const path = pendingFilePath({
			host: "weird/host:1",
			at: new Date("2026-01-01T00:00:00Z"),
			dir: "/tmp/x",
		});
		expect(path).not.toContain("/host");
		expect(path).toContain("weird_host_1");
	});
});

// ---------------------------------------------------------------------------
// createIssue
// ---------------------------------------------------------------------------

describe("createIssue", () => {
	let pendingDir: string;

	beforeEach(() => {
		pendingDir = mkdtempSync(join(tmpdir(), "derp-pending-"));
	});

	afterEach(() => {
		rmSync(pendingDir, { recursive: true, force: true });
	});

	it("returns the URL on success", () => {
		const { runner, calls } = fakeGh([
			{ status: 0, stdout: "https://github.com/o/r/issues/1\n" },
		]);
		const r = createIssue(
			{
				draft: makeDraft(),
				labels: ["bug"],
				cwd: ".",
				host: "github.com",
				targetRepo: "github.com/vegardx/pi-extensions",
			},
			runner,
			pendingDir,
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.url).toBe("https://github.com/o/r/issues/1");
		expect(calls[0]?.argv).toContain("--label");
		expect(calls[0]?.argv).toContain("-R");
		expect(calls[0]?.argv).toContain("github.com/vegardx/pi-extensions");
		expect(calls[0]?.stdin).toBe("details here");
	});

	it("retries without labels on label-not-found and reports labels-rejected", () => {
		const { runner, calls } = fakeGh([
			{ status: 1, stderr: "could not add label: 'bug' not found" },
			{ status: 0, stdout: "https://github.com/o/r/issues/2\n" },
		]);
		const r = createIssue(
			{
				draft: makeDraft(),
				labels: ["bug"],
				cwd: ".",
				host: "github.com",
				targetRepo: "github.com/vegardx/pi-extensions",
			},
			runner,
			pendingDir,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("labels-rejected");
			expect(r.detail).toContain("issues/2");
		}
		expect(calls).toHaveLength(2);
		expect(calls[1]?.argv).not.toContain("--label");
	});

	it("stashes a pending file on auth failure", () => {
		const { runner } = fakeGh([
			{ status: 1, stderr: "error: not logged into github.com" },
		]);
		const r = createIssue(
			{
				draft: makeDraft(),
				labels: [],
				cwd: ".",
				host: "github.com",
				targetRepo: "github.com/vegardx/pi-extensions",
			},
			runner,
			pendingDir,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("auth");
			expect(r.pendingPath).toBeTruthy();
			if (!r.pendingPath) throw new Error("unreachable");
			const written = readFileSync(r.pendingPath, "utf8");
			expect(written).toContain("[derp] something broke");
			expect(written).toContain("details here");
		}
	});

	it("reports gh-missing when spawn returns null status", () => {
		const { runner } = fakeGh([{ status: null, stderr: "ENOENT" }]);
		const r = createIssue(
			{
				draft: makeDraft(),
				labels: [],
				cwd: ".",
				host: "github.com",
				targetRepo: "github.com/vegardx/pi-extensions",
			},
			runner,
			pendingDir,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("gh-missing");
			expect(r.pendingPath).toBeTruthy();
		}
	});

	it("reports gh-failed for generic non-zero exits", () => {
		const { runner } = fakeGh([{ status: 1, stderr: "rate limited" }]);
		const r = createIssue(
			{
				draft: makeDraft(),
				labels: [],
				cwd: ".",
				host: "github.com",
				targetRepo: "github.com/vegardx/pi-extensions",
			},
			runner,
			pendingDir,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reason).toBe("gh-failed");
			expect(r.detail).toContain("rate limited");
			expect(r.pendingPath).toBeTruthy();
		}
	});

	it("treats a missing URL on stdout as a soft failure", () => {
		const { runner } = fakeGh([{ status: 0, stdout: "weird success no url" }]);
		const r = createIssue(
			{
				draft: makeDraft(),
				labels: [],
				cwd: ".",
				host: "github.com",
				targetRepo: "github.com/vegardx/pi-extensions",
			},
			runner,
			pendingDir,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe("no-url-in-output");
	});
});

describe("writePendingReport", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "derp-write-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes title as a markdown header followed by body", () => {
		const path = writePendingReport(
			{ title: "X", body: "Y" },
			"github.com",
			dir,
		);
		expect(readFileSync(path, "utf8")).toBe("# X\n\nY\n");
	});
});
