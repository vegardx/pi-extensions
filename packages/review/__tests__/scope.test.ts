import { parseScope } from "../scope.js";

describe("parseScope", () => {
	it("defaults to working mode", () => {
		expect(parseScope(undefined)).toEqual({ mode: "working", paths: [] });
		expect(parseScope("")).toEqual({ mode: "working", paths: [] });
		expect(parseScope("   ")).toEqual({ mode: "working", paths: [] });
	});

	it("recognises --staged", () => {
		expect(parseScope("--staged")).toEqual({ mode: "staged", paths: [] });
	});

	it("recognises --branch", () => {
		expect(parseScope("--branch")).toEqual({ mode: "branch", paths: [] });
	});

	it("recognises --all", () => {
		expect(parseScope("--all")).toEqual({ mode: "all", paths: [] });
	});

	it("collects positional file paths", () => {
		expect(parseScope("src/foo.ts src/bar.ts")).toEqual({
			mode: "file",
			paths: ["src/foo.ts", "src/bar.ts"],
		});
	});

	it("rejects conflicting scope flags", () => {
		expect(() => parseScope("--staged --branch")).toThrow(/conflicting/);
		expect(() => parseScope("--all --branch")).toThrow(/conflicting/);
	});

	it("rejects combining a scope flag with explicit paths", () => {
		expect(() => parseScope("--staged src/foo.ts")).toThrow(
			/cannot combine.*--staged/,
		);
		expect(() => parseScope("--branch src/foo.ts")).toThrow(
			/cannot combine.*--branch/,
		);
	});

	it("rejects unknown flags", () => {
		expect(() => parseScope("--wat")).toThrow(/unknown flag --wat/);
		// --deps is no longer accepted — dep-checker always runs.
		expect(() => parseScope("--deps")).toThrow(/unknown flag --deps/);
	});
});
