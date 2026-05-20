import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { defineExtension } from "@vegardx/pi-extensions-shared/define-extension.js";
import { Exa } from "exa-js";

const EXT_ID = "exa";

export default defineExtension(
	{
		name: EXT_ID,
		path: fileURLToPath(import.meta.url),
		doc: "Exa semantic web search tool. Searches the web for technical content using Exa's neural search API.",
	},
	(pi: ExtensionAPI) => {
		pi.registerTool({
			name: "websearch",
			label: "Web Search",
			description:
				"Search the web using Exa's semantic search API. Returns relevant results for technical queries.",
			promptSnippet:
				"Search the web for current information, prior art, libraries, or documentation",
			promptGuidelines: [
				"Use websearch when you need current information that may be beyond your training data — " +
					"library comparisons, recent documentation, implementation examples, or best practices.",
				"Prefer specific, technical queries over broad ones. Run multiple focused searches rather than one broad query.",
				"Use includeContent when you need to understand page content, not just confirm a page exists.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				numResults: Type.Optional(
					Type.Number({
						description: "Number of results to return (default: 6)",
					}),
				),
				includeContent: Type.Optional(
					Type.Boolean({
						description:
							"Fetch page text summaries (up to 2000 chars per result)",
					}),
				),
				type: Type.Optional(
					Type.Union(
						[
							Type.Literal("auto"),
							Type.Literal("neural"),
							Type.Literal("keyword"),
						],
						{
							description:
								"Search type: neural for conceptual queries, keyword for exact names (default: auto)",
						},
					),
				),
			}),

			async execute(_toolCallId, params) {
				const apiKey = process.env.EXA_API_KEY;
				if (!apiKey) {
					return {
						content: [
							{
								type: "text",
								text: "Error: EXA_API_KEY environment variable not set. Get a key at https://exa.ai",
							},
						],
						details: { error: "missing-api-key", resultCount: 0 },
					};
				}

				const exa = new Exa(apiKey);
				const numResults = params.numResults ?? 6;
				const searchType = params.type ?? "auto";

				try {
					let results: { results: Array<Record<string, unknown>> };
					if (params.includeContent) {
						results = await exa.searchAndContents(params.query, {
							numResults,
							type: searchType,
							useAutoprompt: true,
							text: { maxCharacters: 2000 },
						});
					} else {
						results = await exa.search(params.query, {
							numResults,
							type: searchType,
							useAutoprompt: true,
						});
					}

					const formatted = results.results
						.map((r: Record<string, unknown>, i: number) => {
							const lines: string[] = [];
							lines.push(
								`### ${i + 1}. ${(r.title as string) || "(no title)"}`,
							);
							lines.push(`URL: ${r.url as string}`);
							if (r.publishedDate)
								lines.push(`Date: ${(r.publishedDate as string).slice(0, 10)}`);
							if (r.author) lines.push(`Author: ${r.author as string}`);
							if (params.includeContent && r.text) {
								lines.push(`\n${(r.text as string).trim().slice(0, 2000)}`);
							}
							return lines.join("\n");
						})
						.join("\n\n");

					return {
						content: [
							{
								type: "text",
								text: `Search: "${params.query}" — ${results.results.length} results\n\n${formatted}`,
							},
						],
						details: {
							resultCount: results.results.length,
							error: null as string | null,
						},
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `Exa search failed: ${msg}` }],
						details: { error: msg, resultCount: 0 },
					};
				}
			},
		});
	},
);
