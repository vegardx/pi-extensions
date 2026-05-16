import {
	buildIndexerTask,
	type IndexSketch,
	parseIndexerOutput,
	renderIndexSketchForReviewer,
} from "../indexer.js";

const SAMPLE_DIFF = `diff --git a/x.ts b/x.ts
+export function added() {}
`;

function rc(extra: Partial<Parameters<typeof buildIndexerTask>[0]> = {}) {
	return {
		scopeLabel: "current branch vs. main",
		files: ["x.ts"],
		changedFiles: 1,
		additions: 1,
		deletions: 0,
		diff: SAMPLE_DIFF,
		...extra,
	};
}

describe("buildIndexerTask", () => {
	it("emits scope, files, diff, and the JSON instruction", () => {
		const task = buildIndexerTask(rc());
		expect(task).toContain("Scope: current branch vs. main");
		expect(task).toContain("- x.ts");
		expect(task).toContain("```diff");
		expect(task).toContain("Emit a single JSON object");
	});

	it("truncates file lists past 200 entries", () => {
		const files = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
		const task = buildIndexerTask(rc({ files, changedFiles: 250 }));
		expect(task).toContain("- f0.ts");
		expect(task).toContain("- f199.ts");
		expect(task).not.toContain("- f200.ts");
		expect(task).toContain("… and 50 more");
	});
});

describe("parseIndexerOutput", () => {
	it("parses a fully-populated payload", () => {
		const json = {
			entryPoints: [
				{ file: "a.ts", line: 10, reason: "exported" },
				{ file: "b.ts", reason: "no line" },
			],
			modules: [{ name: "pkg/a", files: ["a.ts"], summary: "added function" }],
			hotFiles: [
				{ file: "a.ts", additions: 50, deletions: 0, note: "core change" },
			],
			riskSurfaces: [
				{ kind: "shell", where: "a.ts:120", note: "user input piped" },
			],
			openQuestions: ["does the new path handle empty input?"],
		};
		const parsed = parseIndexerOutput(JSON.stringify(json));
		expect(parsed).not.toBeNull();
		const s = parsed as IndexSketch;
		expect(s.entryPoints).toHaveLength(2);
		expect(s.entryPoints[0]).toEqual({
			file: "a.ts",
			line: 10,
			reason: "exported",
		});
		expect(s.entryPoints[1]).toEqual({ file: "b.ts", reason: "no line" });
		expect(s.modules[0].files).toEqual(["a.ts"]);
		expect(s.hotFiles[0].note).toBe("core change");
		expect(s.riskSurfaces[0].kind).toBe("shell");
		expect(s.openQuestions[0]).toContain("empty input");
	});

	it("tolerates code-fenced output", () => {
		const text =
			"Some prose\n```json\n" +
			JSON.stringify({
				entryPoints: [{ file: "a.ts", reason: "x" }],
				modules: [],
				hotFiles: [],
				riskSurfaces: [],
				openQuestions: [],
			}) +
			"\n```\nMore prose";
		const parsed = parseIndexerOutput(text);
		expect(parsed).not.toBeNull();
		expect(parsed?.entryPoints).toHaveLength(1);
	});

	it("returns null for non-JSON output", () => {
		expect(parseIndexerOutput("not json at all")).toBeNull();
	});

	it("rejects array-shaped top level", () => {
		expect(parseIndexerOutput("[]")).toBeNull();
	});

	it("returns empty arrays for missing keys", () => {
		const parsed = parseIndexerOutput("{}");
		expect(parsed).toEqual({
			entryPoints: [],
			modules: [],
			hotFiles: [],
			riskSurfaces: [],
			openQuestions: [],
		});
	});

	it("drops malformed entries while keeping good ones", () => {
		const json = {
			entryPoints: [
				{ file: "a.ts", reason: "ok" },
				{ file: "b.ts" }, // missing reason → drop
				{ reason: "no file" }, // missing file → drop
				"not an object", // → drop
			],
			modules: [],
			hotFiles: [
				{ file: "a.ts", additions: "lots", deletions: 0 }, // additions invalid → defaults to 0
				{ file: "b.ts", additions: 5, deletions: 1 },
			],
			riskSurfaces: [
				{ kind: "weird", where: "a.ts" }, // unknown kind → "other"
				{ where: "b.ts" }, // missing kind → "other"
			],
			openQuestions: ["q1", 42, "q2"],
		};
		const parsed = parseIndexerOutput(JSON.stringify(json));
		expect(parsed?.entryPoints).toHaveLength(1);
		expect(parsed?.entryPoints[0].reason).toBe("ok");
		expect(parsed?.hotFiles).toHaveLength(2);
		expect(parsed?.hotFiles[0].additions).toBe(0);
		expect(parsed?.riskSurfaces[0].kind).toBe("other");
		expect(parsed?.riskSurfaces[1].kind).toBe("other");
		expect(parsed?.openQuestions).toEqual(["q1", "q2"]);
	});
});

describe("renderIndexSketchForReviewer", () => {
	it("returns empty string for null sketch", () => {
		expect(renderIndexSketchForReviewer(null)).toBe("");
	});

	it("returns empty string for an entirely empty sketch", () => {
		const empty: IndexSketch = {
			entryPoints: [],
			modules: [],
			hotFiles: [],
			riskSurfaces: [],
			openQuestions: [],
		};
		expect(renderIndexSketchForReviewer(empty)).toBe("");
	});

	it("renders the section header + JSON when populated", () => {
		const sketch: IndexSketch = {
			entryPoints: [{ file: "a.ts", reason: "modified" }],
			modules: [],
			hotFiles: [],
			riskSurfaces: [],
			openQuestions: [],
		};
		const out = renderIndexSketchForReviewer(sketch);
		expect(out).toContain("## Index (pre-computed map of the diff)");
		expect(out).toContain('"file": "a.ts"');
	});
});
