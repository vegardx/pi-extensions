import {
	countChangedLines,
	hashContent,
	reviewHasFindings,
	shouldReview,
} from "../tracker.js";

describe("shouldReview", () => {
	it("accepts typical source files", () => {
		expect(shouldReview("/repo/src/foo.ts")).toBe(true);
		expect(shouldReview("/repo/packages/x/index.ts")).toBe(true);
		expect(shouldReview("/repo/tests/a.test.ts")).toBe(true);
	});

	it("rejects paths inside excluded directories", () => {
		expect(shouldReview("/repo/node_modules/foo/index.js")).toBe(false);
		expect(shouldReview("/repo/dist/index.js")).toBe(false);
		expect(shouldReview("/repo/.git/HEAD")).toBe(false);
		expect(shouldReview("/repo/coverage/lcov.info")).toBe(false);
	});

	it("rejects lockfiles", () => {
		expect(shouldReview("/repo/package-lock.json")).toBe(false);
		expect(shouldReview("/repo/pnpm-lock.yaml")).toBe(false);
		expect(shouldReview("/repo/Cargo.lock")).toBe(false);
	});

	it("rejects binary and generated extensions", () => {
		expect(shouldReview("/repo/assets/logo.png")).toBe(false);
		expect(shouldReview("/repo/public/bundle.min.js")).toBe(false);
		expect(shouldReview("/repo/public/app.js.map")).toBe(false);
	});

	it("is not tripped up by similarly-named regular files", () => {
		expect(shouldReview("/repo/src/logogen.ts")).toBe(true);
		expect(shouldReview("/repo/src/mapping.ts")).toBe(true);
	});
});

describe("countChangedLines", () => {
	it("counts additions and deletions but not headers", () => {
		const diff = [
			"--- a/foo.ts",
			"+++ b/foo.ts",
			"@@ -1,3 +1,4 @@",
			" const x = 1;",
			"-const y = 2;",
			"+const y = 3;",
			"+const z = 4;",
		].join("\n");
		expect(countChangedLines(diff)).toBe(3);
	});

	it("returns 0 for empty input", () => {
		expect(countChangedLines("")).toBe(0);
	});
});

describe("hashContent", () => {
	it("produces stable hashes", () => {
		expect(hashContent("hello")).toBe(hashContent("hello"));
	});

	it("distinguishes distinct inputs", () => {
		expect(hashContent("hello")).not.toBe(hashContent("hello!"));
	});
});

describe("reviewHasFindings", () => {
	it("treats the bare session sentinel as no findings", () => {
		expect(reviewHasFindings("No simplifications suggested.")).toBe(false);
		expect(reviewHasFindings("  No simplifications suggested.  ")).toBe(false);
		expect(reviewHasFindings("no simplifications suggested")).toBe(false);
	});

	it("treats the legacy per-file sentinel as no findings", () => {
		expect(reviewHasFindings("No simplifications suggested for foo.ts.")).toBe(
			false,
		);
		expect(
			reviewHasFindings("  No simplifications suggested for foo.ts.  "),
		).toBe(false);
	});

	it("treats empty / undefined as no findings", () => {
		expect(reviewHasFindings(undefined)).toBe(false);
		expect(reviewHasFindings("")).toBe(false);
		expect(reviewHasFindings("   \n  ")).toBe(false);
	});

	it("treats real bullets as findings", () => {
		expect(
			reviewHasFindings("- **foo.ts:1** — Dead branch. Fix: delete."),
		).toBe(true);
	});
});
