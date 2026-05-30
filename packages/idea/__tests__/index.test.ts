import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
	GhRunner,
	IssueCreateOutcome,
} from "@vegardx/pi-extensions-shared/gh-issue.js";
import type { GitRunner } from "@vegardx/pi-extensions-shared/git-origin.js";
import type {
	PolishOutcome,
	polishReport as sharedPolish,
} from "@vegardx/pi-extensions-shared/polish-runner.js";
import { defaultResolvePolishModel, runIdea } from "../index.js";

interface NotifyCall {
	message: string;
	level: string;
}

interface FakeCtxOptions {
	model?: { provider: string; id: string } | null;
	cwd?: string;
	entries?: unknown[];
	sessionId?: string;
	sessionName?: string | null;
}

function fakeCtx(opts: FakeCtxOptions = {}): {
	ctx: ExtensionContext;
	notifies: NotifyCall[];
} {
	const notifies: NotifyCall[] = [];
	const model =
		opts.model === undefined
			? { provider: "anthropic", id: "claude-x" }
			: opts.model;
	const ctx = {
		cwd: opts.cwd ?? "/tmp/fake",
		model,
		hasUI: true,
		ui: {
			notify: (message: string, level: string) => {
				notifies.push({ message, level });
			},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
		sessionManager: {
			getEntries: () => opts.entries ?? [],
			getSessionId: () => opts.sessionId ?? "fake-session",
			getSessionFile: () => null,
			getSessionName: () => opts.sessionName ?? null,
			getBranch: () => [],
			getLeafId: () => null,
		},
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "test-key",
				headers: undefined,
			}),
		},
	} as unknown as ExtensionContext;
	return { ctx, notifies };
}

function fakeGitRunner(url: string | null): GitRunner {
	return () =>
		url === null
			? { status: 1, stdout: "", stderr: "" }
			: { status: 0, stdout: `${url}\n`, stderr: "" };
}

function fakePolish(outcome: PolishOutcome): typeof sharedPolish {
	return (async () => outcome) as typeof sharedPolish;
}

function fakeCreateIssue(outcome: IssueCreateOutcome): {
	fn: (
		input: Parameters<
			typeof import("@vegardx/pi-extensions-shared/gh-issue.js").createIssue
		>[0],
		runner?: GhRunner,
		pendingDir?: string,
	) => IssueCreateOutcome;
	calls: Array<
		Parameters<
			typeof import("@vegardx/pi-extensions-shared/gh-issue.js").createIssue
		>[0]
	>;
} {
	const calls: Array<
		Parameters<
			typeof import("@vegardx/pi-extensions-shared/gh-issue.js").createIssue
		>[0]
	> = [];
	const fn = (
		input: Parameters<
			typeof import("@vegardx/pi-extensions-shared/gh-issue.js").createIssue
		>[0],
	): IssueCreateOutcome => {
		calls.push(input);
		return outcome;
	};
	return { fn, calls };
}

let pendingDir: string;
const ORIGIN_URL = "git@github.com:acme/widgets.git";

beforeEach(() => {
	pendingDir = mkdtempSync(join(tmpdir(), "idea-idx-"));
});

afterEach(() => {
	rmSync(pendingDir, { recursive: true, force: true });
});

function pendingFiles(): string[] {
	return existsSync(pendingDir) ? readdirSync(pendingDir) : [];
}

describe("runIdea — happy path", () => {
	it("polishes, then files against cwd-origin, no pending file written", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: {
				title: "make submit button bigger",
				body: "## Summary\n\ndetails",
			},
		});
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/acme/widgets/issues/9",
		});

		await runIdea(ctx, "submit button is too small on narrow terminals", {
			polish,
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		expect(create.calls).toHaveLength(1);
		expect(create.calls[0]?.targetRepo).toBe("github.com/acme/widgets");
		expect(create.calls[0]?.host).toBe("github.com");
		expect(create.calls[0]?.draft.title).toBe("make submit button bigger");
		expect(create.calls[0]?.labels).toEqual([]);
		expect(notifies.at(-1)?.message).toContain(
			"https://github.com/acme/widgets/issues/9",
		);
		expect(pendingFiles()).toEqual([]);
	});
});

describe("runIdea — empty input", () => {
	it("notifies and does not call createIssue", async () => {
		const { ctx, notifies } = fakeCtx();
		const create = fakeCreateIssue({ ok: true, url: "x" });
		await runIdea(ctx, "   ", {
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});
		expect(create.calls).toEqual([]);
		expect(notifies[0]?.message).toContain("needs something to capture");
	});
});

describe("runIdea — no origin", () => {
	it("notifies and bails when cwd has no origin remote", async () => {
		const { ctx, notifies } = fakeCtx();
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });
		await runIdea(ctx, "improve the picker UX", {
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(null),
		});
		expect(create.calls).toEqual([]);
		expect(notifies[0]?.message).toContain("not inside a git repo");
		expect(pendingFiles()).toEqual([]);
	});

	it("notifies and bails when origin URL is unparseable", async () => {
		const { ctx, notifies } = fakeCtx();
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });
		await runIdea(ctx, "improve the picker UX", {
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner("not a url"),
		});
		expect(create.calls).toEqual([]);
		expect(notifies[0]?.message).toContain("not inside a git repo");
	});
});

describe("runIdea — input redaction (fail-closed)", () => {
	it("bails and stashes with polished content when polish succeeds", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: {
				title: "thing improved",
				body: "## Summary\n\npolished details",
			},
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runIdea(
			ctx,
			"add a flag, my token is ghp_AbCdEf1234567890ZzYy please ship",
			{
				polish,
				createIssue: create.fn,
				pendingDir,
				gitRunner: fakeGitRunner(ORIGIN_URL),
			},
		);

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("secret-token");
		expect(warn?.message).toContain("not filing (polished)");
		const files = pendingFiles();
		expect(files).toHaveLength(1);
		const first = files[0];
		if (!first) throw new Error("unreachable");
		const written = readFileSync(join(pendingDir, first), "utf8");
		expect(written).not.toContain("ghp_AbCdEf1234567890ZzYy");
		expect(written).toContain("polished details");
	});

	it("bails and stashes with raw fallback when polish fails in bail path", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: false,
			reason: "subagent-error",
			detail: "timeout",
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runIdea(
			ctx,
			"add a flag, my token is ghp_AbCdEf1234567890ZzYy please ship",
			{
				polish,
				createIssue: create.fn,
				pendingDir,
				gitRunner: fakeGitRunner(ORIGIN_URL),
			},
		);

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("not filing (raw)");
		const files = pendingFiles();
		const first = files[0];
		if (!first) throw new Error("unreachable");
		const written = readFileSync(join(pendingDir, first), "utf8");
		expect(written).not.toContain("ghp_AbCdEf1234567890ZzYy");
		expect(written).toContain("[REDACTED:secret-token]");
		expect(written).toContain("polish step skipped");
	});

	it("bails and stashes when a recent entry contains a token", async () => {
		const { ctx, notifies } = fakeCtx({
			entries: [
				{
					role: "user",
					text: "my token is ghp_AbCdEf1234567890ZzYy, brainstorm",
				},
			],
		});
		const polish = fakePolish({
			ok: true,
			draft: { title: "x", body: "y" },
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runIdea(ctx, "improve picker UX", {
			polish,
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("secret-token");
		expect(pendingFiles()).toHaveLength(1);
	});
});

describe("runIdea — output redaction (fail-closed)", () => {
	it("bails when polish output contains an internal host", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: {
				title: "improve picker",
				body: "## Summary\n\nSee https://wiki.corp.acme.com/x for context",
			},
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runIdea(ctx, "improve picker UX", {
			polish,
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("polish output");
		expect(warn?.message).toContain("internal-host");
		expect(pendingFiles()).toHaveLength(1);
	});
});

describe("runIdea — no model", () => {
	it("falls back to the deterministic template and still files", async () => {
		const { ctx, notifies } = fakeCtx({ model: null });
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/acme/widgets/issues/77",
		});

		await runIdea(ctx, "make picker keyboard-navigable", {
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		expect(create.calls).toHaveLength(1);
		expect(create.calls[0]?.draft.title).toBe("make picker keyboard-navigable");
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("no fast/active model");
		expect(notifies.at(-1)?.message).toContain("(raw template)");
	});
});

describe("runIdea — polish failure falls back", () => {
	it("uses the deterministic template when polish times out", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: false,
			reason: "subagent-error",
			detail: "timeout",
		});
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/acme/widgets/issues/8",
		});

		await runIdea(ctx, "make picker keyboard-navigable", {
			polish,
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		expect(create.calls).toHaveLength(1);
		expect(create.calls[0]?.draft.title).toBe("make picker keyboard-navigable");
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("polish failed");
		expect(notifies.at(-1)?.message).toContain("(raw template)");
	});
});

describe("runIdea — gh failures stash", () => {
	it("stashes when gh-missing", async () => {
		const { ctx, notifies } = fakeCtx({ model: null });
		const create = fakeCreateIssue({
			ok: false,
			reason: "gh-missing",
			detail: "gh did not run",
			pendingPath: "/will-be-overwritten",
		});

		await runIdea(ctx, "improve dialog", {
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		const warns = notifies.filter((n) => n.level === "warning");
		expect(warns.at(-1)?.message).toContain("gh did not run");
	});

	it("notifies labels-rejected without scary recovery hint", async () => {
		const { ctx, notifies } = fakeCtx({ model: null });
		const create = fakeCreateIssue({
			ok: false,
			reason: "labels-rejected",
			detail:
				"labels not found on repo (xyz); filed issue without labels: https://example/1",
		});

		await runIdea(ctx, "improve dialog", {
			createIssue: create.fn,
			pendingDir,
			gitRunner: fakeGitRunner(ORIGIN_URL),
		});

		const warns = notifies.filter((n) => n.level === "warning");
		const last = warns.at(-1)?.message ?? "";
		expect(last).toContain("labels not found on repo");
		expect(last).not.toContain("Saved note");
	});
});

describe("defaultResolvePolishModel", () => {
	it("returns provider/id from ctx.model when no configured override", async () => {
		const { ctx } = fakeCtx();
		const result = await defaultResolvePolishModel(ctx);
		expect(result).toEqual({ provider: "anthropic", id: "claude-x" });
	});

	it("returns null when ctx.model is null and no override configured", async () => {
		const { ctx } = fakeCtx({ model: null });
		const result = await defaultResolvePolishModel(ctx);
		expect(result).toBeNull();
	});
});
