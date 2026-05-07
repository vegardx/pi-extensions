import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ContextFileInfo,
	discoverContextFiles,
	renderLines,
	type StartupSummary,
} from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-ext-startup-ctx-test-"));
}

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

// Minimal valid StartupSummary for renderLines tests.
function emptySummary(extra?: Partial<StartupSummary>): StartupSummary {
	return {
		declared: [],
		unrecognized: [],
		layered: { global: {}, project: {}, merged: {} },
		...extra,
	};
}

// ---------------------------------------------------------------------------
// discoverContextFiles
// ---------------------------------------------------------------------------

describe("discoverContextFiles", () => {
	let root: string;

	beforeEach(() => {
		root = mkTempDir();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns an empty array when no context files exist anywhere", () => {
		const globalDir = join(root, "global");
		const cwd = join(root, "a", "b", "c");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(globalDir, { recursive: true });

		expect(discoverContextFiles(cwd, { globalDir })).toEqual([]);
	});

	it("discovers the global file with scope 'global'", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });
		write(join(globalDir, "AGENTS.md"), "# Global\nHello");

		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });

		const results = discoverContextFiles(cwd, { globalDir });
		expect(results).toHaveLength(1);
		expect(results[0].scope).toBe("global");
		expect(results[0].path).toBe(join(globalDir, "AGENTS.md"));
	});

	it("prefers AGENTS.md over CLAUDE.md at each level", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });
		// Both files exist — AGENTS.md should win.
		write(join(globalDir, "CLAUDE.md"), "# claude");
		write(join(globalDir, "AGENTS.md"), "# agents");

		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });

		const results = discoverContextFiles(cwd, { globalDir });
		expect(results[0].path).toContain("AGENTS.md");
	});

	it("falls back to CLAUDE.md when AGENTS.md is absent", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });
		write(join(globalDir, "CLAUDE.md"), "# claude only");

		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });

		const results = discoverContextFiles(cwd, { globalDir });
		expect(results[0].path).toContain("CLAUDE.md");
	});

	it("assigns scope 'project' for the cwd file and 'parent' for ancestors", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });

		// Structure: root/a/b/c where root/a has a parent file and root/a/b/c is cwd
		const a = join(root, "a");
		const cwd = join(root, "a", "b", "c");
		mkdirSync(cwd, { recursive: true });
		write(join(a, "AGENTS.md"), "# parent");
		write(join(cwd, "AGENTS.md"), "# project");

		const results = discoverContextFiles(cwd, { globalDir });

		const parent = results.find((f) => f.path === join(a, "AGENTS.md"));
		const project = results.find((f) => f.path === join(cwd, "AGENTS.md"));

		expect(parent?.scope).toBe("parent");
		expect(project?.scope).toBe("project");
	});

	it("returns files in root→cwd order (global first, project last)", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });
		write(join(globalDir, "AGENTS.md"), "global");

		const mid = join(root, "mid");
		const cwd = join(root, "mid", "deep");
		mkdirSync(cwd, { recursive: true });
		write(join(mid, "AGENTS.md"), "mid");
		write(join(cwd, "AGENTS.md"), "project");

		const results = discoverContextFiles(cwd, { globalDir });
		const scopes = results.map((f) => f.scope);

		// global must come first, project last
		expect(scopes[0]).toBe("global");
		expect(scopes[scopes.length - 1]).toBe("project");
	});

	it("computes token estimate as ceil(charCount / 4)", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });

		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		const content = "a".repeat(100);
		write(join(cwd, "AGENTS.md"), content);

		const results = discoverContextFiles(cwd, { globalDir });
		expect(results[0].tokens).toBe(25); // ceil(100/4)
	});

	it("counts lines correctly", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });

		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		write(join(cwd, "AGENTS.md"), "line1\nline2\nline3");

		const results = discoverContextFiles(cwd, { globalDir });
		expect(results[0].lines).toBe(3);
	});

	it("includes at most one file per directory", () => {
		const globalDir = join(root, "global");
		mkdirSync(globalDir, { recursive: true });

		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });
		write(join(cwd, "AGENTS.md"), "agents");
		write(join(cwd, "CLAUDE.md"), "claude");

		const results = discoverContextFiles(cwd, { globalDir });
		// Only AGENTS.md from cwd, no CLAUDE.md
		expect(results.filter((f) => f.path.startsWith(cwd))).toHaveLength(1);
	});

	it("produces a display path starting with ~ for paths under home", () => {
		const home = homedir();
		// Use the real home to test the ~ substitution; point cwd outside home
		// so globalDir (which IS under home) gets the ~ treatment.
		const globalDir = join(home, ".pi", "agent-test-tmp");
		mkdirSync(globalDir, { recursive: true });
		write(join(globalDir, "AGENTS.md"), "global");

		const cwd = join(root, "proj");
		mkdirSync(cwd, { recursive: true });

		try {
			const results = discoverContextFiles(cwd, { globalDir });
			const globalFile = results.find((f) => f.scope === "global");
			expect(globalFile?.displayPath).toMatch(/^~\//);
		} finally {
			rmSync(globalDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// renderLines — context files section
// ---------------------------------------------------------------------------

describe("renderLines — context files section", () => {
	it("renders '(none found)' when contextFiles is absent", () => {
		const lines = renderLines(emptySummary());
		expect(lines).toContain("Context files: (none found)");
	});

	it("renders '(none found)' when contextFiles is an empty array", () => {
		const lines = renderLines(emptySummary({ contextFiles: [] }));
		expect(lines).toContain("Context files: (none found)");
	});

	it("renders header with count and total tokens", () => {
		const files: ContextFileInfo[] = [
			{
				path: "/a/AGENTS.md",
				displayPath: "~/.pi/agent/AGENTS.md",
				scope: "global",
				tokens: 80,
				lines: 10,
			},
			{
				path: "/b/AGENTS.md",
				displayPath: "~/src/proj/AGENTS.md",
				scope: "project",
				tokens: 120,
				lines: 15,
			},
		];
		const lines = renderLines(emptySummary({ contextFiles: files }));
		expect(lines).toContain("Context files (2 · 200 tokens):");
	});

	it("formats totals >= 1000 tokens with a k suffix", () => {
		const files: ContextFileInfo[] = [
			{
				path: "/a/AGENTS.md",
				displayPath: "~/a/AGENTS.md",
				scope: "global",
				tokens: 1500,
				lines: 200,
			},
		];
		const lines = renderLines(emptySummary({ contextFiles: files }));
		expect(lines).toContain("Context files (1 · 1.5k tokens):");
	});

	it("renders one line per file with scope, displayPath, tok, and lines", () => {
		const files: ContextFileInfo[] = [
			{
				path: "/global/AGENTS.md",
				displayPath: "~/.pi/agent/AGENTS.md",
				scope: "global",
				tokens: 320,
				lines: 45,
			},
			{
				path: "/mid/AGENTS.md",
				displayPath: "~/src/github.com/vegardx/AGENTS.md",
				scope: "parent",
				tokens: 180,
				lines: 22,
			},
			{
				path: "/proj/AGENTS.md",
				displayPath: "~/src/github.com/vegardx/pi-extensions/AGENTS.md",
				scope: "project",
				tokens: 940,
				lines: 120,
			},
		];
		const lines = renderLines(emptySummary({ contextFiles: files }));

		expect(lines).toContain(
			"  global   ~/.pi/agent/AGENTS.md  (320 tok · 45 lines)",
		);
		expect(lines).toContain(
			"  parent   ~/src/github.com/vegardx/AGENTS.md  (180 tok · 22 lines)",
		);
		expect(lines).toContain(
			"  project  ~/src/github.com/vegardx/pi-extensions/AGENTS.md  (940 tok · 120 lines)",
		);
	});

	it("context files section appears after background models", () => {
		const files: ContextFileInfo[] = [
			{
				path: "/a/AGENTS.md",
				displayPath: "~/a/AGENTS.md",
				scope: "project",
				tokens: 50,
				lines: 5,
			},
		];
		const lines = renderLines(emptySummary({ contextFiles: files }));
		const bgIdx = lines.findIndex((l) => l === "Background models:");
		const cfIdx = lines.findIndex((l) => l.startsWith("Context files"));
		expect(bgIdx).toBeGreaterThanOrEqual(0);
		expect(cfIdx).toBeGreaterThan(bgIdx);
	});
});
