import {
	deriveBranchName,
	deriveIssueTitle,
	derivePrefix,
	scanForSecrets,
	slugify,
} from "../helpers.js";

describe("derivePrefix", () => {
	it("picks fix/ for bug-ish verbs", () => {
		expect(derivePrefix("fix login crash on Safari")).toBe("fix/");
		expect(derivePrefix("resolve a bug in the cart")).toBe("fix/");
		expect(derivePrefix("patch the regression from last release")).toBe("fix/");
	});

	it("picks refactor/ for restructuring verbs", () => {
		expect(derivePrefix("refactor the auth module")).toBe("refactor/");
		expect(derivePrefix("simplify the billing pipeline")).toBe("refactor/");
	});

	it("picks docs/ for documentation verbs", () => {
		expect(derivePrefix("update the README with install steps")).toBe("docs/");
		expect(derivePrefix("add a migration guide for v2")).toBe("docs/");
	});

	it("picks chore/ for tooling verbs", () => {
		expect(derivePrefix("bump typescript to 5.5")).toBe("chore/");
		expect(derivePrefix("configure the CI matrix")).toBe("chore/");
	});

	it("picks feat/ by default", () => {
		expect(derivePrefix("something vague and undescribed")).toBe("feat/");
		expect(derivePrefix("add payment webhooks")).toBe("feat/");
	});

	it("matches whole words only", () => {
		// "doctor" must not trigger docs/ via its "doc" substring.
		expect(derivePrefix("integrate with the doctor service")).toBe("feat/");
		// "decimal" must not trigger chore/ via its "ci" substring.
		expect(derivePrefix("handle decimal currency inputs")).toBe("feat/");
	});

	it("prefers fix/ over feat/ when both signals are present", () => {
		// fix rules are checked before feat rules.
		expect(derivePrefix("add code to fix broken thing")).toBe("fix/");
	});
});

describe("slugify", () => {
	it("lowercases and kebab-cases alphanumerics", () => {
		expect(slugify("Add Payment Webhooks")).toBe("add-payment-webhooks");
	});

	it("drops non-alphanumerics", () => {
		expect(slugify("fix: `login` crash on ios!")).toBe(
			"fix-login-crash-on-ios",
		);
	});

	it("keeps at most 5 tokens", () => {
		expect(slugify("one two three four five six seven")).toBe(
			"one-two-three-four-five",
		);
	});

	it("caps at 50 characters", () => {
		const s = slugify("a".repeat(200));
		expect(s.length).toBeLessThanOrEqual(50);
	});

	it("returns empty string for empty / punctuation-only input", () => {
		expect(slugify("")).toBe("");
		expect(slugify("!!!...???")).toBe("");
	});
});

describe("deriveBranchName", () => {
	it("joins prefix + slug", () => {
		expect(deriveBranchName("add payment webhooks")).toBe(
			"feat/add-payment-webhooks",
		);
		expect(deriveBranchName("fix login crash on safari")).toBe(
			"fix/fix-login-crash-on-safari",
		);
		expect(deriveBranchName("refactor the auth module")).toBe(
			"refactor/refactor-the-auth-module",
		);
	});

	it("returns empty string when the description yields no slug", () => {
		expect(deriveBranchName("!!!")).toBe("");
	});
});

describe("scanForSecrets", () => {
	it("flags github pat prefixes", () => {
		expect(
			scanForSecrets("leak: ghp_abcdefghijklmnopqrstuvwxyz").hasSecret,
		).toBe(true);
		expect(
			scanForSecrets("api: sk-proj-abcdefghijklmnopqrstuvwxyz").hasSecret,
		).toBe(true);
	});

	it("flags aws access key ids", () => {
		expect(scanForSecrets("id=AKIAIOSFODNN7EXAMPLE more text").hasSecret).toBe(
			true,
		);
	});

	it("flags slack tokens", () => {
		// Use a pattern that matches the slack-token regex without being a
		// literal token that trips GitHub push protection.
		const fakeToken = [
			"xoxb",
			"1234567890",
			"ABCDEFGHIJKLMN",
			"abcdefghijklmnopqr",
		].join("-");
		expect(scanForSecrets(fakeToken).hasSecret).toBe(true);
	});

	it("flags long high-entropy runs", () => {
		// 40 base64url-ish chars triggers the high-entropy fallback.
		expect(
			scanForSecrets(`token = "${"a1B2c3D4e5".repeat(4)}"`).hasSecret,
		).toBe(true);
	});

	it("does not flag plain english prose", () => {
		expect(
			scanForSecrets(
				"Add payment webhooks. Refund flow needs to handle idempotency.",
			).hasSecret,
		).toBe(false);
	});

	it("does not flag normal branch / file names", () => {
		expect(scanForSecrets("feat/add-payment-webhooks").hasSecret).toBe(false);
	});
});

describe("deriveIssueTitle", () => {
	it("uses the first non-empty line when available", () => {
		expect(
			deriveIssueTitle("# Plan: add webhooks\nDetails...", "fallback"),
		).toBe("# Plan: add webhooks");
	});

	it("skips leading blank lines to find a usable title", () => {
		expect(deriveIssueTitle("\n\nother content", "add payment webhooks")).toBe(
			"other content",
		);
	});

	it("falls back when the description is entirely blank", () => {
		expect(deriveIssueTitle("   \n\n  ", "add payment webhooks")).toBe(
			"add payment webhooks",
		);
		expect(deriveIssueTitle("", "add payment webhooks")).toBe(
			"add payment webhooks",
		);
	});

	it("truncates at maxLength", () => {
		const long = "x".repeat(100);
		const title = deriveIssueTitle(long, "fb", 20);
		expect(title.length).toBe(20);
		expect(title.endsWith("…")).toBe(true);
	});
});
