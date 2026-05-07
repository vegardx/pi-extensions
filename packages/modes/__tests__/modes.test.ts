import { isSafeCommand } from "@vegardx/pi-extensions-shared/plan-utils.js";
import {
	deriveBranchName,
	deriveIssueTitle,
	derivePrefix,
	sanitizeSlug,
	scanForSecrets,
	slugify,
} from "../helpers.js";

// isSafeCommand is shared from _shared/plan-utils — a smoke test to confirm
// the import path resolves correctly from modes.
describe("isSafeCommand (from _shared)", () => {
	it("allows read-only commands", () => {
		expect(isSafeCommand("git log --oneline -10")).toBe(true);
		expect(isSafeCommand("rg 'foo' src/")).toBe(true);
		expect(isSafeCommand("cat package.json")).toBe(true);
	});

	it("blocks write commands", () => {
		expect(isSafeCommand("rm -rf dist/")).toBe(false);
		expect(isSafeCommand("git commit -m 'wip'")).toBe(false);
	});

	it("blocks bash redirects", () => {
		expect(isSafeCommand("echo hello > out.txt")).toBe(false);
		expect(isSafeCommand("echo hello >> out.txt")).toBe(false);
		expect(isSafeCommand("cat foo | tee bar.txt")).toBe(false);
	});
});

describe("slugify", () => {
	it("produces kebab-case from a description", () => {
		expect(slugify("add payment webhooks")).toBe("add-payment-webhooks");
	});

	it("caps at maxTokens", () => {
		const result = slugify("one two three four five six seven", {
			maxTokens: 3,
		});
		expect(result.split("-").length).toBeLessThanOrEqual(3);
	});
});

describe("sanitizeSlug", () => {
	it("strips wrapping quotes", () => {
		expect(sanitizeSlug('"add-payment-webhooks"')).toBe("add-payment-webhooks");
	});

	it("strips backticks", () => {
		expect(sanitizeSlug("`add-payment-webhooks`")).toBe("add-payment-webhooks");
	});
});

describe("derivePrefix", () => {
	it("returns fix/ for bug descriptions", () => {
		expect(derivePrefix("fix the auth bug")).toBe("fix/");
	});

	it("returns refactor/ for refactor descriptions", () => {
		expect(derivePrefix("refactor the payment module")).toBe("refactor/");
	});

	it("returns docs/ for documentation descriptions", () => {
		expect(derivePrefix("update the readme")).toBe("docs/");
	});

	it("returns feat/ as default", () => {
		expect(derivePrefix("something completely new")).toBe("feat/");
	});
});

describe("deriveBranchName", () => {
	it("combines prefix and slug", () => {
		expect(deriveBranchName("fix the login crash")).toBe(
			"fix/fix-the-login-crash",
		);
	});

	it("returns empty string for empty input", () => {
		expect(deriveBranchName("")).toBe("");
	});
});

describe("deriveIssueTitle", () => {
	it("returns the first line of plan text", () => {
		expect(
			deriveIssueTitle("Add payment webhooks\n\nStep 1...", "fallback"),
		).toBe("Add payment webhooks");
	});

	it("falls back to the fallback when plan text is empty", () => {
		expect(deriveIssueTitle("", "fallback title")).toBe("fallback title");
	});

	it("truncates long titles", () => {
		const long = "a".repeat(80);
		const result = deriveIssueTitle(long, "fallback");
		expect(result.length).toBeLessThanOrEqual(72);
		expect(result.endsWith("\u2026")).toBe(true);
	});
});

describe("scanForSecrets", () => {
	it("returns hasSecret: false for clean text", () => {
		expect(
			scanForSecrets("This is a clean plan with no secrets.").hasSecret,
		).toBe(false);
	});

	it("detects GitHub PATs", () => {
		expect(
			scanForSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890")
				.hasSecret,
		).toBe(true);
	});

	it("detects Anthropic API keys", () => {
		expect(
			scanForSecrets("key: sk-ant-abcdefghijklmnopqrstuvwxyz12345678")
				.hasSecret,
		).toBe(true);
	});
});
