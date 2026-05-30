/**
 * Bash command classifier for plan and ask modes.
 *
 * ⚠️  NOT A SECURITY BOUNDARY.
 *
 * This classifier steers the agent toward correct behaviour in restricted
 * modes (plan/ask). It is a best-effort heuristic — not a sandbox. A
 * determined user or a prompt-injected agent can trivially bypass it
 * (base64-encoded payloads, polyglot scripts, indirect invocation, etc.).
 *
 * Actual safety guarantees live outside this layer: host-level permissions,
 * container isolation, network policies, and the pi host's own tool
 * permission system. Do not rely on this classifier for security-critical
 * enforcement.
 *
 * Four-tier classification:
 *   1. Priority allowlist — unconditional bypass for trusted prefixes
 *      (e.g. `gh` CLI) whose arguments may contain words that trip the
 *      denylist (issue bodies, PR comments, search queries).
 *   2. Static denylist    — instant block for known-dangerous patterns.
 *   3. Static allowlist   — instant bypass for obviously safe commands.
 *   4. LLM classifier     — fast-tier model for ambiguous commands.
 *
 * When no fast model is configured, tiers 1–3 are the only gate.
 * The philosophy: plan mode means "no writes", not "no bash". Commands
 * that gather information (even via network or script execution) are
 * allowed; commands that mutate state are blocked.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";

export type BashVerdict = "allow" | "block" | "redirect";

export interface ClassifyResult {
	verdict: BashVerdict;
	/** Human-readable explanation surfaced to the agent when blocking or redirecting. */
	reason: string;
	/** The pi tool to use instead; only set when verdict is "redirect". */
	tool?: "read" | "grep" | "find" | "ls";
}

// ---- Priority allowlist -------------------------------------------------
//
// Checked BEFORE the denylist. These prefixes represent commands whose
// arguments (issue bodies, PR comments, search queries) routinely contain
// words that trip the denylist regexes ("rm", "DELETE", "kill", etc.).
// Because the commands themselves cannot mutate local state, we short-
// circuit them as safe regardless of argument content.

const PRIORITY_ALLOW_PREFIXES: readonly string[] = [
	// Read-only gh subcommands
	"gh pr list ",
	"gh pr view ",
	"gh pr diff ",
	"gh pr diff",
	"gh pr checks ",
	"gh pr checks",
	"gh pr status",
	"gh issue list ",
	"gh issue list",
	"gh issue view ",
	"gh issue status",
	"gh run list ",
	"gh run list",
	"gh run view ",
	"gh repo view ",
	"gh repo view",
	"gh auth status ",
	"gh auth status",
	"gh search ",
	// Remote coordination — intentionally allowed in plan mode.
	// These can't mutate local state; body content may contain deny words.
	"gh issue create ",
	"gh issue comment ",
	"gh issue edit ",
	"gh pr comment ",
];

// ---- Static allowlist ---------------------------------------------------
//
// Commands matching these patterns are allowed instantly without calling
// the LLM. All are read-only / information-gathering by nature.

const ALLOW_PREFIXES: readonly string[] = [
	"git log",
	"git show",
	"git diff",
	"git branch -a",
	"git branch -r",
	"git branch --list",
	"git branch -v",
	"git status",
	"git remote",
	"git rev-parse",
	"git symbolic-ref",
	"git merge-base",
	"git tag -l",
	"git tag --list",
	"git stash list",
	"git shortlog",
	"git blame",
	"git ls-files",
	"git ls-tree",
	"git cat-file",
	"wc ",
	"head ",
	"tail ",
	"which ",
	"type ",
	"stat ",
	"file ",
	"uname",
	"date",
	"pwd",
	"echo ",
	"printf ",
	"npm list",
	"npm view",
	"npm info",
	"npm show",
	"npm outdated",
	"npm ls",
	"npx tsc --noEmit",
	"npx biome check",
	"npx biome lint",
	"node --version",
	"npm --version",
	"jq ",
	"sort ",
	"uniq ",
	"cut ",
	"tr ",
	"diff ",
	"comm ",
	"du ",
	"df ",
	"env",
	"printenv",
];

/**
 * Commands that are unambiguously read-only based on the first token
 * (no prefix matching needed — the whole binary is safe).
 */
const ALLOW_BINARIES: readonly string[] = [
	"ls",
	// cat intentionally omitted — redirected to the read tool (see classifyStatic)
	"less",
	"more",
	"tree",
	"rg",
	"fd",
	"fzf",
	"bat",
	"exa",
	"eza",
	"tokei",
	"cloc",
	"scc",
	"dust",
	"duf",
	"hyperfine",
	"time",
	"realpath",
	"dirname",
	"basename",
	"readlink",
	"id",
	"whoami",
	"hostname",
	"nslookup",
	"dig",
	"host",
	"ping",
	"traceroute",
];

// ---- Static denylist ----------------------------------------------------
//
// Commands matching these patterns are blocked instantly. These represent
// mutations or destructive operations that should never run in plan mode.

const DENY_PATTERNS: readonly RegExp[] = [
	// File mutations
	/\b(rm|rmdir|unlink)\b/,
	/\b(mv|cp)\b/,
	/\bmkdir\b/,
	/\bchmod\b/,
	/\bchown\b/,
	/\bln\s/,
	// Redirects that write files
	/[^|]>\s*[^&]/,
	/>>/, // append
	/\btee\b/,
	// sed/awk in-place
	/\bsed\s.*-i\b/,
	/\bperl\s.*-[ip].*-e\b/,
	// Package managers (install/publish/remove)
	/\bnpm\s+(install|i|ci|uninstall|remove|publish|link|pack)\b/,
	/\byarn\s+(add|remove|install)\b/,
	/\bpnpm\s+(add|remove|install)\b/,
	/\bpip\s+install\b/,
	/\bbrew\s+(install|uninstall|remove|upgrade)\b/,
	/\bapt(-get)?\s+(install|remove|purge)\b/,
	// Git mutations
	/\bgit\s+(push|reset|rebase|merge|cherry-pick|commit|stash\s+(drop|pop|clear))\b/,
	/\bgit\s+(checkout|switch)\s+-[bB]\b/, // creating branches is a mutation
	/\bgit\s+clean\b/,
	/\bgit\s+tag\s+-[dfa]/,
	// gh PR mutations — modes owns these via /commit and /ship.
	// Read-only `gh pr list/view/diff/checks/status` are allowed via
	// PRIORITY_ALLOW_PREFIXES above; this catches the create/edit path.
	/\bgh\s+pr\s+(create|edit|merge|close|reopen|ready)\b/,
	// Docker/containers
	/\bdocker\s+(run|exec|rm|stop|kill|build|push|pull)\b/,
	/\bkubectl\s+(apply|delete|create|patch|edit|scale)\b/,
	// Dangerous general patterns
	/\bsudo\b/,
	/\b(kill|killall|pkill)\b/,
	/\bshutdown\b/,
	/\breboot\b/,
	// Database mutations
	/\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE)\b/i,
];

/**
 * Classify a command using only static rules. Returns null when the
 * command is ambiguous (neither clearly safe nor clearly dangerous) and
 * should be escalated to the LLM.
 *
 * Exported for testing.
 */
export function classifyStatic(command: string): ClassifyResult | null {
	const trimmed = command.trim();
	const firstToken = trimmed.split(/\s+/)[0] ?? "";

	// ---- Chain / substitution detection -----------------------------------
	// Must run before the priority allowlist so `gh pr list; rm -rf /` isn't
	// short-circuited by the trusted prefix.
	const hasChain = /[;|]|&&|\|\|/.test(trimmed);
	const hasSubstitution = /\$\(|`/.test(trimmed);

	if (hasChain) {
		const segments = trimmed.split(/\s*(?:&&|\|\||[;|])\s*/);
		for (const seg of segments) {
			const segResult = classifyStatic(seg.trim());
			if (segResult?.verdict === "block") return segResult;
		}
		// Surface a redirect if any segment prefers a pi tool (e.g. cat file | grep)
		for (const seg of segments) {
			const segResult = classifyStatic(seg.trim());
			if (segResult?.verdict === "redirect") return segResult;
		}
		// If no segment is blocked or redirected, check if any is ambiguous
		for (const seg of segments) {
			const segResult = classifyStatic(seg.trim());
			if (segResult === null) return null;
		}
		return { verdict: "allow", reason: "all chained commands are safe" };
	}

	if (hasSubstitution) {
		// Commands with substitutions are inherently ambiguous — defer to LLM.
		return null;
	}

	// ---- Priority allowlist ------------------------------------------------
	// Only checked for simple (non-chained, non-substituted) commands.
	// These prefixes are safe but their arguments may contain words that
	// trip the denylist (e.g. "rm" in an issue body).
	for (const prefix of PRIORITY_ALLOW_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			return { verdict: "allow", reason: "trusted command prefix" };
		}
	}

	// ---- Denylist ----------------------------------------------------------

	// Check denylist patterns against the full command
	for (const pattern of DENY_PATTERNS) {
		if (pattern.test(trimmed)) {
			return {
				verdict: "block",
				reason: `matches deny pattern: ${pattern.source.slice(0, 40)}`,
			};
		}
	}

	// Check for output redirects/tee
	if (
		/[^|]>\s*[^&]/.test(trimmed) ||
		/>>/.test(trimmed) ||
		/\btee\b/.test(trimmed)
	) {
		return {
			verdict: "block",
			reason: "output redirect writes to a file",
		};
	}

	// ---- Static redirects --------------------------------------------------
	// Checked before the allowlist so these binaries never slip through as
	// "allow" just because they are technically read-only.

	// cat reads file content — the built-in read tool is always better.
	if (firstToken === "cat") {
		return { verdict: "redirect", reason: "reads a file", tool: "read" };
	}

	// ---- Allowlist (only after denylist clears) ----------------------------

	// Check binary allowlist (just the command name, no args)
	if (ALLOW_BINARIES.includes(firstToken)) {
		return { verdict: "allow", reason: "read-only command" };
	}

	// Check prefix allowlist
	for (const prefix of ALLOW_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			return { verdict: "allow", reason: "read-only command" };
		}
	}

	// Ambiguous — needs LLM or defaults to allow
	return null;
}

// ---- LLM-based classification -------------------------------------------

const PROMPT = `You are a bash command safety classifier for a coding agent in PLAN mode.

Plan mode allows the agent to gather information for building a plan.
The agent may explore the codebase, run read-only scripts, fetch web pages,
query APIs, and execute tools that produce output without side effects.

The ONLY restriction: no commands that MUTATE state (write files, install
packages, push to git, modify databases, delete things).

Classify the command as exactly one of:
  "allow"    — information-gathering; does not mutate state
  "redirect" — the intent is better served by a pi tool (read/grep/find/ls)
  "block"    — mutates files, installs packages, pushes code, or is destructive

Respond with JSON only — no markdown, no explanation outside the JSON:
{"verdict":"allow"|"block"|"redirect","reason":"one sentence","tool":"read"|"grep"|"find"|"ls"|null}

Examples:
  git log --oneline -10                      → {"verdict":"allow","reason":"read-only git history","tool":null}
  cat src/index.ts                           → {"verdict":"redirect","reason":"reads a file","tool":"read"}
  cat package.json | grep -A3 'prepare'      → {"verdict":"redirect","reason":"reads a file","tool":"read"}
  grep -rn TODO src/                         → {"verdict":"allow","reason":"read-only text search","tool":null}
  find packages/foo -type f | sort           → {"verdict":"redirect","reason":"lists files in a directory","tool":"find"}
  curl -s https://api.example.com/docs       → {"verdict":"allow","reason":"fetches information from an API","tool":null}
  node search.js "query"                     → {"verdict":"allow","reason":"runs a script to gather information","tool":null}
  python3 -c "print(2+2)"                    → {"verdict":"allow","reason":"trivial computation, no side effects","tool":null}
  npx tsc --noEmit                           → {"verdict":"allow","reason":"type-checks without emitting files","tool":null}
  npm test                                   → {"verdict":"allow","reason":"runs tests to gather information","tool":null}
  npm install                                → {"verdict":"block","reason":"installs packages (mutates node_modules)","tool":null}
  echo hello > out.txt                       → {"verdict":"block","reason":"writes to a file","tool":null}
  git push origin main                       → {"verdict":"block","reason":"pushes code to remote","tool":null}
  rm -rf node_modules                        → {"verdict":"block","reason":"deletes files","tool":null}
  sed -i 's/foo/bar/' file.ts                → {"verdict":"block","reason":"edits a file in-place","tool":null}

Command: `;

/**
 * Parse the model's JSON response into a ClassifyResult.
 * Strips markdown code fences the model sometimes adds. Returns a
 * block result on any parsing failure.
 *
 * Exported so tests can drive the parser directly without a live model.
 */
export function parseClassifyResponse(raw: string): ClassifyResult {
	const cleaned = raw
		.trim()
		.replace(/^```(?:json)?\n?/, "")
		.replace(/\n?```\s*$/, "")
		.trim();

	try {
		const obj = JSON.parse(cleaned) as {
			verdict?: string;
			reason?: string;
			tool?: string | null;
		};

		if (
			obj.verdict !== "allow" &&
			obj.verdict !== "block" &&
			obj.verdict !== "redirect"
		) {
			return {
				verdict: "block",
				reason: "classifier returned invalid verdict",
			};
		}

		const tool: ClassifyResult["tool"] =
			obj.verdict === "redirect" &&
			(obj.tool === "read" ||
				obj.tool === "grep" ||
				obj.tool === "find" ||
				obj.tool === "ls")
				? (obj.tool as ClassifyResult["tool"])
				: undefined;

		return {
			verdict: obj.verdict,
			reason: typeof obj.reason === "string" ? obj.reason : "",
			tool,
		};
	} catch {
		return {
			verdict: "block",
			reason: "classifier response was not valid JSON",
		};
	}
}

/**
 * Hard ceiling on the Tier-3 LLM classifier call. The fast model should
 * answer in well under a second; if the provider stalls (network, auth,
 * rate-limit, a hung custom-provider endpoint) this bounds the wait so a
 * single ambiguous plan-mode bash command can't brick the session. On
 * timeout completeSimple rejects and the catch fails open to "allow" —
 * the static denylist has already blocked known-dangerous patterns.
 */
const CLASSIFIER_TIMEOUT_MS = 8000;

/**
 * Classify a bash command for plan mode.
 *
 * 1. Try the static allowlist/denylist (instant, no LLM needed).
 * 2. If ambiguous, try the LLM fast-tier classifier.
 * 3. If no LLM available, allow by default (the static denylist
 *    already caught known-dangerous commands).
 */
export async function classifyBashCommand(
	command: string,
	ctx: ExtensionContext,
): Promise<ClassifyResult> {
	// ---- Tier 1+2: static rules -----------------------------------------
	const staticResult = classifyStatic(command);
	if (staticResult) return staticResult;

	// ---- Tier 3: LLM classifier -----------------------------------------
	let resolved: Awaited<ReturnType<typeof resolveModel>>;
	try {
		resolved = await resolveModel(ctx, {
			name: "modes",
			tier: "fast",
			requireApiKey: true,
		});
	} catch {
		// No fast model available — allow (static denylist already caught
		// dangerous patterns; remaining ambiguous commands are likely safe).
		return {
			verdict: "allow",
			reason: "no classifier model available — static denylist passed",
		};
	}
	if (!resolved?.apiKey) {
		return {
			verdict: "allow",
			reason: "no classifier model available — static denylist passed",
		};
	}

	// Dynamic import so a missing @mariozechner/pi-ai doesn't crash at load time.
	let completeSimple: typeof import("@mariozechner/pi-ai")["completeSimple"];
	try {
		({ completeSimple } = await import("@mariozechner/pi-ai"));
	} catch {
		return {
			verdict: "allow",
			reason: "pi-ai unavailable — static denylist passed",
		};
	}

	const timeoutSignal = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
	const signal = ctx.signal
		? AbortSignal.any([ctx.signal, timeoutSignal])
		: timeoutSignal;

	try {
		const response = await completeSimple(
			resolved.model,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{ type: "text" as const, text: `${PROMPT}\`${command}\`` },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				// Tiny JSON verdict, but "minimal" reasoning can still emit a few
				// thinking tokens; 100 risked truncation → invalid JSON → a
				// spurious block. 512 leaves comfortable headroom.
				maxTokens: 512,
				reasoning: "minimal",
				signal,
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");

		return parseClassifyResponse(text);
	} catch {
		// LLM call failed — allow (static denylist already passed).
		return {
			verdict: "allow",
			reason: "classifier call failed — static denylist passed",
		};
	}
}
