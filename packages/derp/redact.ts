/**
 * Secret + internal-host redaction for /derp.
 *
 * Public issues are public. We fail closed: any detector hit on
 * either the input context or the polished output causes /derp to
 * abort and stash the raw report to disk for the user to review by
 * hand. The redactor is therefore not really used to *replace*
 * secrets in flight — its replacements are insurance for the
 * stashed file. The hits are what gates the file/no-file decision.
 *
 * Defense in depth — we run this on:
 *   1. The user's typed text and every captured-context field
 *      (statusShort, cwd, branch, sessionFile path, recent entries),
 *      before they're handed to the polish subagent.
 *   2. The polished title + body, before they're handed to gh.
 *
 * Both passes feed into the same fail-closed check. The system
 * prompt tells the subagent to refuse secret-shaped content, but we
 * don't trust LLMs with this — the regex detector is authoritative.
 */

export interface RedactHit {
	/** Detector category: `secret-token`, `auth-header`, `private-key`, `env-secret`, `internal-host`. */
	kind: string;
	/** First 16 chars of the matched substring, for the warning message. Never log the full match. */
	sample: string;
}

export interface RedactResult {
	text: string;
	hits: RedactHit[];
}

interface Detector {
	kind: string;
	pattern: RegExp;
	/**
	 * How to render the replacement. `kind` is substituted as a
	 * placeholder so the output reads `[REDACTED:secret-token]`.
	 * `groups` lets the env-secret detector keep the var name.
	 */
	replace: (match: string, ...groups: string[]) => string;
}

const REDACTED = (kind: string) => `[REDACTED:${kind}]`;

// Order matters: more specific patterns run first so a JWT inside an
// `Authorization: bearer …` header is still attributed to
// `auth-header` rather than double-tagged.
const DETECTORS: Detector[] = [
	{
		kind: "private-key",
		// PEM blocks span multiple lines. Single hit per block.
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		replace: () => REDACTED("private-key"),
	},
	{
		kind: "auth-header",
		pattern: /(authorization:\s*bearer\s+)(?!\[REDACTED)\S+/gi,
		replace: (_m, prefix: string) => `${prefix}${REDACTED("auth-header")}`,
	},
	{
		kind: "auth-header",
		pattern: /(x-api-key:\s*)(?!\[REDACTED)\S+/gi,
		replace: (_m, prefix: string) => `${prefix}${REDACTED("auth-header")}`,
	},
	{
		kind: "env-secret",
		// VAR_NAME=value where the var name contains KEY/TOKEN/SECRET/etc.
		// Keep the var name so the bug report still makes sense; strip
		// the value. The negative lookahead keeps a second pass
		// idempotent when the value is already `[REDACTED:...]`.
		pattern:
			/^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY)[A-Z0-9_]*)\s*=\s*(?!\[REDACTED)(\S+)$/gim,
		replace: (_m, name: string) => `${name}=${REDACTED("env-secret")}`,
	},
	{
		kind: "secret-token",
		// GitHub PATs and friends — the prefix is enough to identify them.
		pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
		replace: () => REDACTED("secret-token"),
	},
	{
		kind: "secret-token",
		// Slack tokens.
		pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
		replace: () => REDACTED("secret-token"),
	},
	{
		kind: "secret-token",
		// AWS access key id.
		pattern: /\bAKIA[0-9A-Z]{16}\b/g,
		replace: () => REDACTED("secret-token"),
	},
	{
		kind: "secret-token",
		// OpenAI/Anthropic style "sk-…".
		pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
		replace: () => REDACTED("secret-token"),
	},
	{
		kind: "secret-token",
		// JWT shape: three base64url segments separated by dots.
		pattern:
			/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
		replace: () => REDACTED("secret-token"),
	},
];

const SAFE_HOSTS = new Set(["github.com", "gitlab.com"]);

/**
 * Match any hostname whose suffix matches a known internal-network
 * pattern. We're conservative: the goal is to catch leaks of
 * corporate GHE / intranet hosts in URLs, file paths, and prose.
 */
const INTERNAL_HOST_PATTERN =
	/\b(?:[\w-]+\.)*[\w-]+\.(?:ghe\.com|internal\.[\w.-]+|intranet\.[\w.-]+|corp\.[\w.-]+|private\.[\w.-]+)\b/g;

function sample(match: string): string {
	const trimmed = match.replace(/\s+/g, " ").trim();
	return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 16)}…`;
}

function applyDetector(text: string, det: Detector): RedactResult {
	const hits: RedactHit[] = [];
	const out = text.replace(det.pattern, (...args) => {
		const match = args[0] as string;
		const groups = args.slice(1, args.length - 2) as string[];
		hits.push({ kind: det.kind, sample: sample(match) });
		return det.replace(match, ...groups);
	});
	return { text: out, hits };
}

function applyInternalHosts(text: string): RedactResult {
	const hits: RedactHit[] = [];
	const out = text.replace(INTERNAL_HOST_PATTERN, (match) => {
		if (SAFE_HOSTS.has(match.toLowerCase())) return match;
		hits.push({ kind: "internal-host", sample: sample(match) });
		return REDACTED("internal-host");
	});
	return { text: out, hits };
}

/**
 * Run every detector over `text`. Returns the cleaned text plus the
 * combined hit list. Idempotent: a second pass over already-redacted
 * text produces no additional hits.
 */
export function redact(text: string): RedactResult {
	let current = text;
	const hits: RedactHit[] = [];
	for (const det of DETECTORS) {
		const r = applyDetector(current, det);
		current = r.text;
		hits.push(...r.hits);
	}
	const internal = applyInternalHosts(current);
	current = internal.text;
	hits.push(...internal.hits);
	return { text: current, hits };
}

/**
 * Collapse absolute home-directory paths to `~/...`. Purely
 * cosmetic — usernames aren't strictly secret, but they're PII-ish
 * and reduce machine fingerprinting in public issues. Does NOT
 * produce hits and never blocks filing.
 *
 * `/Users/Shared/...` and `/home/shared/...` are preserved (those
 * paths don't contain a per-user identifier).
 */
export function redactHomePaths(text: string): string {
	return text
		.replace(/\/Users\/(?!Shared(?:\/|$))[^/\s]+/g, "~")
		.replace(/\/home\/(?!shared(?:\/|$))[^/\s]+/g, "~");
}

/**
 * Convenience: run `redact` then `redactHomePaths`. The home-path
 * pass never adds hits, so the returned `hits` come only from the
 * secret/internal detectors.
 */
export function redactFull(text: string): RedactResult {
	const r = redact(text);
	return { text: redactHomePaths(r.text), hits: r.hits };
}

/**
 * De-duplicate hits by `kind`, preserving order. Used when
 * summarising the warning notification — we want one mention per
 * category, not 12 of the same.
 */
export function summariseHitKinds(hits: readonly RedactHit[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const h of hits) {
		if (seen.has(h.kind)) continue;
		seen.add(h.kind);
		out.push(h.kind);
	}
	return out;
}
