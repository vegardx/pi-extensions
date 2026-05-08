/**
 * URL validation for webfetch — guards against SSRF and data exfiltration.
 *
 * Defends against:
 * - Non-HTTP schemes (file://, ftp://, etc.)
 * - Loopback addresses (127.0.0.0/8, ::1)
 * - Private networks (10/8, 172.16/12, 192.168/16, fc00::/7)
 * - Link-local addresses (169.254/16 — includes cloud metadata)
 * - Multicast / reserved ranges
 *
 * URLs that pass validation are still fetched against the public internet —
 * but a malicious actor cannot use them to reach internal services.
 */

import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

export class UrlValidationError extends Error {
	constructor(
		message: string,
		public readonly reason:
			| "scheme"
			| "syntax"
			| "private-ip"
			| "loopback"
			| "link-local"
			| "multicast"
			| "dns-failed"
			| "blocked-host",
	) {
		super(message);
		this.name = "UrlValidationError";
	}
}

export interface ValidateOptions {
	/**
	 * Optional allowlist of hostnames. When set, only URLs whose host
	 * (case-insensitive, exact match or subdomain) appear in the list pass.
	 * When unset, any public URL passes.
	 */
	allowedHosts?: readonly string[];
	/** Override the DNS resolver — used in tests. */
	_resolver?: { resolve4(hostname: string): Promise<string[]> };
}

/** Parse a URL string. Throws UrlValidationError on syntax/scheme issues. */
export function parseUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new UrlValidationError(`invalid URL: ${input}`, "syntax");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new UrlValidationError(
			`only http/https URLs are allowed (got ${url.protocol})`,
			"scheme",
		);
	}
	return url;
}

/**
 * Validate that a URL's hostname does not resolve to a private/internal
 * address. Performs DNS resolution to catch DNS rebinding and indirect
 * references like `localhost.example.com` pointing at 127.0.0.1.
 *
 * Returns the validated URL (parsed). Throws UrlValidationError on failure.
 */
export async function validateUrl(
	input: string,
	options: ValidateOptions = {},
): Promise<URL> {
	const url = parseUrl(input);

	// Allowlist check (case-insensitive, supports exact and subdomain match).
	if (options.allowedHosts && options.allowedHosts.length > 0) {
		const host = url.hostname.toLowerCase();
		const allowed = options.allowedHosts.some((h) => {
			const allow = h.toLowerCase();
			return host === allow || host.endsWith(`.${allow}`);
		});
		if (!allowed) {
			throw new UrlValidationError(
				`host not in allowlist: ${url.hostname}`,
				"blocked-host",
			);
		}
	}

	// If hostname is already an IP literal, validate directly.
	if (isIP(url.hostname)) {
		assertIpIsPublic(url.hostname);
		return url;
	}

	// Block obvious special hostnames before DNS lookup.
	const lcHost = url.hostname.toLowerCase();
	if (
		lcHost === "localhost" ||
		lcHost === "ip6-localhost" ||
		lcHost === "ip6-loopback" ||
		lcHost.endsWith(".localhost") ||
		lcHost.endsWith(".local") ||
		lcHost.endsWith(".internal")
	) {
		throw new UrlValidationError(
			`blocked hostname: ${url.hostname}`,
			"loopback",
		);
	}

	// Resolve DNS and validate every returned address.
	let addresses: string[];
	try {
		const resolver = options._resolver ?? new Resolver();
		addresses = await resolver.resolve4(url.hostname);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new UrlValidationError(
			`DNS resolution failed for ${url.hostname}: ${msg}`,
			"dns-failed",
		);
	}

	if (addresses.length === 0) {
		throw new UrlValidationError(
			`no addresses for ${url.hostname}`,
			"dns-failed",
		);
	}

	for (const addr of addresses) {
		assertIpIsPublic(addr);
	}

	return url;
}

/** Throw if an IP address is in a private/internal/reserved range. */
export function assertIpIsPublic(ip: string): void {
	const version = isIP(ip);
	if (version === 4) {
		assertIpv4Public(ip);
	} else if (version === 6) {
		assertIpv6Public(ip);
	} else {
		throw new UrlValidationError(`not an IP address: ${ip}`, "syntax");
	}
}

function assertIpv4Public(ip: string): void {
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
	if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
		throw new UrlValidationError(`malformed IPv4: ${ip}`, "syntax");
	}
	const [a, b] = parts;

	// 0.0.0.0/8 — "this network"
	if (a === 0) {
		throw new UrlValidationError(`reserved IPv4: ${ip}`, "private-ip");
	}
	// 10.0.0.0/8 — private
	if (a === 10) {
		throw new UrlValidationError(`private IPv4: ${ip}`, "private-ip");
	}
	// 100.64.0.0/10 — carrier-grade NAT
	if (a === 100 && b >= 64 && b <= 127) {
		throw new UrlValidationError(`CGNAT IPv4: ${ip}`, "private-ip");
	}
	// 127.0.0.0/8 — loopback
	if (a === 127) {
		throw new UrlValidationError(`loopback IPv4: ${ip}`, "loopback");
	}
	// 169.254.0.0/16 — link-local (includes AWS/GCP metadata at 169.254.169.254)
	if (a === 169 && b === 254) {
		throw new UrlValidationError(`link-local IPv4: ${ip}`, "link-local");
	}
	// 172.16.0.0/12 — private
	if (a === 172 && b >= 16 && b <= 31) {
		throw new UrlValidationError(`private IPv4: ${ip}`, "private-ip");
	}
	// 192.168.0.0/16 — private
	if (a === 192 && b === 168) {
		throw new UrlValidationError(`private IPv4: ${ip}`, "private-ip");
	}
	// 192.0.0.0/24 — IETF protocol assignments
	if (a === 192 && b === 0 && parts[2] === 0) {
		throw new UrlValidationError(`reserved IPv4: ${ip}`, "private-ip");
	}
	// 198.18.0.0/15 — benchmarking
	if (a === 198 && (parts[1] === 18 || parts[1] === 19)) {
		throw new UrlValidationError(`benchmarking IPv4: ${ip}`, "private-ip");
	}
	// 224.0.0.0/4 — multicast
	if (a >= 224 && a <= 239) {
		throw new UrlValidationError(`multicast IPv4: ${ip}`, "multicast");
	}
	// 240.0.0.0/4 — reserved
	if (a >= 240) {
		throw new UrlValidationError(`reserved IPv4: ${ip}`, "private-ip");
	}
}

function assertIpv6Public(ip: string): void {
	const lower = ip.toLowerCase();
	// Loopback
	if (lower === "::1" || lower === "::") {
		throw new UrlValidationError(`loopback IPv6: ${ip}`, "loopback");
	}
	// Link-local fe80::/10
	if (
		lower.startsWith("fe80:") ||
		lower.startsWith("fe8") ||
		/^fe[89ab]/i.test(lower)
	) {
		throw new UrlValidationError(`link-local IPv6: ${ip}`, "link-local");
	}
	// Unique-local fc00::/7
	if (/^f[cd]/i.test(lower)) {
		throw new UrlValidationError(`unique-local IPv6: ${ip}`, "private-ip");
	}
	// Multicast ff00::/8
	if (lower.startsWith("ff")) {
		throw new UrlValidationError(`multicast IPv6: ${ip}`, "multicast");
	}
	// IPv4-mapped (::ffff:a.b.c.d) — re-validate as IPv4
	const v4MappedMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4MappedMatch) {
		assertIpv4Public(v4MappedMatch[1]);
	}
}
