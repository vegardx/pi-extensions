import {
	buildIntakePrompt,
	deriveBranchName,
	deriveBranchNameWithModel,
	deriveIssueTitle,
	derivePrefix,
	needsIntake,
	sanitizeSlug,
	scanForSecrets,
	slugify,
	slugifyWithModel,
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

describe("sanitizeSlug", () => {
	it("lowercases, drops punctuation, and joins with hyphens", () => {
		expect(sanitizeSlug("Add Payment Webhooks")).toBe("add-payment-webhooks");
	});

	it("strips wrapping ASCII and curly quotes", () => {
		expect(sanitizeSlug('"add-payment-webhooks"')).toBe("add-payment-webhooks");
		expect(sanitizeSlug("\u201Cadd payment webhooks\u201D")).toBe(
			"add-payment-webhooks",
		);
	});

	it("strips wrapping backticks and fenced code blocks", () => {
		expect(sanitizeSlug("`add-payment-webhooks`")).toBe("add-payment-webhooks");
		expect(sanitizeSlug("```add-payment-webhooks```")).toBe(
			"add-payment-webhooks",
		);
		expect(sanitizeSlug("```text\nadd-payment-webhooks\n```")).toBe(
			"add-payment-webhooks",
		);
	});

	it("keeps only the first line", () => {
		expect(sanitizeSlug("add-payment-webhooks\nignore this prose")).toBe(
			"add-payment-webhooks",
		);
	});

	it("caps at 5 tokens and 50 chars", () => {
		expect(sanitizeSlug("one two three four five six seven")).toBe(
			"one-two-three-four-five",
		);
		const long = sanitizeSlug("a".repeat(200));
		expect(long.length).toBeLessThanOrEqual(50);
	});

	it("returns empty string for empty / punctuation-only input", () => {
		expect(sanitizeSlug("")).toBe("");
		expect(sanitizeSlug("!!!...???")).toBe("");
	});

	it("respects custom maxTokens / maxLength", () => {
		expect(sanitizeSlug("one two three four five", { maxTokens: 3 })).toBe(
			"one-two-three",
		);
		expect(sanitizeSlug("one two three", { maxLength: 5 })).toBe("one-t");
	});
});

describe("needsIntake", () => {
	it("flags empty / one-token / punctuation-only inputs", () => {
		expect(needsIntake("")).toBe(true);
		expect(needsIntake("   ")).toBe(true);
		expect(needsIntake("!!!")).toBe(true);
		expect(needsIntake("webhooks")).toBe(true);
		expect(needsIntake("add webhooks")).toBe(true);
		expect(needsIntake("fix login bug now")).toBe(true);
	});

	it("passes inputs with 5+ alphanumeric tokens", () => {
		expect(needsIntake("add payment webhooks with idempotency support")).toBe(
			false,
		);
		expect(
			needsIntake("refactor the auth module to use the new session store"),
		).toBe(false);
	});
});

describe("buildIntakePrompt", () => {
	it("embeds the raw description verbatim when provided", () => {
		const out = buildIntakePrompt("fix login");
		expect(out).toContain("INTAKE");
		expect(out).toContain("develop_ready");
		expect(out).toContain("fix login");
	});

	it("handles empty input with a 'no arguments' note", () => {
		const out = buildIntakePrompt("");
		expect(out).toContain("INTAKE");
		expect(out).toContain("no arguments");
	});

	it("frames tools as read-only", () => {
		const out = buildIntakePrompt("anything");
		expect(out).toMatch(/read-only/i);
	});
});

describe("slugifyWithModel", () => {
	const fakeCtx = {} as unknown as Parameters<typeof slugifyWithModel>[0];

	it("falls back to slugify() when no model resolves", async () => {
		const slug = await slugifyWithModel(
			fakeCtx,
			"I think we can just remove the example extension",
			{
				_resolveModel: async () => null,
				_complete: async () => {
					throw new Error("should not be called");
				},
			},
		);
		expect(slug).toBe("i-think-we-can-just");
	});

	it("falls back when resolveModel throws", async () => {
		const slug = await slugifyWithModel(fakeCtx, "add payment webhooks", {
			_resolveModel: async () => {
				throw new Error("boom");
			},
			_complete: async () => {
				throw new Error("should not be called");
			},
		});
		expect(slug).toBe("add-payment-webhooks");
	});

	it("falls back when resolveModel returns no apiKey", async () => {
		const slug = await slugifyWithModel(fakeCtx, "add payment webhooks", {
			_resolveModel: async () => ({
				model: { provider: "x", id: "y" } as never,
				apiKey: undefined,
			}),
			_complete: async () => {
				throw new Error("should not be called");
			},
		});
		expect(slug).toBe("add-payment-webhooks");
	});

	it("uses the sanitized model output on a happy path", async () => {
		const slug = await slugifyWithModel(
			fakeCtx,
			"I think we can just remove the example extension",
			{
				_resolveModel: async () => ({
					model: { provider: "x", id: "y" } as never,
					apiKey: "k",
				}),
				_complete: (async () => ({
					content: [{ type: "text", text: "remove-example-extension" }],
				})) as never,
			},
		);
		expect(slug).toBe("remove-example-extension");
	});

	it("sanitizes wrapped / quoted model output", async () => {
		const slug = await slugifyWithModel(fakeCtx, "refactor the auth module", {
			_resolveModel: async () => ({
				model: { provider: "x", id: "y" } as never,
				apiKey: "k",
			}),
			_complete: (async () => ({
				content: [{ type: "text", text: '"`Refactor Auth Module`"' }],
			})) as never,
		});
		expect(slug).toBe("refactor-auth-module");
	});

	it("falls back when the model returns garbage that sanitizes to empty", async () => {
		const slug = await slugifyWithModel(fakeCtx, "add payment webhooks", {
			_resolveModel: async () => ({
				model: { provider: "x", id: "y" } as never,
				apiKey: "k",
			}),
			_complete: (async () => ({
				content: [{ type: "text", text: "!!!...???" }],
			})) as never,
		});
		expect(slug).toBe("add-payment-webhooks");
	});

	it("falls back when completeSimple throws", async () => {
		const slug = await slugifyWithModel(fakeCtx, "add payment webhooks", {
			_resolveModel: async () => ({
				model: { provider: "x", id: "y" } as never,
				apiKey: "k",
			}),
			_complete: (async () => {
				throw new Error("network down");
			}) as never,
		});
		expect(slug).toBe("add-payment-webhooks");
	});
});

describe("deriveBranchNameWithModel", () => {
	const fakeCtx = {} as unknown as Parameters<
		typeof deriveBranchNameWithModel
	>[0];

	it("combines deterministic prefix with smart slug", async () => {
		const branch = await deriveBranchNameWithModel(
			fakeCtx,
			"fix login crash on safari quickly",
			{
				_resolveModel: async () => ({
					model: { provider: "x", id: "y" } as never,
					apiKey: "k",
				}),
				_complete: (async () => ({
					content: [{ type: "text", text: "fix-safari-login-crash" }],
				})) as never,
			},
		);
		expect(branch).toBe("fix/fix-safari-login-crash");
	});

	it("returns empty string when slug is empty", async () => {
		const branch = await deriveBranchNameWithModel(fakeCtx, "!!!", {
			_resolveModel: async () => null,
			_complete: async () => {
				throw new Error("should not be called");
			},
		});
		expect(branch).toBe("");
	});

	it("falls back to deterministic slug when no model is available", async () => {
		const branch = await deriveBranchNameWithModel(
			fakeCtx,
			"add payment webhooks",
			{
				_resolveModel: async () => null,
				_complete: async () => {
					throw new Error("should not be called");
				},
			},
		);
		expect(branch).toBe("feat/add-payment-webhooks");
	});
});
