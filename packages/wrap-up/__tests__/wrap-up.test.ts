import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectResources, type WrapUpContext } from "../context.js";
import { buildWrapUpPrompt } from "../prompt.js";

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
		date: "2026-05-06",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildWrapUpPrompt — structure
// ---------------------------------------------------------------------------

describe("buildWrapUpPrompt", () => {
	it("includes the branch name in the snapshot", () => {
		const prompt = buildWrapUpPrompt(makeCtx({ branch: "feat/my-feature" }));
		expect(prompt).toContain("feat/my-feature");
	});

	it("includes the date in the handover heading", () => {
		const prompt = buildWrapUpPrompt(makeCtx({ date: "2026-05-06" }));
		expect(prompt).toContain("Session Wrap-Up — 2026-05-06");
	});

	it("includes the date in the save-to-file offer", () => {
		const prompt = buildWrapUpPrompt(makeCtx({ date: "2026-05-06" }));
		expect(prompt).toContain("handover-2026-05-06.md");
	});

	it("includes the recent git log", () => {
		const prompt = buildWrapUpPrompt(makeCtx());
		expect(prompt).toContain("abc1234 feat: add thing");
	});

	it("includes the working tree status", () => {
		const prompt = buildWrapUpPrompt(makeCtx());
		expect(prompt).toContain("packages/foo/index.ts");
	});

	it("includes the upstream tracking branch", () => {
		const prompt = buildWrapUpPrompt(
			makeCtx({ upstream: "origin/feat/my-feature" }),
		);
		expect(prompt).toContain("origin/feat/my-feature");
	});

	it("includes the remote URL", () => {
		const prompt = buildWrapUpPrompt(makeCtx());
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
		const prompt = buildWrapUpPrompt(makeCtx({ prInfo: prJson }));
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
		const prompt = buildWrapUpPrompt(makeCtx({ prInfo: prJson }));
		expect(prompt).toContain("DRAFT");
	});

	it("omits the snapshot block when branch is null", () => {
		const prompt = buildWrapUpPrompt(
			makeCtx({ branch: null, upstream: null, remoteUrl: null, prInfo: null }),
		);
		// Should still have the document structure
		expect(prompt).toContain("Session Wrap-Up");
		// But not a branch line
		expect(prompt).not.toContain("Branch:");
	});

	it("omits the staged section when stagedDiffStat is empty", () => {
		const prompt = buildWrapUpPrompt(makeCtx({ stagedDiffStat: "" }));
		expect(prompt).not.toContain("Staged changes");
	});

	it("includes staged section when stagedDiffStat is set", () => {
		const prompt = buildWrapUpPrompt(
			makeCtx({ stagedDiffStat: "packages/foo/index.ts | 2 ++" }),
		);
		expect(prompt).toContain("Staged changes");
	});
});

// ---------------------------------------------------------------------------
// buildWrapUpPrompt — resource cleanup section
// ---------------------------------------------------------------------------

describe("buildWrapUpPrompt — resources", () => {
	it("omits Step 4 entirely when no resources detected", () => {
		const prompt = buildWrapUpPrompt(makeCtx({ resources: [] }));
		expect(prompt).not.toContain("Step 4");
		expect(prompt).not.toContain("Resource cleanup");
	});

	it("includes Step 4 when resources are present", () => {
		const prompt = buildWrapUpPrompt(
			makeCtx({
				resources: [{ label: "Terraform", path: "main.tf" }],
			}),
		);
		expect(prompt).toContain("Step 4");
		expect(prompt).toContain("Resource cleanup");
	});

	it("lists each detected resource by label", () => {
		const prompt = buildWrapUpPrompt(
			makeCtx({
				resources: [
					{ label: "Terraform", path: "main.tf" },
					{ label: "GitHub Actions", path: ".github/workflows" },
				],
			}),
		);
		expect(prompt).toContain("**Terraform**");
		expect(prompt).toContain("**GitHub Actions**");
	});

	it("includes the triggering path for each resource", () => {
		const prompt = buildWrapUpPrompt(
			makeCtx({
				resources: [{ label: "Docker Compose", path: "docker-compose.yml" }],
			}),
		);
		expect(prompt).toContain("docker-compose.yml");
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
