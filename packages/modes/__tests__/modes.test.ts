import {
	deriveBranchName,
	deriveBranchNameWithModel,
	deriveIssueTitle,
	derivePrefix,
	descriptionFromLastAssistant,
	sanitizeSlug,
	scanForSecrets,
	slugify,
	slugifyWithModel,
} from "../helpers.js";

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

	it("does not false-positive on git hashes", () => {
		expect(
			scanForSecrets("commit abc123def456abc123def456abc123def456abc1")
				.hasSecret,
		).toBe(false);
	});

	it("does not false-positive on UUIDs", () => {
		expect(
			scanForSecrets("id: 550e8400e29b41d4a716446655440000").hasSecret,
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

	it("detects npm tokens", () => {
		expect(scanForSecrets("npm_abc123defghijklmnopqrst").hasSecret).toBe(true);
	});

	it("detects PEM blocks", () => {
		expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----").hasSecret).toBe(
			true,
		);
	});
});

// ---- slugifyWithModel -------------------------------------------------------

describe("slugifyWithModel", () => {
	const fakeCtx = {} as unknown as Parameters<typeof slugifyWithModel>[0];

	it("falls back to slugify() when no model resolves", async () => {
		const slug = await slugifyWithModel(
			fakeCtx,
			"add payment webhooks for checkout",
			{
				_resolveModel: async () => null,
				_complete: async () => {
					throw new Error("should not be called");
				},
			},
		);
		expect(slug).toBe("add-payment-webhooks-for-checkout");
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
			"add payment webhooks for checkout",
			{
				_resolveModel: async () => ({
					model: { provider: "x", id: "y" } as never,
					apiKey: "k",
				}),
				_complete: (async () => ({
					content: [{ type: "text", text: "add-payment-webhooks" }],
				})) as never,
			},
		);
		expect(slug).toBe("add-payment-webhooks");
	});

	it("falls back when the model returns garbage", async () => {
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

// ---- deriveBranchNameWithModel ----------------------------------------------

describe("deriveBranchNameWithModel", () => {
	const fakeCtx = {} as unknown as Parameters<
		typeof deriveBranchNameWithModel
	>[0];

	it("combines deterministic prefix with smart slug", async () => {
		const branch = await deriveBranchNameWithModel(
			fakeCtx,
			"fix login crash on safari",
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

	it("falls back to deterministic prefix+slug when no model", async () => {
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
		expect(branch).toMatch(/^feat\//);
		expect(branch.length).toBeGreaterThan(5);
	});
});

// ---- descriptionFromLastAssistant ------------------------------------------

describe("descriptionFromLastAssistant", () => {
	function fakeCtx(entries: unknown[]) {
		return {
			sessionManager: {
				getEntries: () => entries,
			},
		} as unknown as Parameters<typeof descriptionFromLastAssistant>[0];
	}

	it("returns null when no entries", () => {
		expect(descriptionFromLastAssistant(fakeCtx([]))).toBeNull();
	});

	it("returns null when no assistant messages", () => {
		const ctx = fakeCtx([
			{ type: "message", message: { role: "user", content: "hello" } },
		]);
		expect(descriptionFromLastAssistant(ctx)).toBeNull();
	});

	it("returns text from last assistant message (string content)", () => {
		const ctx = fakeCtx([
			{ type: "message", message: { role: "user", content: "ask" } },
			{
				type: "message",
				message: { role: "assistant", content: "Here is my plan." },
			},
		]);
		expect(descriptionFromLastAssistant(ctx)).toBe("Here is my plan.");
	});

	it("returns text from last assistant message (content array)", () => {
		const ctx = fakeCtx([
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Step one." },
						{ type: "text", text: "Step two." },
					],
				},
			},
		]);
		expect(descriptionFromLastAssistant(ctx)).toBe("Step one. Step two.");
	});

	it("returns null when assistant content is too short", () => {
		const ctx = fakeCtx([
			{ type: "message", message: { role: "assistant", content: "ok" } },
		]);
		expect(descriptionFromLastAssistant(ctx)).toBeNull();
	});
});
