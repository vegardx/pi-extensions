/**
 * Inline prompt-suggestion sanitisation + system-prompt addendum.
 *
 * Suggestions arrive via a registered `suggest_next_prompt` tool call —
 * the agent invokes the tool with `text: string` at the very end of a
 * turn, and the extension routes that string into the editor as ghost
 * text. The tool path replaces the earlier sentinel-in-prose transport;
 * tool calls are rendered invisibly (zero-height row) so suggestions
 * never appear in the visible stream, transcript, `/export`, or session
 * resume view.
 *
 * This file owns the bits that survive the transport switch: the
 * sanitiser that protects against terminal-control-code injection /
 * bidi spoofing / overlong suggestions, and the system-prompt addendum
 * the user pastes into their `~/.pi/agent/AGENTS.md` to teach the
 * agent the calling contract.
 */

const MAX_SUGGESTION_CHARS = 120;

/**
 * Addendum the user appends to their `AGENTS.md` so the agent learns
 * to call the `suggest_next_prompt` tool. Kept short to keep token
 * overhead negligible. Designed to NOT change agent behaviour for the
 * rest of the turn — only invites a single trailing tool call.
 */
export const INLINE_SUGGESTION_SYSTEM_ADDENDUM = `
You may optionally call the suggest_next_prompt tool exactly once at the very end of your reply, with text set to a short sentence directing the developer to the most likely next instruction (e.g. "Open the PR" not "I'll open the PR"). The tool call is invisible to the developer; it only feeds an optional ghost-text suggestion. Omit the call entirely when there is no obvious next instruction. Keep text to one short sentence, ≤120 characters.
`.trim();

/**
 * Cap inline-suggestion strings to a safe shape for the ghost editor.
 *
 * Permissive on input: tolerates leading/trailing whitespace, multi-line
 * inputs (first non-empty line wins), and a literal "NONE" sentinel
 * (treated as no suggestion).
 *
 * Strict on output:
 * - Strips ANSI CSI / OSC / ESC-pair sequences and other control chars
 *   so the ghost editor can never render terminal control codes.
 * - Strips Unicode bidi/format overrides (LRO / RLO / ZWSP / etc.) so
 *   suggestions can't visually spoof what the user accepts with Tab.
 * - Strips wrapping quotes and trailing punctuation.
 * - Caps at MAX_SUGGESTION_CHARS with a trailing ellipsis.
 *
 * Returns `null` when the input is empty, "NONE", or sanitises to empty.
 */
export function sanitiseSuggestion(raw: string): string | null {
	if (!raw) return null;
	let s =
		raw
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	if (!s) return null;
	if (s.toUpperCase() === "NONE") return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b[\s\S]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
	s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
	s = s.trim();
	if (!s) return null;
	s = s.replace(/^["'`]+|["'`]+$/g, "");
	s = s.replace(/[.!?]+$/g, "");
	s = s.trim();
	if (!s) return null;
	if (s.length > MAX_SUGGESTION_CHARS) {
		s = `${s.slice(0, MAX_SUGGESTION_CHARS).trimEnd()}…`;
	}
	return s;
}
