import {
	buildForkUrl,
	isSafeBranchName,
	isValidIssueNumber,
	parseTitleAndBody,
	summarisePlan,
} from "../helpers.js";

describe("parseTitleAndBody", () => {
	it("extracts a well-formed TITLE/BODY block", () => {
		const text = [
			"Here's the PR description:",
			"",
			"---TITLE---",
			"feat(auth): add OIDC login support",
			"---BODY---",
			"Adds OIDC via the existing auth handler.",
			"",
			"- new endpoint: /oidc/callback",
			"- docs updated",
			"",
			"Closes #42",
			"---END---",
			"",
			"Let me know if you want me to adjust anything.",
		].join("\n");
		const out = parseTitleAndBody(text);
		expect(out).not.toBeNull();
		expect(out?.title).toBe("feat(auth): add OIDC login support");
		expect(out?.body).toContain("OIDC via the existing auth handler");
		expect(out?.body).toContain("Closes #42");
	});

	it("returns null when TITLE is missing", () => {
		const text = "---BODY---\nhello\n---END---";
		expect(parseTitleAndBody(text)).toBeNull();
	});

	it("returns null when BODY is missing", () => {
		const text = "---TITLE---\nhello\n---END---";
		expect(parseTitleAndBody(text)).toBeNull();
	});

	it("returns null when END sentinel is missing", () => {
		const text = "---TITLE---\nhello\n---BODY---\nworld";
		expect(parseTitleAndBody(text)).toBeNull();
	});

	it("trims surrounding whitespace inside sections", () => {
		const text = "---TITLE---\n   foo   \n---BODY---\n\n  bar  \n\n---END---";
		const out = parseTitleAndBody(text);
		expect(out?.title).toBe("foo");
		expect(out?.body).toBe("bar");
	});
});

describe("isSafeBranchName", () => {
	it("accepts typical branch names", () => {
		expect(isSafeBranchName("feat/add-webhooks")).toBe(true);
		expect(isSafeBranchName("fix/login.crash")).toBe(true);
		expect(isSafeBranchName("docs_update")).toBe(true);
		expect(isSafeBranchName("v1.2.3")).toBe(true);
	});

	it("rejects shell metacharacters", () => {
		expect(isSafeBranchName("feat/foo;rm -rf /")).toBe(false);
		expect(isSafeBranchName("foo bar")).toBe(false); // space
		expect(isSafeBranchName("foo$bar")).toBe(false); // dollar
		expect(isSafeBranchName("foo`bar")).toBe(false); // backtick
		expect(isSafeBranchName("foo&bar")).toBe(false);
		expect(isSafeBranchName("foo|bar")).toBe(false);
	});

	it("rejects empty and whitespace-only strings", () => {
		expect(isSafeBranchName("")).toBe(false);
		expect(isSafeBranchName("   ")).toBe(false);
	});
});

describe("isValidIssueNumber", () => {
	it("accepts positive integers up to 7 digits", () => {
		expect(isValidIssueNumber("1")).toBe(true);
		expect(isValidIssueNumber("42")).toBe(true);
		expect(isValidIssueNumber("9999999")).toBe(true);
	});

	it("rejects zero, negatives, floats, and leading zeros", () => {
		expect(isValidIssueNumber("0")).toBe(false);
		expect(isValidIssueNumber("-1")).toBe(false);
		expect(isValidIssueNumber("1.5")).toBe(false);
		expect(isValidIssueNumber("01")).toBe(false);
	});

	it("rejects non-numeric and injection-flavoured input", () => {
		expect(isValidIssueNumber("abc")).toBe(false);
		expect(isValidIssueNumber("42;rm -rf /")).toBe(false);
		expect(isValidIssueNumber("")).toBe(false);
	});

	it("tolerates surrounding whitespace", () => {
		expect(isValidIssueNumber("  42 ")).toBe(true);
	});
});

describe("buildForkUrl", () => {
	it("swaps the path in SSH-style origins", () => {
		expect(buildForkUrl("git@github.com:upstream/repo.git", "fork/repo")).toBe(
			"git@github.com:fork/repo.git",
		);
		expect(
			buildForkUrl("git@dnb.ghe.com:org/project.git", "janedoe/project"),
		).toBe("git@dnb.ghe.com:janedoe/project.git");
	});

	it("swaps the path in HTTPS origins", () => {
		expect(
			buildForkUrl("https://github.com/upstream/repo.git", "fork/repo"),
		).toBe("https://github.com/fork/repo.git");
		expect(
			buildForkUrl("https://dnb.ghe.com/org/project.git", "janedoe/project"),
		).toBe("https://dnb.ghe.com/janedoe/project.git");
	});

	it("preserves missing .git suffix", () => {
		expect(buildForkUrl("https://github.com/upstream/repo", "fork/repo")).toBe(
			"https://github.com/fork/repo",
		);
	});

	it("returns null for unrecognised URL shapes", () => {
		expect(buildForkUrl("garbage", "fork/repo")).toBeNull();
		expect(buildForkUrl("", "fork/repo")).toBeNull();
	});
});

describe("summarisePlan", () => {
	it("grabs the first non-empty, non-header, non-fence line", () => {
		expect(
			summarisePlan(
				[
					"",
					"# Plan",
					"",
					"```bash",
					"stuff",
					"```",
					"",
					"Two commits: one for the fix, one for the docs.",
					"",
					"Details follow.",
				].join("\n"),
			),
		).toBe("Two commits: one for the fix, one for the docs.");
	});

	it("clips to maxLength with an ellipsis", () => {
		const long = `Here's a long ${"very ".repeat(30)}line about what's planned`;
		expect(summarisePlan(long, 40).length).toBe(40);
		expect(summarisePlan(long, 40).endsWith("…")).toBe(true);
	});

	it("falls back when nothing usable is found", () => {
		expect(summarisePlan("")).toBe("proposed commit plan");
		expect(summarisePlan("\n# only\n# headings\n")).toBe(
			"proposed commit plan",
		);
	});
});
