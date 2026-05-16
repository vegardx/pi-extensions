import {
	redact,
	redactFull,
	redactHomePaths,
	summariseHitKinds,
} from "../redact.js";

describe("redact — secret-token", () => {
	it("flags GitHub PATs", () => {
		const r = redact("token: ghp_AbCdEf1234567890ZzYy please fix");
		expect(r.hits.map((h) => h.kind)).toContain("secret-token");
		expect(r.text).toContain("[REDACTED:secret-token]");
		expect(r.text).not.toContain("ghp_AbCdEf1234567890ZzYy");
	});

	it("flags github_pat_ tokens", () => {
		const r = redact("oops github_pat_11ABCDEFG0123456789ABCDE shipped");
		expect(r.hits.map((h) => h.kind)).toContain("secret-token");
	});

	it("flags AWS access keys", () => {
		const r = redact("set AKIAIOSFODNN7EXAMPLE in env");
		expect(r.hits.map((h) => h.kind)).toContain("secret-token");
	});

	it("flags Slack tokens", () => {
		const r = redact("slack: xoxb-1234567890-abcdef stable");
		expect(r.hits.map((h) => h.kind)).toContain("secret-token");
	});

	it("flags sk- API keys", () => {
		const r = redact("OPENAI=sk-proj_aBcDeFgHiJkLmNoPqRsTuVwXyZ end");
		expect(r.hits.map((h) => h.kind)).toContain("secret-token");
	});

	it("flags JWT-shaped strings", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiIsInR5cCI.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4f";
		const r = redact(`auth=${jwt}`);
		expect(r.hits.map((h) => h.kind)).toContain("secret-token");
	});

	it("does not flag innocuous prefixes", () => {
		const r = redact("the file ghpages.md is fine");
		expect(r.hits).toEqual([]);
	});
});

describe("redact — auth-header", () => {
	it("flags bearer tokens in headers", () => {
		const r = redact("Authorization: Bearer abc123def456ghi789");
		expect(r.hits.map((h) => h.kind)).toContain("auth-header");
		expect(r.text).toContain("[REDACTED:auth-header]");
		expect(r.text).toContain("Authorization:");
	});

	it("flags x-api-key headers", () => {
		const r = redact("x-api-key: super-secret-key-here");
		expect(r.hits.map((h) => h.kind)).toContain("auth-header");
	});
});

describe("redact — private-key", () => {
	it("flags a single PEM block as one hit", () => {
		const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3Q
abc
def
-----END RSA PRIVATE KEY-----`;
		const r = redact(`config:\n${pem}\n`);
		const keyHits = r.hits.filter((h) => h.kind === "private-key");
		expect(keyHits).toHaveLength(1);
		expect(r.text).not.toContain("MIIEpAIBAAKCAQEA");
	});
});

describe("redact — env-secret", () => {
	it("preserves the var name and strips the value", () => {
		const r = redact("DB_PASSWORD=hunter2");
		expect(r.hits.map((h) => h.kind)).toContain("env-secret");
		expect(r.text).toContain("DB_PASSWORD=");
		expect(r.text).not.toContain("hunter2");
	});

	it("matches API_KEY, SECRET, TOKEN suffixes", () => {
		expect(redact("FOO_API_KEY=abc123").hits.length).toBeGreaterThan(0);
		expect(redact("MY_SECRET_X=v").hits.length).toBeGreaterThan(0);
		expect(redact("AUTH_TOKEN=xx").hits.length).toBeGreaterThan(0);
	});

	it("does not flag unrelated env vars", () => {
		expect(redact("FOO_BAR=value").hits).toEqual([]);
		expect(redact("DATABASE_URL=postgres://localhost/db").hits).toEqual([]);
	});
});

describe("redact — internal-host", () => {
	it("flags GHE hostnames", () => {
		const r = redact("see https://dnb.ghe.com/org/repo/pull/1 for context");
		expect(r.hits.map((h) => h.kind)).toContain("internal-host");
		expect(r.text).toContain("[REDACTED:internal-host]");
	});

	it("flags .corp / .internal / .intranet / .private suffixes", () => {
		expect(redact("see jira.corp.acme.com").hits.length).toBeGreaterThan(0);
		expect(redact("see wiki.internal.acme.com").hits.length).toBeGreaterThan(0);
		expect(redact("see git.intranet.acme.com").hits.length).toBeGreaterThan(0);
		expect(redact("see svn.private.acme.com").hits.length).toBeGreaterThan(0);
	});

	it("allowlists github.com and gitlab.com", () => {
		expect(redact("https://github.com/owner/repo").hits).toEqual([]);
		expect(redact("https://gitlab.com/owner/repo").hits).toEqual([]);
	});
});

describe("redact — idempotence", () => {
	it("a second pass produces no additional hits", () => {
		const first = redact(
			"token=ghp_AbCdEf1234567890ZzYy and Authorization: Bearer xyz",
		);
		const second = redact(first.text);
		expect(second.hits).toEqual([]);
		expect(second.text).toBe(first.text);
	});
});

describe("redactHomePaths", () => {
	it("collapses /Users/<name>/... to ~/...", () => {
		expect(redactHomePaths("/Users/alice/src/foo")).toBe("~/src/foo");
	});

	it("collapses /home/<name>/... to ~/...", () => {
		expect(redactHomePaths("/home/alice/src/foo")).toBe("~/src/foo");
	});

	it("preserves /Users/Shared/...", () => {
		expect(redactHomePaths("/Users/Shared/things")).toBe(
			"/Users/Shared/things",
		);
	});

	it("does not produce hits", () => {
		// Deliberate sanity check — home-path collapse is cosmetic
		// only and must not block filing.
		const r = redactFull("/Users/alice/foo");
		expect(r.hits).toEqual([]);
		expect(r.text).toBe("~/foo");
	});
});

describe("summariseHitKinds", () => {
	it("dedupes by kind, preserving order", () => {
		const r = summariseHitKinds([
			{ kind: "secret-token", sample: "x" },
			{ kind: "secret-token", sample: "y" },
			{ kind: "internal-host", sample: "z" },
			{ kind: "secret-token", sample: "w" },
		]);
		expect(r).toEqual(["secret-token", "internal-host"]);
	});

	it("returns [] for empty input", () => {
		expect(summariseHitKinds([])).toEqual([]);
	});
});

describe("redact — sample length", () => {
	it("samples never exceed 17 chars (16 + ellipsis)", () => {
		const r = redact(
			"prefix ghp_AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaBB end",
		);
		for (const h of r.hits) {
			expect(h.sample.length).toBeLessThanOrEqual(17);
		}
	});
});
