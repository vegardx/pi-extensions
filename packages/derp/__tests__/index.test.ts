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
import type { GhRunner, IssueCreateOutcome } from "../gh.js";
import { runDerp } from "../index.js";
import type { PolishOutcome } from "../polish.js";

interface NotifyCall {
	message: string;
	level: string;
}

interface FakeCtxOptions {
	model?: { provider: string; id: string } | null;
	cwd?: string;
	entries?: unknown[];
	sessionId?: string;
}

function fakeCtx(opts: FakeCtxOptions = {}): {
	ctx: ExtensionContext;
	notifies: NotifyCall[];
} {
	const notifies: NotifyCall[] = [];
	const ctx = {
		cwd: opts.cwd ?? "/tmp/fake",
		model:
			opts.model === undefined
				? { provider: "anthropic", id: "claude-x" }
				: opts.model,
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
			getSessionName: () => null,
			getBranch: () => [],
			getLeafId: () => null,
		},
		modelRegistry: {},
	} as unknown as ExtensionContext;
	return { ctx, notifies };
}

function fakePolish(
	outcome: PolishOutcome,
): typeof import("../polish.js").polishReport {
	return (async () => outcome) as typeof import("../polish.js").polishReport;
}

function fakeCreateIssue(outcome: IssueCreateOutcome): {
	fn: (
		input: Parameters<typeof import("../gh.js").createIssue>[0],
		runner?: GhRunner,
		pendingDir?: string,
	) => IssueCreateOutcome;
	calls: Array<Parameters<typeof import("../gh.js").createIssue>[0]>;
} {
	const calls: Array<Parameters<typeof import("../gh.js").createIssue>[0]> = [];
	const fn = (
		input: Parameters<typeof import("../gh.js").createIssue>[0],
	): IssueCreateOutcome => {
		calls.push(input);
		return outcome;
	};
	return { fn, calls };
}

let pendingDir: string;

beforeEach(() => {
	pendingDir = mkdtempSync(join(tmpdir(), "derp-idx-"));
});

afterEach(() => {
	rmSync(pendingDir, { recursive: true, force: true });
});

function pendingFiles(): string[] {
	return existsSync(pendingDir) ? readdirSync(pendingDir) : [];
}

describe("runDerp — happy path", () => {
	it("polishes, then files, no pending file written", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: { title: "thing broke", body: "## Summary\n\ndetails" },
		});
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/vegardx/pi-extensions/issues/9",
		});

		await runDerp(ctx, "the prompt-suggestion ghost text overlaps input", {
			polish,
			createIssue: create.fn,
			pendingDir,
		});

		expect(create.calls).toHaveLength(1);
		expect(create.calls[0]?.targetRepo).toBe(
			"github.com/vegardx/pi-extensions",
		);
		expect(create.calls[0]?.host).toBe("github.com");
		expect(create.calls[0]?.draft.title).toBe("[derp] thing broke");
		expect(notifies.at(-1)?.message).toContain(
			"https://github.com/vegardx/pi-extensions/issues/9",
		);
		expect(pendingFiles()).toEqual([]);
	});
});

describe("runDerp — empty input", () => {
	it("notifies and does not call createIssue", async () => {
		const { ctx, notifies } = fakeCtx();
		const create = fakeCreateIssue({ ok: true, url: "x" });
		await runDerp(ctx, "   ", { createIssue: create.fn, pendingDir });
		expect(create.calls).toEqual([]);
		expect(notifies[0]?.message).toContain("needs something to derp on");
	});
});

describe("runDerp — input redaction (fail-closed)", () => {
	it("bails and stashes when user text contains a token", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: { title: "x", body: "y" },
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runDerp(
			ctx,
			"this is broken, my token is ghp_AbCdEf1234567890ZzYy please debug",
			{ polish, createIssue: create.fn, pendingDir },
		);

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("secret-token");
		expect(warn?.message).toContain("not filing");
		const files = pendingFiles();
		expect(files).toHaveLength(1);
		const first = files[0];
		if (!first) throw new Error("unreachable");
		const written = readFileSync(join(pendingDir, first), "utf8");
		expect(written).not.toContain("ghp_AbCdEf1234567890ZzYy");
		expect(written).toContain("[REDACTED:secret-token]");
	});

	it("files successfully when cwd is an internal host path (no longer rendered)", async () => {
		const { ctx, notifies } = fakeCtx({
			cwd: "/Users/alice/src/dnb.ghe.com/org/repo",
		});
		const polish = fakePolish({
			ok: true,
			draft: { title: "thing broke", body: "## Summary\n\ndetails" },
		});
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/vegardx/pi-extensions/issues/42",
		});

		await runDerp(ctx, "thing broke", {
			polish,
			createIssue: create.fn,
			pendingDir,
		});

		expect(create.calls).toHaveLength(1);
		expect(notifies.at(-1)?.message).toContain(
			"https://github.com/vegardx/pi-extensions/issues/42",
		);
		expect(pendingFiles()).toEqual([]);
	});
});

describe("runDerp — output redaction (fail-closed)", () => {
	it("bails when polish output contains an internal host", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: {
				title: "thing broke",
				body: "## Summary\n\nSee https://wiki.corp.acme.com/x for context",
			},
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runDerp(ctx, "thing broke on iTerm", {
			polish,
			createIssue: create.fn,
			pendingDir,
		});

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("polish output");
		expect(warn?.message).toContain("internal-host");
		expect(pendingFiles()).toHaveLength(1);
	});
});

describe("runDerp — no model", () => {
	it("falls back to the deterministic template and still files", async () => {
		const { ctx, notifies } = fakeCtx({ model: null });
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/vegardx/pi-extensions/issues/77",
		});

		await runDerp(ctx, "ghost text overlaps input", {
			createIssue: create.fn,
			pendingDir,
		});

		expect(create.calls).toHaveLength(1);
		expect(create.calls[0]?.draft.title).toBe(
			"[derp] ghost text overlaps input",
		);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("no active session model");
		expect(notifies.at(-1)?.message).toContain("(raw template)");
	});
});

describe("runDerp — polish failure falls back", () => {
	it("uses the deterministic template when polish times out", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: false,
			reason: "subagent-error",
			detail: "timeout",
		});
		const create = fakeCreateIssue({
			ok: true,
			url: "https://github.com/vegardx/pi-extensions/issues/8",
		});

		await runDerp(ctx, "ghost text overlaps input", {
			polish,
			createIssue: create.fn,
			pendingDir,
		});

		expect(create.calls).toHaveLength(1);
		expect(create.calls[0]?.draft.title).toBe(
			"[derp] ghost text overlaps input",
		);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("polish failed");
		expect(notifies.at(-1)?.message).toContain("(raw template)");
	});
});
