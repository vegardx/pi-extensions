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
import { defaultResolvePolishModel, runDerp } from "../index.js";
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
	it("bails and stashes with polished content when polish succeeds", async () => {
		const { ctx, notifies } = fakeCtx();
		const polish = fakePolish({
			ok: true,
			draft: { title: "thing broke", body: "## Summary\n\npolished details" },
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
		expect(warn?.message).toContain("not filing (polished)");
		const files = pendingFiles();
		expect(files).toHaveLength(1);
		const first = files[0];
		if (!first) throw new Error("unreachable");
		const written = readFileSync(join(pendingDir, first), "utf8");
		// Token must not appear in any form
		expect(written).not.toContain("ghp_AbCdEf1234567890ZzYy");
		// Polished content is present
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

		await runDerp(
			ctx,
			"this is broken, my token is ghp_AbCdEf1234567890ZzYy please debug",
			{ polish, createIssue: create.fn, pendingDir },
		);

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("secret-token");
		expect(warn?.message).toContain("not filing (raw)");
		const written = readFileSync(join(pendingDir, pendingFiles()[0]!), "utf8");
		// Falls back to raw template — token is redacted, placeholder present
		expect(written).not.toContain("ghp_AbCdEf1234567890ZzYy");
		expect(written).toContain("[REDACTED:secret-token]");
		expect(written).toContain("polish step skipped");
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

	it("bails and stashes when sessionName contains an internal host", async () => {
		const { ctx, notifies } = fakeCtx({
			sessionName: "debugging issue on dnb.ghe.com/org/repo",
		});
		const polish = fakePolish({
			ok: true,
			draft: { title: "x", body: "y" },
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runDerp(ctx, "something broke", {
			polish,
			createIssue: create.fn,
			pendingDir,
		});

		expect(create.calls).toEqual([]);
		const warn = notifies.find((n) => n.level === "warning");
		expect(warn?.message).toContain("internal-host");
		expect(warn?.message).toContain("not filing");
		expect(pendingFiles()).toHaveLength(1);
	});

	it("bails and stashes when a recent entry contains a token", async () => {
		const { ctx, notifies } = fakeCtx({
			entries: [
				{ role: "user", text: "my token is ghp_AbCdEf1234567890ZzYy, help" },
			],
		});
		const polish = fakePolish({
			ok: true,
			draft: { title: "x", body: "y" },
		});
		const create = fakeCreateIssue({ ok: true, url: "should-not-fire" });

		await runDerp(ctx, "something broke", {
			polish,
			createIssue: create.fn,
			pendingDir,
		});

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

	it("returns model from registry when find() resolves a configured spec", async () => {
		const { ctx } = fakeCtx();
		const fakeModel = { provider: "google", id: "gemini-flash" };
		// Inject a registry that resolves the lookup
		(ctx as unknown as Record<string, unknown>).modelRegistry = {
			find: (p: string, id: string) =>
				p === "google" && id === "gemini-flash" ? fakeModel : undefined,
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				apiKey: "key",
				headers: undefined,
			}),
		};
		// resolveModel reads settings from cwd (/tmp/fake) — no settings file
		// there, so no extensionConfig.derp.model spec is configured.
		// Falls back to ctx.model (anthropic/claude-x) via the registry mock.
		const result = await defaultResolvePolishModel(ctx);
		expect(result?.provider).toBe("anthropic");
		expect(result?.id).toBe("claude-x");
	});
});
