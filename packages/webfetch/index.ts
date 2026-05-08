import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";
import { readRelevantSettings } from "@vegardx/pi-extensions-shared/extension-settings.js";
import { resolveModel } from "@vegardx/pi-extensions-shared/model-resolver.js";

const EXT_ID = "webfetch";

export default function (pi: ExtensionAPI) {
	declareExtension({
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Fetch web pages and extract clean markdown content. Optionally distill with an LLM sub-agent for focused extraction.",
	});

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
			"Use the focus parameter to have an LLM extract only the parts relevant to your question. " +
				"Without focus, you get the full page content as markdown.",
			"Do NOT use webfetch for search — use websearch instead.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			focus: Type.Optional(
				Type.String({
					description:
						"Optional focus query — an LLM sub-agent will extract only the parts relevant to this question",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await fetchAndExtract(params.url, params.focus, ctx);
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
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `webfetch failed: ${msg}` }],
					details: { url: params.url, error: msg },
				};
			}
		},
	});
}

interface FetchResult {
	summary: string;
	title: string;
	filePath: string;
	contentLength: number;
	usedLLM: boolean;
}

async function fetchAndExtract(
	url: string,
	focus: string | undefined,
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<FetchResult> {
	// Fetch the page.
	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (compatible; pi-webfetch/1.0; +https://pi.dev)",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		},
		signal: ctx.signal,
	});

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	const html = await response.text();

	// If it's not HTML, return raw content.
	if (!contentType.includes("html")) {
		return saveToFile(url, "Raw Content", html, false);
	}

	// Extract content with Defuddle.
	const { Defuddle } = await import("defuddle/node");

	const parsed = await Defuddle(html, url, { markdown: true });

	const markdown = parsed.contentMarkdown ?? parsed.content ?? "";
	const title = parsed.title ?? new URL(url).hostname;

	if (!markdown || markdown.trim().length < 50) {
		// Defuddle got very little — page might be JS-rendered.
		return saveToFile(
			url,
			title,
			`<!-- Extraction produced minimal content. Page may require JavaScript rendering. -->\n\n${html.slice(0, 5000)}`,
			false,
		);
	}

	// If focus is provided, use LLM sub-agent to distill.
	if (focus) {
		const distilled = await distillWithLLM(url, title, markdown, focus, ctx);
		if (distilled) {
			return saveToFile(url, title, distilled, true);
		}
	}

	return saveToFile(url, title, markdown, false);
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

		const resolved = await resolveModel(ctx as any, {
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
									`Extract the relevant information from this web page.`,
									``,
									`**URL:** ${url}`,
									`**Title:** ${title}`,
									`**Focus:** ${focus}`,
									``,
									`Return ONLY the parts relevant to the focus query, formatted as clean markdown.`,
									`Preserve code blocks, links, and structure. Omit everything irrelevant.`,
									``,
									`---`,
									``,
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
		``,
	].join("\n");

	writeFileSync(filePath, header + content, "utf8");

	const preview = content.slice(0, 200).trim();
	const summary = [
		`**${title}**`,
		`Source: ${url}`,
		`Content saved to: \`${filePath}\``,
		`Length: ${content.length} chars${usedLLM ? " (LLM-distilled)" : ""}`,
		``,
		`Preview:`,
		preview.length < content.length ? `${preview}…` : preview,
		``,
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
