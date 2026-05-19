/**
 * Inline prompt-suggestion sentinel protocol.
 *
 * The main agent is asked (via a system-prompt addendum) to optionally
 * emit a sentinel-wrapped guess of the developer's most likely next
 * message at the very end of each assistant turn. We parse that block
 * out of the last assistant message in `agent_end` and surface it as
 * a ghost-text suggestion — with no second LLM round-trip.
 *
 * Sentinel format (chosen so it is unique enough to ignore-on-collision
 * but visually obvious in a log):
 *
 *     <<<NEXT_PROMPT>>>
 *     <one short sentence directing the agent>
 *     <<<END>>>
 *
 * The main agent is told to either emit one block per turn or omit it
 * entirely. We parse permissively: leading/trailing whitespace, an
 * optional "NONE" content (treated as no suggestion), and multiple
 * blocks (we take the last one — most relevant to the latest reasoning).
 */

const SENTINEL_OPEN = "<<<NEXT_PROMPT>>>";
const SENTINEL_CLOSE = "<<<END>>>";

// Cap mirrors `Predictor.MAX_SUGGESTION_CHARS`; we want both paths to
// surface the same display contract regardless of source.
const MAX_SUGGESTION_CHARS = 120;

/**
 * Addendum the host should append to the main agent's system prompt
 * for inline ghost-text suggestions to surface. Kept short to keep
 * token overhead negligible. Designed to NOT change agent behaviour
 * for the rest of the turn — only affects the trailing sentinel block.
 */
export const INLINE_SUGGESTION_SYSTEM_ADDENDUM = `
You may optionally append a single sentinel-wrapped guess of the developer's most likely next message at the very end of your reply (after all other content):

<<<NEXT_PROMPT>>>
<one short sentence directing you to do something>
<<<END>>>

Rules:
- The sentinel block is optional. If there is no obvious next instruction (the conversation is wrapping up, the developer just expressed thanks, or you are mid-task and waiting for them to react), omit it entirely or write the literal text "NONE" between the sentinels.
- Predict a message where the developer tells you what to do next — never what they will do themselves. e.g. "Create the PR" not "I'll create the PR".
- One short sentence. Never more than 120 characters. No quotes, no preamble, no explanation.
- If you emit the block, place it strictly last — after every other message, code block, or tool use. The block is invisible to the developer; it only feeds an optional ghost-text suggestion.
`.trim();

/**
 * Extract the suggestion (if any) from a single assistant message body.
 *
 * Permissive on input: tolerates code fences around the sentinel, multiple
 * blocks (returns the LAST), and CR/LF / leading/trailing whitespace inside
 * the block. Returns `null` for missing block, "NONE" content, empty after
 * trim, or unbalanced sentinels.
 *
 * Strict on output: caps at MAX_SUGGESTION_CHARS, strips quotes/punctuation,
 * mirrors what the addendum tells the agent to produce.
 */
export function parseSentinelBlock(text: string): string | null {
	if (!text) return null;
	let lastOpenIdx = -1;
	let lastCloseIdx = -1;
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf(SENTINEL_OPEN, cursor);
		if (open === -1) break;
		const close = text.indexOf(SENTINEL_CLOSE, open + SENTINEL_OPEN.length);
		if (close === -1) break;
		lastOpenIdx = open;
		lastCloseIdx = close;
		cursor = close + SENTINEL_CLOSE.length;
	}
	if (lastOpenIdx === -1 || lastCloseIdx === -1) return null;

	const inner = text
		.slice(lastOpenIdx + SENTINEL_OPEN.length, lastCloseIdx)
		.trim();
	return finaliseSuggestion(inner);
}

function finaliseSuggestion(raw: string): string | null {
	if (!raw) return null;
	let s = raw.split("\n")[0]?.trim() ?? "";
	if (!s) return null;
	if (s.toUpperCase() === "NONE") return null;
	// Strip ANSI CSI / OSC / ESC-pair sequences and remaining control
	// chars. An inline suggestion that contains escape sequences would
	// render terminal control codes inside the ghost editor; bidi/format
	// overrides can visually spoof what the user thinks they're accepting.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/\x1b[\s\S]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: must strip control chars by design
	s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
	// Unicode bidi / format overrides that can visually spoof text.
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

/**
 * Walk an `agent_end` messages array, find the last assistant turn,
 * extract its text content, and parse a sentinel block. Returns the
 * suggestion if present, or `null` if no inline guess is available.
 *
 * Also strips the sentinel block from the message in-place when
 * `stripFromMessage` is true so the developer doesn't see it in the
 * transcript view. We mutate `content[].text` for the LAST text block
 * of the LAST assistant message; safe because messages are emitted
 * once per turn and not re-rendered afterwards.
 */
export function tryParseInlineSuggestion(
	messages: readonly InlineSuggestionMessage[],
	options: { stripFromMessage?: boolean } = {},
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const text = extractAssistantText(m);
		if (!text) return null;
		const suggestion = parseSentinelBlock(text);
		// Strip whenever the sentinel was PRESENT in the text, not only
		// when it parsed to a usable suggestion. The protocol explicitly
		// allows `<<<NEXT_PROMPT>>>NONE<<<END>>>` (and other parses can
		// also yield null, e.g. empty/whitespace contents). Without this,
		// the developer sees the raw sentinel in the transcript on every
		// NONE turn, breaking the "invisible to the developer" guarantee.
		if (options.stripFromMessage && text.includes(SENTINEL_OPEN)) {
			stripSentinelFromMessage(m);
		}
		return suggestion;
	}
	return null;
}

export interface InlineSuggestionMessage {
	role: string;
	content: unknown;
}

function extractAssistantText(m: InlineSuggestionMessage): string {
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	const parts: string[] = [];
	for (const block of m.content) {
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("\n");
}

function stripSentinelFromMessage(m: InlineSuggestionMessage): void {
	if (typeof m.content === "string") {
		m.content = stripSentinelFromString(m.content);
		return;
	}
	if (!Array.isArray(m.content)) return;
	for (let i = m.content.length - 1; i >= 0; i--) {
		const block = m.content[i];
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") {
				b.text = stripSentinelFromString(b.text);
				return;
			}
		}
	}
}

function stripSentinelFromString(text: string): string {
	const open = text.lastIndexOf(SENTINEL_OPEN);
	if (open === -1) return text;
	const close = text.indexOf(SENTINEL_CLOSE, open + SENTINEL_OPEN.length);
	if (close === -1) return text;
	const before = text.slice(0, open).replace(/\s+$/, "");
	const after = text.slice(close + SENTINEL_CLOSE.length).replace(/^\s+/, "");
	if (after) return `${before}\n\n${after}`.trim();
	return before;
}
