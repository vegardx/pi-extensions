import {
	assertIpIsPublic,
	parseUrl,
	UrlValidationError,
	validateUrl,
} from "../validate.js";

function makeResolver(map: Record<string, string[]>) {
	return {
		async resolve4(host: string) {
			const result = map[host];
			if (!result) throw new Error(`no DNS entry for ${host}`);
			return result;
		},
	};
}

describe("parseUrl", () => {
	it("accepts http and https", () => {
		expect(parseUrl("http://example.com").protocol).toBe("http:");
		expect(parseUrl("https://example.com").protocol).toBe("https:");
	});

	it("rejects file://", () => {
		expect(() => parseUrl("file:///etc/passwd")).toThrow(UrlValidationError);
	});

	it("rejects ftp://", () => {
		expect(() => parseUrl("ftp://example.com")).toThrow(UrlValidationError);
	});

	it("rejects javascript:", () => {
		expect(() => parseUrl("javascript:alert(1)")).toThrow(UrlValidationError);
	});

	it("rejects malformed URLs", () => {
		expect(() => parseUrl("not-a-url")).toThrow(UrlValidationError);
	});
});

describe("assertIpIsPublic — IPv4", () => {
	it("allows public addresses", () => {
		expect(() => assertIpIsPublic("8.8.8.8")).not.toThrow();
		expect(() => assertIpIsPublic("1.1.1.1")).not.toThrow();
		expect(() => assertIpIsPublic("140.82.121.4")).not.toThrow(); // github.com
	});

	it("blocks loopback (127.0.0.0/8)", () => {
		expect(() => assertIpIsPublic("127.0.0.1")).toThrow(/loopback/);
		expect(() => assertIpIsPublic("127.255.255.255")).toThrow(/loopback/);
	});

	it("blocks private 10/8", () => {
		expect(() => assertIpIsPublic("10.0.0.1")).toThrow(/private/);
		expect(() => assertIpIsPublic("10.255.255.255")).toThrow(/private/);
	});

	it("blocks private 172.16/12", () => {
		expect(() => assertIpIsPublic("172.16.0.1")).toThrow(/private/);
		expect(() => assertIpIsPublic("172.31.255.255")).toThrow(/private/);
		// 172.15 and 172.32 are public
		expect(() => assertIpIsPublic("172.15.0.1")).not.toThrow();
		expect(() => assertIpIsPublic("172.32.0.1")).not.toThrow();
	});

	it("blocks private 192.168/16", () => {
		expect(() => assertIpIsPublic("192.168.0.1")).toThrow(/private/);
		expect(() => assertIpIsPublic("192.168.255.255")).toThrow(/private/);
	});

	it("blocks link-local (169.254/16) including AWS metadata", () => {
		expect(() => assertIpIsPublic("169.254.169.254")).toThrow(/link-local/);
		expect(() => assertIpIsPublic("169.254.0.1")).toThrow(/link-local/);
	});

	it("blocks 0.0.0.0/8", () => {
		expect(() => assertIpIsPublic("0.0.0.0")).toThrow();
	});

	it("blocks CGNAT (100.64/10)", () => {
		expect(() => assertIpIsPublic("100.64.0.1")).toThrow(/CGNAT/);
		expect(() => assertIpIsPublic("100.127.255.255")).toThrow(/CGNAT/);
	});

	it("blocks multicast (224/4)", () => {
		expect(() => assertIpIsPublic("224.0.0.1")).toThrow(/multicast/);
		expect(() => assertIpIsPublic("239.255.255.255")).toThrow(/multicast/);
	});

	it("blocks reserved (240/4)", () => {
		expect(() => assertIpIsPublic("240.0.0.1")).toThrow();
	});
});

describe("assertIpIsPublic — IPv6", () => {
	it("allows public addresses", () => {
		expect(() => assertIpIsPublic("2001:4860:4860::8888")).not.toThrow();
	});

	it("blocks loopback ::1", () => {
		expect(() => assertIpIsPublic("::1")).toThrow(/loopback/);
	});

	it("blocks link-local fe80::/10", () => {
		expect(() => assertIpIsPublic("fe80::1")).toThrow(/link-local/);
	});

	it("blocks unique-local fc00::/7", () => {
		expect(() => assertIpIsPublic("fc00::1")).toThrow(/unique-local/);
		expect(() => assertIpIsPublic("fd00::1")).toThrow(/unique-local/);
	});

	it("blocks multicast ff00::/8", () => {
		expect(() => assertIpIsPublic("ff02::1")).toThrow(/multicast/);
	});

	it("blocks IPv4-mapped private addresses", () => {
		expect(() => assertIpIsPublic("::ffff:127.0.0.1")).toThrow(/loopback/);
		expect(() => assertIpIsPublic("::ffff:10.0.0.1")).toThrow(/private/);
	});
});

describe("validateUrl", () => {
	it("blocks localhost hostname", async () => {
		await expect(validateUrl("http://localhost/admin")).rejects.toThrow(
			/blocked hostname/,
		);
	});

	it("blocks .local mDNS", async () => {
		await expect(validateUrl("http://printer.local/")).rejects.toThrow(
			/blocked hostname/,
		);
	});

	it("blocks .internal", async () => {
		await expect(validateUrl("http://service.internal/")).rejects.toThrow(
			/blocked hostname/,
		);
	});

	it("blocks IP literal pointing at loopback", async () => {
		await expect(validateUrl("http://127.0.0.1/admin")).rejects.toThrow(
			/loopback/,
		);
	});

	it("blocks IP literal pointing at AWS metadata", async () => {
		await expect(
			validateUrl("http://169.254.169.254/latest/meta-data/"),
		).rejects.toThrow(/link-local/);
	});

	it("resolves DNS and blocks if it points to a private IP", async () => {
		const resolver = makeResolver({
			"sneaky.example.com": ["10.0.0.5"],
		});
		await expect(
			validateUrl("http://sneaky.example.com/", { _resolver: resolver }),
		).rejects.toThrow(/private/);
	});

	it("resolves DNS and blocks if any returned IP is private", async () => {
		const resolver = makeResolver({
			"mixed.example.com": ["8.8.8.8", "10.0.0.5"],
		});
		await expect(
			validateUrl("http://mixed.example.com/", { _resolver: resolver }),
		).rejects.toThrow(/private/);
	});

	it("allows public DNS resolution", async () => {
		const resolver = makeResolver({
			"example.com": ["93.184.216.34"],
		});
		const url = await validateUrl("https://example.com/", {
			_resolver: resolver,
		});
		expect(url.hostname).toBe("example.com");
	});

	it("respects allowlist (exact match)", async () => {
		const resolver = makeResolver({
			"example.com": ["93.184.216.34"],
			"evil.com": ["93.184.216.35"],
		});
		await expect(
			validateUrl("https://example.com/", {
				allowedHosts: ["example.com"],
				_resolver: resolver,
			}),
		).resolves.toBeDefined();
		await expect(
			validateUrl("https://evil.com/", {
				allowedHosts: ["example.com"],
				_resolver: resolver,
			}),
		).rejects.toThrow(/allowlist/);
	});

	it("respects allowlist (subdomain match)", async () => {
		const resolver = makeResolver({
			"docs.example.com": ["93.184.216.34"],
		});
		await expect(
			validateUrl("https://docs.example.com/", {
				allowedHosts: ["example.com"],
				_resolver: resolver,
			}),
		).resolves.toBeDefined();
	});

	it("allowlist is case-insensitive", async () => {
		const resolver = makeResolver({
			"example.com": ["93.184.216.34"],
		});
		await expect(
			validateUrl("https://EXAMPLE.com/", {
				allowedHosts: ["example.com"],
				_resolver: resolver,
			}),
		).resolves.toBeDefined();
	});

	it("rejects DNS lookup failures", async () => {
		const resolver = makeResolver({});
		await expect(
			validateUrl("https://nonexistent.example/", { _resolver: resolver }),
		).rejects.toThrow(/DNS resolution failed/);
	});
});
