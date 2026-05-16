import type { GitRunner } from "../git-origin.js";
import { parseOriginUrl, readOrigin, readOriginUrl } from "../git-origin.js";

const ok =
	(stdout: string): GitRunner =>
	() => ({
		status: 0,
		stdout,
		stderr: "",
	});
const fail: GitRunner = () => ({ status: 1, stdout: "", stderr: "fatal" });
const missing: GitRunner = () => ({
	status: null,
	stdout: "",
	stderr: "ENOENT",
});

describe("parseOriginUrl", () => {
	it("parses ssh url", () => {
		expect(parseOriginUrl("git@github.com:acme/widgets.git")).toEqual({
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			slug: "github.com/acme/widgets",
		});
	});

	it("parses https url with token", () => {
		expect(parseOriginUrl("https://x:tok@github.com/acme/widgets.git")).toEqual(
			{
				host: "github.com",
				owner: "acme",
				repo: "widgets",
				slug: "github.com/acme/widgets",
			},
		);
	});

	it("parses ghe ssh url", () => {
		expect(parseOriginUrl("git@dnb.ghe.com:org/some-repo.git")).toEqual({
			host: "dnb.ghe.com",
			owner: "org",
			repo: "some-repo",
			slug: "dnb.ghe.com/org/some-repo",
		});
	});

	it("returns null on garbage", () => {
		expect(parseOriginUrl("")).toBeNull();
		expect(parseOriginUrl("not a url")).toBeNull();
		expect(parseOriginUrl("https://")).toBeNull();
	});
});

describe("readOriginUrl", () => {
	it("returns trimmed url on success", () => {
		expect(readOriginUrl("/cwd", ok("git@github.com:a/b.git\n"))).toBe(
			"git@github.com:a/b.git",
		);
	});

	it("returns null on non-zero status", () => {
		expect(readOriginUrl("/cwd", fail)).toBeNull();
	});

	it("returns null on git missing (status null)", () => {
		expect(readOriginUrl("/cwd", missing)).toBeNull();
	});

	it("returns null on empty stdout", () => {
		expect(readOriginUrl("/cwd", ok(""))).toBeNull();
	});
});

describe("readOrigin", () => {
	it("composes url read + parse", () => {
		const r = readOrigin("/cwd", ok("git@github.com:a/b.git\n"));
		expect(r?.slug).toBe("github.com/a/b");
	});

	it("returns null when url missing", () => {
		expect(readOrigin("/cwd", fail)).toBeNull();
	});

	it("returns null when url unparseable", () => {
		expect(readOrigin("/cwd", ok("garbage\n"))).toBeNull();
	});
});
