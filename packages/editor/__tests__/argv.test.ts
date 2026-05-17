import { homedir } from "node:os";
import { applyArgvTemplate, parsePathArg } from "../argv.js";

describe("parsePathArg", () => {
	const CWD = "/repo";

	it("returns cwd when no arg supplied", () => {
		expect(parsePathArg(undefined, CWD)).toEqual({
			path: "/repo",
			line: "",
			col: "",
		});
		expect(parsePathArg("", CWD)).toEqual({
			path: "/repo",
			line: "",
			col: "",
		});
		expect(parsePathArg("   ", CWD)).toEqual({
			path: "/repo",
			line: "",
			col: "",
		});
	});

	it("resolves a relative path against cwd", () => {
		expect(parsePathArg("src/foo.ts", CWD)).toEqual({
			path: "/repo/src/foo.ts",
			line: "",
			col: "",
		});
	});

	it("preserves an absolute path", () => {
		expect(parsePathArg("/etc/hosts", CWD)).toEqual({
			path: "/etc/hosts",
			line: "",
			col: "",
		});
	});

	it("parses path:line", () => {
		expect(parsePathArg("src/foo.ts:42", CWD)).toEqual({
			path: "/repo/src/foo.ts",
			line: "42",
			col: "",
		});
	});

	it("parses path:line:col", () => {
		expect(parsePathArg("src/foo.ts:42:8", CWD)).toEqual({
			path: "/repo/src/foo.ts",
			line: "42",
			col: "8",
		});
	});

	it("rejects non-digit trailing segments (Makefile:foo stays as path)", () => {
		expect(parsePathArg("Makefile:foo", CWD)).toEqual({
			path: "/repo/Makefile:foo",
			line: "",
			col: "",
		});
	});

	it("partial match: weird:42:not-col keeps weird:42 as path", () => {
		// Right-most :digits is not satisfied (`not-col` isn't digits),
		// so we shouldn't peel anything. The whole string stays as path.
		expect(parsePathArg("weird:42:not-col", CWD)).toEqual({
			path: "/repo/weird:42:not-col",
			line: "",
			col: "",
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parsePathArg("  src/x.ts:7  ", CWD)).toEqual({
			path: "/repo/src/x.ts",
			line: "7",
			col: "",
		});
	});

	it("expands `~/` to the user's home directory", () => {
		const result = parsePathArg("~/foo.ts", "/repo");
		expect(result.path).toBe(`${homedir()}/foo.ts`);
	});

	it("expands a bare `~` to the user's home directory", () => {
		expect(parsePathArg("~", "/repo").path).toBe(homedir());
	});

	it("does NOT expand `~` mid-path (e.g. `foo/~bar`)", () => {
		// Only leading `~/` or bare `~` get expansion. Anything else stays
		// literal so paths containing `~` mid-string aren't mangled.
		const result = parsePathArg("foo/~bar", "/repo");
		expect(result.path).toBe("/repo/foo/~bar");
	});
});

describe("applyArgvTemplate", () => {
	const baseVars = {
		path: "/repo/src/foo.ts",
		cwd: "/repo",
		line: "42",
		col: "8",
	};

	it("substitutes all placeholders", () => {
		expect(applyArgvTemplate(["-g", "{path}:{line}:{col}"], baseVars)).toEqual([
			"-g",
			"/repo/src/foo.ts:42:8",
		]);
	});

	it("passes through args with no placeholders", () => {
		expect(applyArgvTemplate(["--wait", "{path}"], baseVars)).toEqual([
			"--wait",
			"/repo/src/foo.ts",
		]);
	});

	it("VS Code style with empty col strips trailing colon", () => {
		expect(
			applyArgvTemplate(["-g", "{path}:{line}:{col}"], {
				...baseVars,
				col: "",
			}),
		).toEqual(["-g", "/repo/src/foo.ts:42"]);
	});

	it("VS Code style with empty line+col strips trailing colons", () => {
		expect(
			applyArgvTemplate(["-g", "{path}:{line}:{col}"], {
				...baseVars,
				line: "",
				col: "",
			}),
		).toEqual(["-g", "/repo/src/foo.ts"]);
	});

	it("Cursor style with empty line strips trailing colon", () => {
		expect(
			applyArgvTemplate(["-g", "{path}:{line}"], {
				...baseVars,
				line: "",
				col: "",
			}),
		).toEqual(["-g", "/repo/src/foo.ts"]);
	});

	it("IntelliJ style drops --line and the empty {line} when no line", () => {
		expect(
			applyArgvTemplate(["--line", "{line}", "{path}"], {
				...baseVars,
				line: "",
				col: "",
			}),
		).toEqual(["/repo/src/foo.ts"]);
	});

	it("IntelliJ style keeps --line and {line} when line is provided", () => {
		expect(
			applyArgvTemplate(["--line", "{line}", "{path}"], {
				...baseVars,
				col: "",
			}),
		).toEqual(["--line", "42", "/repo/src/foo.ts"]);
	});

	it("Neovim-in-tmux style with no line drops +{line}", () => {
		expect(
			applyArgvTemplate(["new-window", "nvim", "+{line}", "{path}"], {
				...baseVars,
				line: "",
				col: "",
			}),
		).toEqual(["new-window", "nvim", "/repo/src/foo.ts"]);
	});

	it("Neovim-in-tmux style with line keeps +{line}", () => {
		expect(
			applyArgvTemplate(["new-window", "nvim", "+{line}", "{path}"], {
				...baseVars,
				col: "",
			}),
		).toEqual(["new-window", "nvim", "+42", "/repo/src/foo.ts"]);
	});

	it("preserves preceding non-flag tokens when value is empty", () => {
		// `nvim` doesn't look like a flag, so it stays even though the
		// adjacent {line} is empty. Only `-x`/`--xxx` style flags are
		// dropped alongside their now-empty value.
		expect(
			applyArgvTemplate(["nvim", "{line}", "{path}"], {
				...baseVars,
				line: "",
			}),
		).toEqual(["nvim", "/repo/src/foo.ts"]);
	});

	it("substitutes {cwd}", () => {
		expect(applyArgvTemplate(["{cwd}"], baseVars)).toEqual(["/repo"]);
	});

	it("does not strip colons inside a path that contains them", () => {
		// If the user has a literal path with a trailing colon (rare,
		// but possible) and no placeholder at the tail, we leave it
		// alone — only trailing-placeholder-empty triggers trimming.
		expect(
			applyArgvTemplate(["literal:trailing:"], {
				...baseVars,
				line: "",
				col: "",
			}),
		).toEqual(["literal:trailing:"]);
	});
});
