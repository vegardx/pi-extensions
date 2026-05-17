/**
 * Argv template substitution + path:line:col parsing for /editor.
 *
 * Pure module — no I/O, no spawn — so the substitution rules can be
 * exercised in isolation. The shell-out itself lives in `spawn.ts`.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface ParsedPathArg {
	/**
	 * Absolute filesystem path. When the user passed no argument, this
	 * is the session cwd; otherwise it's the resolved path (relative
	 * inputs are resolved against cwd).
	 */
	path: string;
	/**
	 * Line number as a string (so it slots into argv as-is). Empty
	 * string when the user did not supply `:line`.
	 */
	line: string;
	/** Column as a string. Empty when not supplied. */
	col: string;
}

/**
 * Parse `[path[:line[:col]]]` into `{ path, line, col }`. With no arg,
 * returns `{ path: cwd, line: "", col: "" }`.
 *
 * Rules:
 * - The trailing `:line:col` segments are matched right-to-left and
 *   ONLY when each segment is purely digits. So `Makefile:foo` keeps
 *   the whole string as the path (no line), and `weird:42:not-col`
 *   keeps `weird:42` as path with no line/col.
 * - Relative paths resolve against cwd; absolute paths pass through.
 *   Trailing whitespace in the argument is trimmed.
 */
export function parsePathArg(
	arg: string | undefined,
	cwd: string,
): ParsedPathArg {
	const trimmed = (arg ?? "").trim();
	if (trimmed.length === 0) {
		return { path: cwd, line: "", col: "" };
	}

	let pathPart = trimmed;
	let line = "";
	let col = "";

	// Right-to-left: peel `:digits` off twice. We insist on pure-digit
	// trailing segments so paths containing colons (rare on POSIX, but
	// possible) aren't accidentally split.
	const lastColonMatch = pathPart.match(/^(.*):(\d+)$/);
	if (lastColonMatch) {
		const inner = lastColonMatch[1];
		const innerColonMatch = inner.match(/^(.*):(\d+)$/);
		if (innerColonMatch) {
			pathPart = innerColonMatch[1];
			line = innerColonMatch[2];
			col = lastColonMatch[2];
		} else {
			pathPart = inner;
			line = lastColonMatch[2];
		}
	}

	const expanded = expandHome(pathPart);
	const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	return { path: resolved, line, col };
}

/**
 * Expand a leading `~/` (or bare `~`) to the user's home directory.
 * Without this, `/editor ~/foo.ts` would resolve to `<cwd>/~/foo.ts`,
 * which is almost never what the user meant.
 */
function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return p;
}

export interface ArgvTemplateVars {
	path: string;
	cwd: string;
	line: string;
	col: string;
}

const PLACEHOLDER_RE = /\{(path|cwd|line|col)\}/g;

/**
 * Substitute `{path}`, `{cwd}`, `{line}`, `{col}` placeholders into
 * each arg template. When `line` / `col` are empty, the result is
 * processed so missing values don't break the argv:
 *
 * - An arg whose placeholders ALL resolved to empty is dropped
 *   entirely (even if literal punctuation like `+` or `:` remains as
 *   residue). If the preceding arg looks like a flag (`-x` / `--xxx`),
 *   the flag is dropped too — covers IntelliJ-style `["--line",
 *   "{line}", "{path}"]` and Vim-style `["+{line}", "{path}"]` where
 *   a no-line call should not leak `--line ` or `+`.
 * - Trailing colons left over from `{path}:{line}:{col}` are trimmed
 *   when the trailing placeholder(s) resolved empty. Covers VS Code
 *   style `["-g", "{path}:{line}:{col}"]` where a no-line call
 *   should send `<path>` (not `<path>::`).
 *
 * Args that contain no placeholders pass through unchanged.
 */
export function applyArgvTemplate(
	template: readonly string[],
	vars: ArgvTemplateVars,
): string[] {
	const out: string[] = [];
	for (const arg of template) {
		const placeholders = [...arg.matchAll(PLACEHOLDER_RE)];
		const placeholderValues = placeholders.map(
			(m) => vars[m[1] as keyof ArgvTemplateVars] ?? "",
		);
		const hasPlaceholders = placeholders.length > 0;
		const allPlaceholdersEmpty =
			hasPlaceholders && placeholderValues.every((v) => v.length === 0);

		const lastPlaceholder = placeholders[placeholders.length - 1];
		const trailingPlaceholderEmpty =
			hasPlaceholders &&
			lastPlaceholder?.index !== undefined &&
			lastPlaceholder.index + lastPlaceholder[0].length === arg.length &&
			(vars[lastPlaceholder[1] as keyof ArgvTemplateVars] ?? "").length === 0;

		const substituted = arg.replace(PLACEHOLDER_RE, (_, key: string) => {
			return vars[key as keyof ArgvTemplateVars] ?? "";
		});

		// Drop the arg when (a) substitution emptied it OR (b) it had
		// placeholders and they all resolved empty (the residual literal
		// punctuation, e.g. `+` or `:`, is meaningless without a value).
		if (substituted.length === 0 || allPlaceholdersEmpty) {
			const prev = out[out.length - 1];
			if (prev !== undefined && /^-{1,2}[A-Za-z][\w-]*$/.test(prev)) {
				out.pop();
			}
			continue;
		}

		// Trim trailing run of `:` only when the trailing placeholder
		// resolved empty. This keeps colons in literal paths alone but
		// strips `::` from `<path>::` (both empty) and `:` from
		// `<path>:42:` (col empty).
		const cleaned = trailingPlaceholderEmpty
			? substituted.replace(/:+$/, "")
			: substituted;
		out.push(cleaned);
	}
	return out;
}
