import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";
import { UrlValidationError, validateUrl } from "./validate.js";

const EXT_ID = "webfetch";

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Fetch web pages and extract clean markdown content. Defends against SSRF (loopback, private IPs, link-local) and gates LLM distillation behind an allowlist.",
		configSchema: [
			{
				key: "allowedHosts",
				type: "string[]",
				default: [],
				doc: "Optional allowlist of hostnames. When set, only URLs whose host matches an entry (exact or subdomain) are fetched. When empty, any public URL is allowed.",
			},
			{
				key: "allowLLMDistill",
				type: "boolean",
				default: false,
				doc: "Whether the `focus` parameter may send fetched content to a background model for distillation. Off by default — fetched content stays local. Enable only when you trust both the URL allowlist and the configured model provider.",
			},
		],
	},
	(pi: ExtensionAPI) => {
		pi.registerTool({
			name: "webfetch",
			label: "Web Fetch",
			description:
				"Fetch a URL and extract its main content as clean markdown. " +
				"Strips navigation, ads, and boilerplate. Saves result to a temp " +
				"file to avoid context bloat — use the read tool to inspect the content.",
			promptSnippet:
				"Fetch a web page and extract clean readable content as markdown",
			promptGuidelines: [
				"Use webfetch when you need to read the content of a specific URL — documentation pages, " +
					"blog posts, API references, or any web page.",
				"The result is saved to a temp file. Use the read tool to inspect it afterward.",
				"The `focus` parameter is only honoured when LLM distillation is enabled in config — otherwise it is ignored and the full page is returned.",
				"Do NOT use webfetch for search — use websearch instead.",
			],
			parameters: Type.Object({
				url: Type.String({ description: "URL to fetch (http/https only)" }),
				focus: Type.Optional(
					Type.String({
						description:
							"Optional focus query — when LLM distillation is enabled, an LLM will extract only the parts relevant to this question",
					}),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					const settings = readRelevantSettings(ctx.cwd);
					const cfg = (settings.extensionConfig?.[EXT_ID] ?? {}) as {
						allowedHosts?: string[];
						allowLLMDistill?: boolean;
					};

					const result = await fetchAndExtract(params.url, params.focus, ctx, {
						allowedHosts: cfg.allowedHosts,
						allowLLMDistill: cfg.allowLLMDistill ?? false,
					});

					return {
						content: [{ type: "text", text: result.summary }],
						details: {
							url: params.url,
							title: result.title,
							filePath: result.filePath,
							contentLength: result.contentLength,
							usedLLM: result.usedLLM,
						},
					};
				} catch (err) {
					if (err instanceof UrlValidationError) {
						return {
							content: [
								{
									type: "text",
									text: `webfetch refused ${params.url}: ${err.message}`,
								},
							],
							details: {
								url: params.url,
								error: err.message,
								reason: err.reason,
							},
						};
					}
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `webfetch failed: ${msg}` }],
						details: { url: params.url, error: msg },
					};
				}
			},
		});
	},
);

interface FetchResult {
	summary: string;
	title: string;
	filePath: string;
	contentLength: number;
	usedLLM: boolean;
}

interface FetchOptions {
	allowedHosts: readonly string[] | undefined;
	allowLLMDistill: boolean;
}

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

async function fetchAndExtract(
	urlInput: string,
	focus: string | undefined,
	ctx: { cwd: string; signal?: AbortSignal },
	opts: FetchOptions,
): Promise<FetchResult> {
	const allowedHosts =
		opts.allowedHosts && opts.allowedHosts.length > 0
			? opts.allowedHosts
			: undefined;

	let currentUrl = urlInput;
	let response: Response | undefined;

	// Follow redirects manually, validating each hop.
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const validated = await validateUrl(currentUrl, { allowedHosts });

		response = await fetch(validated.href, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; pi-webfetch/1.0; +https://pi.dev)",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			signal: ctx.signal,
			redirect: "manual",
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) {
				throw new Error(`HTTP ${response.status} without Location header`);
			}
			if (i === MAX_REDIRECTS) {
				throw new Error(`exceeded ${MAX_REDIRECTS} redirects`);
			}
			currentUrl = new URL(location, validated.href).href;
			continue;
		}
		break;
	}

	if (!response) {
		throw new Error("no response");
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const html = await readBodyWithLimit(response, MAX_BODY_BYTES);

	const finalUrl = response.url || currentUrl;

	// If it's not HTML, return raw content.
	if (!contentType.includes("html")) {
		return saveToFile(finalUrl, "Raw Content", html, false);
	}

	// Extract content with Defuddle.
	const { Defuddle } = await import("defuddle/node");
	const parsed = await Defuddle(html, finalUrl, { markdown: true });

	const markdown = parsed.contentMarkdown ?? parsed.content ?? "";
	const title = parsed.title ?? new URL(finalUrl).hostname;

	if (!markdown || markdown.trim().length < 50) {
		// Defuddle got very little — page might be JS-rendered.
		return saveToFile(
			finalUrl,
			title,
			`<!-- Extraction produced minimal content. Page may require JavaScript rendering. -->\n\n${html.slice(0, 5000)}`,
			false,
		);
	}

	// LLM distillation — gated behind explicit config opt-in. This protects
	// against accidentally exfiltrating fetched content (which originates
	// from a model-controlled URL) to a third-party model provider.
	if (focus && opts.allowLLMDistill) {
		const distilled = await distillWithLLM(
			finalUrl,
			title,
			markdown,
			focus,
			ctx,
		);
		if (distilled) {
			return saveToFile(finalUrl, title, distilled, true);
		}
	}

	return saveToFile(finalUrl, title, markdown, false);
}

async function readBodyWithLimit(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return await response.text();

	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`response body exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buf.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(buf);
}

async function distillWithLLM(
	url: string,
	title: string,
	markdown: string,
	focus: string,
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<string | null> {
	try {
		const { completeSimple } = await import("@mariozechner/pi-ai");
		const settings = readRelevantSettings(ctx.cwd);
		const modelSpec = settings.backgroundModels?.primary?.normal;
		if (!modelSpec) return null;

		const resolved = await resolveModel(ctx as never, {
			name: "webfetch",
			tier: "normal",
			explicit: modelSpec,
			requireApiKey: true,
		});
		if (!resolved?.apiKey) return null;

		// Truncate content to avoid exceeding context limits.
		const maxChars = 100_000;
		const content =
			markdown.length > maxChars
				? `${markdown.slice(0, maxChars)}\n\n[… truncated at ${maxChars} chars]`
				: markdown;

		const response = await completeSimple(
			resolved.model,
			{
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: [
									"Extract the relevant information from this web page.",
									"",
									`**URL:** ${url}`,
									`**Title:** ${title}`,
									`**Focus:** ${focus}`,
									"",
									"Return ONLY the parts relevant to the focus query, formatted as clean markdown.",
									"Preserve code blocks, links, and structure. Omit everything irrelevant.",
									"",
									"---",
									"",
									content,
								].join("\n"),
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: resolved.apiKey,
				headers: resolved.headers,
				maxTokens: 4096,
				signal: ctx.signal,
			},
		);

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");

		return text.trim() || null;
	} catch {
		// LLM distillation failed — fall back to full content.
		return null;
	}
}

function saveToFile(
	url: string,
	title: string,
	content: string,
	usedLLM: boolean,
): FetchResult {
	const dir = mkdtempSync(join(tmpdir(), "webfetch-"));
	const filePath = join(dir, "content.md");

	const header = [
		`<!-- webfetch: ${url} -->`,
		`<!-- title: ${title} -->`,
		"",
	].join("\n");

	writeFileSync(filePath, header + content, "utf8");

	const preview = content.slice(0, 200).trim();
	const summary = [
		`**${title}**`,
		`Source: ${url}`,
		`Content saved to: \`${filePath}\``,
		`Length: ${content.length} chars${usedLLM ? " (LLM-distilled)" : ""}`,
		"",
		"Preview:",
		preview.length < content.length ? `${preview}…` : preview,
		"",
		`Use the \`read\` tool on \`${filePath}\` to see the full content.`,
	].join("\n");

	return {
		summary,
		title,
		filePath,
		contentLength: content.length,
		usedLLM,
	};
}
