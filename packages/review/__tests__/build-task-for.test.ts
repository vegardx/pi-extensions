import { type AutoReviewContext, buildTaskFor } from "../auto-review.js";
import type { IndexSketch } from "../indexer.js";

const SAMPLE_DIFF = `diff --git a/x.ts b/x.ts
+export function added() {}
`;

function rc(): AutoReviewContext {
	return {
		scopeMode: "branch",
		scopeLabel: "current branch vs. main",
		diff: SAMPLE_DIFF,
		files: ["x.ts"],
		changedFiles: 1,
		additions: 1,
		deletions: 0,
	};
}

function sketch(): IndexSketch {
	return {
		entryPoints: [{ file: "x.ts", line: 1, reason: "exported new function" }],
		modules: [],
		hotFiles: [],
		riskSurfaces: [{ kind: "public-api", where: "x.ts:1" }],
		openQuestions: [],
	};
}

describe("buildTaskFor (indexer + static integration)", () => {
	it("emits the diff + role + scope without an index when sketch is null", () => {
		const task = buildTaskFor("code-reviewer", rc(), null);
		expect(task).toContain("Role: code-reviewer");
		expect(task).toContain("Scope: current branch vs. main");
		expect(task).toContain("```diff");
		expect(task).not.toContain("## Index (pre-computed map of the diff)");
	});

	it("threads a populated index sketch into the payload", () => {
		const task = buildTaskFor("code-reviewer", rc(), sketch());
		expect(task).toContain("## Index (pre-computed map of the diff)");
		expect(task).toContain('"file": "x.ts"');
		expect(task).toContain('"reason": "exported new function"');
		expect(task).toContain('"kind": "public-api"');
	});

	it("omits the index section when the sketch is empty", () => {
		const empty: IndexSketch = {
			entryPoints: [],
			modules: [],
			hotFiles: [],
			riskSurfaces: [],
			openQuestions: [],
		};
		const task = buildTaskFor("code-reviewer", rc(), empty);
		expect(task).not.toContain("## Index (pre-computed map of the diff)");
	});

	it("places the index section after the diff (so reviewers see the diff first)", () => {
		const task = buildTaskFor("code-reviewer", rc(), sketch());
		const diffIdx = task.indexOf("```diff");
		const indexIdx = task.indexOf("## Index (pre-computed map of the diff)");
		expect(diffIdx).toBeGreaterThanOrEqual(0);
		expect(indexIdx).toBeGreaterThan(diffIdx);
	});

	it("renders pre-computed static findings when provided", () => {
		const task = buildTaskFor("code-reviewer", rc(), null, [
			{
				severity: "IMPORTANT",
				file: "x.ts",
				title: "biome flagged",
				description: "useTemplate",
			},
		]);
		expect(task).toContain("## Static analysis pre-scan");
		expect(task).toContain("biome flagged");
	});
});
