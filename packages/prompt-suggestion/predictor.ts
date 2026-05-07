import { complete, type Message } from "@mariozechner/pi-ai";
import type {
	AgentEndEvent,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type AgentMessage = AgentEndEvent["messages"][number];

// The prompt guides the model toward brevity; sanitize() enforces the character cap
// as a belt-and-braces guard.
const SYSTEM_PROMPT =
	"You predict the most likely next message from a developer to an AI coding agent.\n" +
	"The developer directs the agent — always predict a message where the developer tells the agent what to do, not what the developer will do themselves.\n" +
	"For example: predict 'Create the PR' not 'I'll create the PR'; predict 'Add the test' not 'I'll add the test'.\n" +
	"Use the full conversation context, not just the last message. Based on what the agent's last message contains:\n" +
	"- Yes/no question → 'Yes' or 'No' (whichever fits the context).\n" +
	"- Concrete choice → the most likely option.\n" +
	"- Recommendation or suggested next step → a message directing the agent to proceed (e.g. 'Yes, do that', 'Go ahead', 'Implement it').\n" +
	"- Stated assumptions about the codebase, stack, or intent → confirm or briefly correct (e.g. 'Yes, TypeScript', 'Correct', 'Actually it uses pnpm').\n" +
	"- Short clarifying question → a short direct answer.\n" +
	"- Otherwise → the most natural next instruction given recent context, heavily biased toward coding and software engineering tasks.\n" +
	"Do NOT suggest social acknowledgements, expressions of gratitude, or statements of developer intent — e.g. 'Thanks', 'Great work', 'Sounds good', 'You're welcome', or 'I'll review it'. These are never useful.\n" +
	"If there is no clear actionable next instruction — the conversation is wrapping up, the developer just expressed thanks, or the context does not imply an obvious next task — respond with exactly the word NONE.\n" +
	"Reply with ONLY the predicted message or NONE. No preamble, no quotes, no explanation. Keep it brief — one short sentence.";

const MAX_CONTEXT_MESSAGES = 6;
const MAX_OUTPUT_TOKENS = 500;
const MAX_CHARS_PER_MESSAGE = 2000;
const MAX_SUGGESTION_CHARS = 120;

export class Predictor {
	public modelSpec: string;
	public sawTurnInThisSession = false;
	public lastStatus: string = "never-run";
	public lastStopReason: string | null = null;
	public lastRawText: string | null = null;
	public lastSanitized: string | null = null;
	public lastAt: number | null = null;
	public lastTrimmedCount: number | null = null;
	public lastErrorMessage: string | null = null;
	public lastAgentEndAt: number | null = null;
	public lastContentTypes: string | null = null;

	private readonly ctx: ExtensionContext;
	private abortController: AbortController | null = null;
	private lastMessageKey: string | null = null;
	private lastSuggestion: string | null = null;
	private readonly notifiedReasons = new Set<string>();

	constructor(initialSpec: string, ctx: ExtensionContext) {
		this.modelSpec = initialSpec;
		this.ctx = ctx;
	}

	setModelSpec(spec: string): void {
		this.modelSpec = spec;
		this.lastMessageKey = null;
		this.lastSuggestion = null;
		this.notifiedReasons.clear();
		this.lastStatus = "never-run";
		this.lastStopReason = null;
		this.lastRawText = null;
		this.lastSanitized = null;
		this.lastErrorMessage = null;
	}

	cancel(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	async predict(messages: AgentMessage[]): Promise<string | null> {
		const key = messageKey(messages);
		if (key && key === this.lastMessageKey && this.lastSuggestion) {
			this.lastStatus = "cache-hit";
			this.lastAt = Date.now();
			return this.lastSuggestion;
		}

		const parsed = parseModelSpec(this.modelSpec);
		if (!parsed) {
			this.lastStatus = "model-spec-parse-error";
			this.lastAt = Date.now();
			return null;
		}
		const model = this.ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) {
			this.lastStatus = "model-not-in-registry";
			this.lastAt = Date.now();
			return null;
		}

		const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			this.lastStatus = "auth-error";
			this.lastErrorMessage = auth.error;
			this.lastAt = Date.now();
			this.notifyOnce(
				"auth-error",
				"prompt-suggestion: authentication failed; suggestions disabled",
			);
			return null;
		}
		if (!auth.apiKey) {
			this.lastStatus = "missing-api-key";
			this.lastAt = Date.now();
			this.notifyOnce(
				"missing-key",
				`prompt-suggestion: no API key for ${this.modelSpec}; suggestions disabled`,
			);
			return null;
		}

		const contextText = formatConversationContext(
			messages,
			MAX_CONTEXT_MESSAGES,
			MAX_CHARS_PER_MESSAGE,
		);
		this.lastTrimmedCount = contextText.turnCount;
		if (contextText.turnCount === 0) {
			this.lastStatus = "trimmed-empty";
			this.lastAt = Date.now();
			return null;
		}

		this.cancel();
		const controller = new AbortController();
		this.abortController = controller;

		try {
			const response = await complete(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "text",
									text:
										`Here is the recent conversation between the developer and the coding agent:\n\n${contextText.formatted}\n\n` +
										`Predict what the developer will say next. Reply with just that message — no preamble, no quotes, keep it brief.`,
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: controller.signal,
					maxTokens: MAX_OUTPUT_TOKENS,
				},
			);
			this.lastAt = Date.now();
			this.lastStopReason = response.stopReason ?? null;
			if (controller.signal.aborted) {
				this.lastStatus = "aborted";
				return null;
			}

			const rawText = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			this.lastRawText = rawText.slice(0, 200);
			this.lastContentTypes =
				response.content
					.map((c) => (c as { type: string }).type ?? "?")
					.join(",") || "(empty)";
			if ((response as { errorMessage?: string }).errorMessage) {
				this.lastErrorMessage =
					(response as { errorMessage?: string }).errorMessage ?? null;
			}

			if (!rawText) {
				this.lastStatus = `empty-response (stopReason=${response.stopReason ?? "?"})`;
				return null;
			}

			const cleaned = sanitize(rawText);
			this.lastSanitized = cleaned;
			if (!cleaned) {
				this.lastStatus = "empty-after-sanitize";
				return null;
			}
			if (cleaned.toLowerCase() === "none") {
				this.lastStatus = "no-actionable-suggestion";
				return null;
			}
			if (!isActionable(cleaned)) {
				this.lastStatus = "non-actionable-filtered";
				return null;
			}

			this.lastMessageKey = key;
			this.lastSuggestion = cleaned;
			this.lastStatus = "success";
			this.notifiedReasons.delete("auth-error");
			this.notifiedReasons.delete("request-failed");
			return cleaned;
		} catch (err) {
			this.lastAt = Date.now();
			if (controller.signal.aborted) {
				this.lastStatus = "aborted";
				return null;
			}
			if (err instanceof Error && err.name === "AbortError") {
				this.lastStatus = "aborted";
				return null;
			}
			this.lastStatus = "request-failed";
			this.lastErrorMessage = err instanceof Error ? err.message : String(err);
			this.notifyOnce(
				"request-failed",
				"prompt-suggestion: suggestion request failed",
			);
			return null;
		} finally {
			if (this.abortController === controller) this.abortController = null;
		}
	}

	private notifyOnce(reason: string, message: string): void {
		if (!this.ctx.hasUI) return;
		if (this.notifiedReasons.has(reason)) return;
		this.notifiedReasons.add(reason);
		this.ctx.ui.notify(message, "warning");
	}
}

export function parseModelSpec(
	spec: string,
): { provider: string; modelId: string } | null {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx === spec.length - 1) return null;
	return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

function messageKey(messages: AgentMessage[]): string | null {
	if (messages.length === 0) return null;
	const last = messages[messages.length - 1] as { timestamp?: number };
	if (typeof last.timestamp !== "number") return null;
	return `${messages.length}:${last.timestamp}`;
}

export function formatConversationContext(
	messages: AgentMessage[],
	limit: number,
	maxCharsPerMessage: number,
): { formatted: string; turnCount: number } {
	const turns: string[] = [];
	for (let i = messages.length - 1; i >= 0 && turns.length < limit; i--) {
		const m = messages[i] as { role: string; content: unknown };
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = extractText(m.content).slice(0, maxCharsPerMessage).trim();
		if (!text) continue;
		const label = m.role === "user" ? "Developer" : "Agent";
		turns.unshift(`${label}: ${text}`);
	}
	return { formatted: turns.join("\n\n"), turnCount: turns.length };
}

export function trimMessages(
	messages: AgentMessage[],
	limit: number,
	maxCharsPerMessage: number,
): Message[] {
	const picked: Message[] = [];
	for (let i = messages.length - 1; i >= 0 && picked.length < limit; i--) {
		const m = messages[i] as {
			role: string;
			content: unknown;
			timestamp?: number;
		};
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = extractText(m.content).slice(0, maxCharsPerMessage).trim();
		if (!text) continue;
		const timestamp =
			typeof m.timestamp === "number" ? m.timestamp : Date.now();
		picked.unshift({
			role: m.role,
			content: [{ type: "text", text }],
			timestamp,
		} as Message);
	}
	while (picked.length > 0 && picked[picked.length - 1]?.role === "user") {
		picked.pop();
	}
	return picked;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("\n");
}

// Belt-and-braces guard against non-actionable social phrases the model may
// still emit despite the NONE instruction in the system prompt.
export function isActionable(s: string): boolean {
	if (!s) return false;
	const lower = s.trim().toLowerCase();
	if (lower === "none") return false;
	const patterns = [
		/^(thanks|thank you|thx|ty)\b/,
		/^(great|awesome|excellent|perfect|wonderful|fantastic|nice)\b/,
		/^(sounds good|looks good|that works|that's fine|that looks good)\b/,
		/^(you're welcome|no problem|sure thing|absolutely|of course)\b/,
		/^(good job|well done|great work|nice work|good work)\b/,
		/^(ok|okay|alright|got it|understood|makes sense|noted)\b/,
		/^(i'll|i will|i'm going to|i can)\b/,
	];
	return !patterns.some((re) => re.test(lower));
}

// Display-layer sanitization. Strips control characters that would corrupt
// the terminal, then normalizes quotes/punctuation/length. Does NOT filter
// harmful commands (e.g. leading "!" or "/") — that concern belongs to a
// separate command-safety extension that intercepts submissions via on("input").
export function sanitize(raw: string): string {
	let s = raw;
	// Take the first line before stripping controls (the control-strip below
	// would otherwise eat \n and merge all lines).
	s = s.split("\n")[0] ?? "";
	// Strip ANSI CSI (e.g. \x1b[31m, \x1b[2J) and OSC (e.g. \x1b]8;;…\x07).
	// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize() must strip control chars by design
	s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize() must strip control chars by design
	s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
	// Strip any other ESC-prefixed two-byte sequence (e.g. \x1bM, \x1b7).
	// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize() must strip control chars by design
	s = s.replace(/\x1b[\s\S]/g, "");
	// Strip remaining C0 controls, DEL, and C1 controls.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize() must strip control chars by design
	s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
	// Strip Unicode bidi/format overrides that can visually spoof text.
	s = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");
	s = s.trim();
	s = s.replace(/^["'`]+|["'`]+$/g, "");
	s = s.replace(/[.!?]+$/g, "");
	s = s.trim();
	// Belt-and-braces character cap. Trim trailing whitespace before appending the
	// ellipsis so we don't render "foo   …" when the slice lands on whitespace.
	if (s.length > MAX_SUGGESTION_CHARS) {
		s = `${s.slice(0, MAX_SUGGESTION_CHARS).trimEnd()}…`;
	}
	return s;
}
