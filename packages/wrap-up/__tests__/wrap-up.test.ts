import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
	buildHandoverFilename,
	DEFAULT_HANDOVER_DIR,
	detectResources,
	type HandoverConfig,
	resolveHandoverConfig,
	resolveHandoverDir,
	type WrapUpContext,
} from "../context.js";
import { pauseRaceWarning } from "../index.js";
import { buildPausePrompt } from "../prompt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<WrapUpContext> = {}): WrapUpContext {
	return {
		branch: "feat/my-feature",
		recentLog: "abc1234 feat: add thing\ndef5678 fix: typo",
		statusShort: "M packages/foo/index.ts",
		diffStat: "packages/foo/index.ts | 3 +++",
		stagedDiffStat: "",
		upstream: "origin/feat/my-feature",
		remoteUrl: "git@github.com:vegardx/pi-extensions.git",
		prInfo: null,
		resources: [],
		sessionCwd: "/Users/vegardx/src/github.com/vegardx/pi-extensions",
		date: "2026-05-06",
		sessionId: "abcdef1234567890",
		sessionFile: "/Users/vegardx/.pi/agent/sessions/pi-extensions/abc123.jsonl",
		sessionName: null,
		...overrides,
	};
}

function makeHandover(overrides: Partial<HandoverConfig> = {}): HandoverConfig {
	return {
		dir: "/Users/vegardx/.pi/agent/handovers",
		filename: "handover-2026-05-06-abcdef12.md",
		fullPath:
			"/Users/vegardx/.pi/agent/handovers/handover-2026-05-06-abcdef12.md",
		autoSave: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// resolveHandoverDir
// ---------------------------------------------------------------------------

describe("resolveHandoverDir", () => {
	it("returns DEFAULT_HANDOVER_DIR when no config provided", () => {
		expect(resolveHandoverDir()).toBe(DEFAULT_HANDOVER_DIR);
		expect(resolveHandoverDir("")).toBe(DEFAULT_HANDOVER_DIR);
		expect(resolveHandoverDir("  ")).toBe(DEFAULT_HANDOVER_DIR);
	});

	it("expands leading ~ to homedir()", () => {
		const result = resolveHandoverDir("~/my-handovers");
		expect(result).toBe(join(homedir(), "my-handovers"));
	});

	it("expands bare ~ to homedir()", () => {
		const result = resolveHandoverDir("~");
		expect(result).toBe(homedir());
	});

	it("returns an absolute path unchanged", () => {
		expect(resolveHandoverDir("/tmp/handovers")).toBe("/tmp/handovers");
	});

	it("DEFAULT_HANDOVER_DIR is a handovers/ folder under the agent dir", () => {
		expect(DEFAULT_HANDOVER_DIR).toBe(join(getAgentDir(), "handovers"));
	});
});

// ---------------------------------------------------------------------------
// buildHandoverFilename
// ---------------------------------------------------------------------------

describe("buildHandoverFilename", () => {
	it("includes the date", () => {
		expect(buildHandoverFilename(makeCtx({ date: "2026-05-06" }))).toContain(
			"2026-05-06",
		);
	});

	it("includes first 8 chars of sessionId", () => {
		const fn = buildHandoverFilename(
			makeCtx({ sessionId: "abcdef1234567890" }),
		);
		expect(fn).toContain("abcdef12");
		expect(fn).not.toContain("34567890");
	});

	it("ends with .md", () => {
		expect(buildHandoverFilename(makeCtx())).toMatch(/\.md$/);
	});

	it("starts with handover-", () => {
		expect(buildHandoverFilename(makeCtx())).toMatch(/^handover-/);
	});

	it("different sessions on same day produce different filenames", () => {
		const a = buildHandoverFilename(
			makeCtx({ date: "2026-05-06", sessionId: "aaaaaaaa00000000" }),
		);
		const b = buildHandoverFilename(
			makeCtx({ date: "2026-05-06", sessionId: "bbbbbbbb00000000" }),
		);
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// resolveHandoverConfig
// ---------------------------------------------------------------------------

describe("resolveHandoverConfig", () => {
	it("fullPath = dir + filename", () => {
		const ctx = makeCtx();
		const cfg = resolveHandoverConfig(ctx, { autoSave: false });
		expect(cfg.fullPath).toBe(join(cfg.dir, cfg.filename));
	});

	it("uses DEFAULT_HANDOVER_DIR when no dir configured", () => {
		const cfg = resolveHandoverConfig(makeCtx(), { autoSave: false });
		expect(cfg.dir).toBe(DEFAULT_HANDOVER_DIR);
	});

	it("uses configured dir after ~ expansion", () => {
		const cfg = resolveHandoverConfig(makeCtx(), {
			configuredDir: "~/custom-handovers",
			autoSave: false,
		});
		expect(cfg.dir).toBe(join(homedir(), "custom-handovers"));
	});

	it("reflects autoSave: true", () => {
		const cfg = resolveHandoverConfig(makeCtx(), { autoSave: true });
		expect(cfg.autoSave).toBe(true);
	});

	it("reflects autoSave: false", () => {
		const cfg = resolveHandoverConfig(makeCtx(), { autoSave: false });
		expect(cfg.autoSave).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildPausePrompt — structure
// ---------------------------------------------------------------------------

describe("buildPausePrompt", () => {
	it("includes the branch name in the snapshot", () => {
		const prompt = buildPausePrompt(
			makeCtx({ branch: "feat/my-feature" }),
			makeHandover(),
		);
		expect(prompt).toContain("feat/my-feature");
	});

	it("includes the date in the handover heading", () => {
		const prompt = buildPausePrompt(
			makeCtx({ date: "2026-05-06" }),
			makeHandover(),
		);
		expect(prompt).toContain("Session Handover — 2026-05-06");
	});

	it("includes the full handover path in the save step", () => {
		const handover = makeHandover({
			fullPath:
				"/home/user/.pi/agent/handovers/handover-2026-05-06-abcd1234.md",
		});
		const prompt = buildPausePrompt(makeCtx(), handover);
		expect(prompt).toContain(
			"/home/user/.pi/agent/handovers/handover-2026-05-06-abcd1234.md",
		);
	});

	it("includes the session ID in the snapshot", () => {
		const prompt = buildPausePrompt(
			makeCtx({ sessionId: "abcdef1234567890" }),
			makeHandover(),
		);
		expect(prompt).toContain("abcdef1234567890");
	});

	it("includes the session file path in the snapshot", () => {
		const prompt = buildPausePrompt(
			makeCtx({
				sessionFile:
					"/Users/vegardx/.pi/agent/sessions/pi-extensions/abc123.jsonl",
			}),
			makeHandover(),
		);
		expect(prompt).toContain("abc123.jsonl");
	});

	it("includes the session name when set", () => {
		const prompt = buildPausePrompt(
			makeCtx({ sessionName: "Add exa skill" }),
			makeHandover(),
		);
		expect(prompt).toContain("Add exa skill");
	});

	it("includes the recent git log", () => {
		const prompt = buildPausePrompt(makeCtx(), makeHandover());
		expect(prompt).toContain("abc1234 feat: add thing");
	});

	it("includes the working tree status", () => {
		const prompt = buildPausePrompt(makeCtx(), makeHandover());
		expect(prompt).toContain("packages/foo/index.ts");
	});

	it("includes the upstream tracking branch", () => {
		const prompt = buildPausePrompt(
			makeCtx({ upstream: "origin/feat/my-feature" }),
			makeHandover(),
		);
		expect(prompt).toContain("origin/feat/my-feature");
	});

	it("includes the remote URL", () => {
		const prompt = buildPausePrompt(makeCtx(), makeHandover());
		expect(prompt).toContain("git@github.com:vegardx/pi-extensions.git");
	});

	it("formats PR info from JSON", () => {
		const prJson = JSON.stringify({
			number: 42,
			title: "Add exa skill",
			url: "https://github.com/vegardx/pi-extensions/pull/42",
			state: "OPEN",
			isDraft: false,
		});
		const prompt = buildPausePrompt(
			makeCtx({ prInfo: prJson }),
			makeHandover(),
		);
		expect(prompt).toContain(
			"https://github.com/vegardx/pi-extensions/pull/42",
		);
		expect(prompt).toContain("Add exa skill");
	});

	it("marks draft PRs", () => {
		const prJson = JSON.stringify({
			number: 7,
			title: "WIP",
			url: "https://github.com/vegardx/pi-extensions/pull/7",
			state: "OPEN",
			isDraft: true,
		});
		const prompt = buildPausePrompt(
			makeCtx({ prInfo: prJson }),
			makeHandover(),
		);
		expect(prompt).toContain("DRAFT");
	});

	it("snapshot always present (session ID always known)", () => {
		// Even with no branch/upstream/remote/PR, session ID is always there
		const prompt = buildPausePrompt(
			makeCtx({
				branch: null,
				upstream: null,
				remoteUrl: null,
				prInfo: null,
				sessionId: "test1234abcd",
			}),
			makeHandover(),
		);
		expect(prompt).toContain("test1234abcd");
		expect(prompt).not.toContain("Branch:");
	});

	it("omits the staged section when stagedDiffStat is empty", () => {
		const prompt = buildPausePrompt(
			makeCtx({ stagedDiffStat: "" }),
			makeHandover(),
		);
		expect(prompt).not.toContain("Staged changes");
	});

	it("includes staged section when stagedDiffStat is set", () => {
		const prompt = buildPausePrompt(
			makeCtx({ stagedDiffStat: "packages/foo/index.ts | 2 ++" }),
			makeHandover(),
		);
		expect(prompt).toContain("Staged changes");
	});

	it("includes pi --resume hint when sessionFile is set", () => {
		const prompt = buildPausePrompt(
			makeCtx({
				sessionFile: "/some/session.jsonl",
				sessionId: "abcdef12xyz",
			}),
			makeHandover(),
		);
		expect(prompt).toContain("pi --resume");
	});

	it("omits pi --resume hint when sessionFile is null", () => {
		const prompt = buildPausePrompt(
			makeCtx({ sessionFile: null }),
			makeHandover(),
		);
		expect(prompt).not.toContain("pi --resume");
	});

	// --- finding #1: fmSafe must produce valid YAML double-quoted scalars ---
	it("escapes backslashes in sessionCwd frontmatter so YAML stays valid (Windows path)", () => {
		const prompt = buildPausePrompt(
			makeCtx({ sessionCwd: "C:\\Users\\vegard\\project" }),
			makeHandover(),
		);
		// In YAML double-quoted scalars, backslashes are escape characters.
		// C:\Users\ must be encoded as C:\\Users\\ so parsers read it
		// back as C:\Users\.
		expect(prompt).toContain('cwd: "C:\\\\Users\\\\vegard\\\\project"');
	});

	// --- finding #2: Remote field must have credentials stripped ---
	it("strips embedded token from Remote field in Step 2 snapshot", () => {
		const credUrl =
			"https://x-access-token:ghp_secret123@github.com/org/repo.git";
		const prompt = buildPausePrompt(
			makeCtx({ remoteUrl: credUrl }),
			makeHandover(),
		);
		expect(prompt).not.toContain("ghp_secret123");
		expect(prompt).toContain("https://github.com/org/repo.git");
	});
});

// ---------------------------------------------------------------------------
// buildPausePrompt — autoSave variants
// ---------------------------------------------------------------------------

describe("buildPausePrompt — autoSave", () => {
	it("autoSave: false — asks before writing", () => {
		const prompt = buildPausePrompt(
			makeCtx(),
			makeHandover({ autoSave: false }),
		);
		expect(prompt).toContain("Ask:");
		expect(prompt).not.toContain("Do not ask for confirmation");
	});

	it("autoSave: true — writes immediately without asking", () => {
		const prompt = buildPausePrompt(
			makeCtx(),
			makeHandover({ autoSave: true }),
		);
		expect(prompt).toContain("immediately");
		expect(prompt).not.toContain("Ask:");
	});

	it("autoSave: true — includes 'Do not ask for confirmation'", () => {
		const prompt = buildPausePrompt(
			makeCtx(),
			makeHandover({ autoSave: true }),
		);
		expect(prompt).toContain("Do not ask for confirmation");
	});
});

// ---------------------------------------------------------------------------
// buildPausePrompt — resource cleanup section
// ---------------------------------------------------------------------------

describe("buildPausePrompt — resources", () => {
	it("omits resource cleanup step when no resources detected", () => {
		const prompt = buildPausePrompt(makeCtx({ resources: [] }), makeHandover());
		expect(prompt).not.toContain("Resource cleanup");
	});

	it("includes resource cleanup step when resources are present", () => {
		const prompt = buildPausePrompt(
			makeCtx({ resources: [{ label: "Terraform", path: "main.tf" }] }),
			makeHandover(),
		);
		expect(prompt).toContain("Resource cleanup");
	});

	it("lists each detected resource by label", () => {
		const prompt = buildPausePrompt(
			makeCtx({
				resources: [
					{ label: "Terraform", path: "main.tf" },
					{ label: "GitHub Actions", path: ".github/workflows" },
				],
			}),
			makeHandover(),
		);
		expect(prompt).toContain("**Terraform**");
		expect(prompt).toContain("**GitHub Actions**");
	});

	it("includes the triggering path for each resource", () => {
		const prompt = buildPausePrompt(
			makeCtx({
				resources: [{ label: "Docker Compose", path: "docker-compose.yml" }],
			}),
			makeHandover(),
		);
		expect(prompt).toContain("docker-compose.yml");
	});

	it("save step is renumbered when no resources (Step 4, not Step 5)", () => {
		const noRes = buildPausePrompt(makeCtx({ resources: [] }), makeHandover());
		const withRes = buildPausePrompt(
			makeCtx({ resources: [{ label: "Terraform", path: "main.tf" }] }),
			makeHandover(),
		);
		expect(noRes).toContain("Step 4");
		expect(withRes).toContain("Step 5");
	});
});

// ---------------------------------------------------------------------------
// detectResources
// ---------------------------------------------------------------------------

describe("detectResources", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "wrap-up-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty array for a bare directory", () => {
		expect(detectResources(tmp)).toEqual([]);
	});

	it("detects main.tf as Terraform", () => {
		writeFileSync(join(tmp, "main.tf"), "");
		const r = detectResources(tmp);
		expect(r.some((s) => s.label === "Terraform")).toBe(true);
	});

	it("detects docker-compose.yml as Docker Compose", () => {
		writeFileSync(join(tmp, "docker-compose.yml"), "");
		const r = detectResources(tmp);
		expect(r.some((s) => s.label === "Docker Compose")).toBe(true);
	});

	it("detects Dockerfile as Docker", () => {
		writeFileSync(join(tmp, "Dockerfile"), "");
		const r = detectResources(tmp);
		expect(r.some((s) => s.label === "Docker")).toBe(true);
	});

	it("detects .github/workflows as GitHub Actions", () => {
		mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
		const r = detectResources(tmp);
		expect(r.some((s) => s.label === "GitHub Actions")).toBe(true);
	});

	it("detects fly.toml as Fly.io", () => {
		writeFileSync(join(tmp, "fly.toml"), "");
		const r = detectResources(tmp);
		expect(r.some((s) => s.label === "Fly.io")).toBe(true);
	});

	it("de-duplicates: two terraform files produce one Terraform signal", () => {
		writeFileSync(join(tmp, "main.tf"), "");
		writeFileSync(join(tmp, "terraform.tf"), "");
		const r = detectResources(tmp);
		expect(r.filter((s) => s.label === "Terraform")).toHaveLength(1);
	});

	it("detects cdk.json as AWS CDK", () => {
		writeFileSync(join(tmp, "cdk.json"), "{}");
		const r = detectResources(tmp);
		expect(r.some((s) => s.label === "AWS CDK")).toBe(true);
	});

	it("detects multiple distinct resource types at once", () => {
		writeFileSync(join(tmp, "fly.toml"), "");
		writeFileSync(join(tmp, "Dockerfile"), "");
		mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
		const r = detectResources(tmp);
		const labels = r.map((s) => s.label);
		expect(labels).toContain("Fly.io");
		expect(labels).toContain("Docker");
		expect(labels).toContain("GitHub Actions");
	});
});

// ---------------------------------------------------------------------------
// pauseRaceWarning — /pause in-flight guard for /continue
// ---------------------------------------------------------------------------

describe("pauseRaceWarning", () => {
	it("returns null when no pause is in-flight", () => {
		expect(pauseRaceWarning(false)).toBeNull();
	});

	it("returns a warning string when a pause is in-flight", () => {
		const msg = pauseRaceWarning(true);
		expect(msg).not.toBeNull();
		expect(msg).toContain("/pause");
		expect(msg).toContain("/continue");
	});

	it("warning mentions waiting for the agent to finish", () => {
		const msg = pauseRaceWarning(true) ?? "";
		expect(msg.toLowerCase()).toContain("wait");
	});
});
