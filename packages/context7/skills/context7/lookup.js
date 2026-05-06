#!/usr/bin/env node
/**
 * Context7 library documentation lookup script.
 *
 * Context7 resolves up-to-date library documentation without an MCP server.
 * The workflow has two steps:
 *   1. Search for the library to get its Context7 ID
 *   2. Fetch documentation using that ID
 *
 * Usage:
 *   node lookup.js search "react"
 *   node lookup.js search "nextjs routing" --num-results 5
 *
 *   node lookup.js docs /facebook/react
 *   node lookup.js docs /vercel/next.js --tokens 8000
 *   node lookup.js docs /vercel/next.js --topic "app router" --tokens 5000
 *
 * CONTEXT7_API_KEY is optional. When set it is sent as a Bearer token,
 * which raises rate limits and unlocks any authenticated content.
 * The public API works without it.
 * Requires Node.js 18+ (uses built-in fetch).
 */

const BASE_URL = "https://context7.com/api/v1";

// Build shared request headers — include Authorization only when a key is set.
const apiKey = process.env.CONTEXT7_API_KEY;
const HEADERS = {
	Accept: "application/json",
	...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
};

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
	console.log(`Context7 library documentation lookup

Commands:
  search <query> [--num-results N]
      Search for a library and list its Context7 IDs.

  docs <libraryId> [--tokens N] [--topic TOPIC]
      Fetch documentation for a library.
      libraryId: the Context7 ID from the search step (e.g. /facebook/react)
      --tokens N: approximate token budget for docs (default: 5000)
      --topic TOPIC: focus docs on a specific topic (e.g. "hooks")

Environment:
  CONTEXT7_API_KEY   Optional. Sent as a Bearer token for higher rate limits.

Examples:
  node lookup.js search "react"
  node lookup.js search "nextjs" --num-results 5
  node lookup.js docs /facebook/react
  node lookup.js docs /vercel/next.js --tokens 8000 --topic "app router"
  node lookup.js docs /supabase/supabase --topic "authentication" --tokens 6000
`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

if (command === "search") {
	const query = args[1];
	if (!query) {
		console.error("Error: search requires a query string.");
		console.error('  node lookup.js search "react"');
		process.exit(1);
	}

	let numResults = 5;
	for (let i = 2; i < args.length; i++) {
		if (args[i] === "--num-results" && args[i + 1]) {
			numResults = parseInt(args[i + 1], 10);
			i++;
		}
	}

	try {
		const url = `${BASE_URL}/search?query=${encodeURIComponent(query)}`;
		const res = await fetch(url, { headers: HEADERS });

		if (!res.ok) {
			console.error(`Context7 search failed: HTTP ${res.status}`);
			process.exit(1);
		}

		const data = await res.json();
		const results = (data.results ?? []).slice(0, numResults);

		if (results.length === 0) {
			console.log(`No results found for "${query}".`);
			process.exit(0);
		}

		console.log(`Context7 search: "${query}" — ${results.length} results\n`);
		console.log(
			"Copy the ID from the result you want, then run:\n  node lookup.js docs <id>\n",
		);

		for (const r of results) {
			console.log(`### ${r.title ?? r.id}`);
			console.log(`ID:          ${r.id}`);
			if (r.description) console.log(`Description: ${r.description}`);
			if (r.stars != null) console.log(`Stars:       ${r.stars}`);
			if (r.lastUpdated) console.log(`Updated:     ${r.lastUpdated}`);
			if (r.version) console.log(`Version:     ${r.version}`);
			console.log();
		}
	} catch (err) {
		console.error(`Context7 search error: ${err.message}`);
		process.exit(1);
	}

	process.exit(0);
}

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

if (command === "docs") {
	const libraryId = args[1];
	if (!libraryId) {
		console.error("Error: docs requires a library ID.");
		console.error("  node lookup.js docs /facebook/react");
		process.exit(1);
	}

	let tokens = 5000;
	let topic = "";

	for (let i = 2; i < args.length; i++) {
		if (args[i] === "--tokens" && args[i + 1]) {
			tokens = parseInt(args[i + 1], 10);
			i++;
		} else if (args[i] === "--topic" && args[i + 1]) {
			topic = args[i + 1];
			i++;
		}
	}

	try {
		// libraryId may start with '/' already (e.g. /facebook/react)
		const idPath = libraryId.startsWith("/") ? libraryId : `/${libraryId}`;
		const params = new URLSearchParams({ tokens: String(tokens) });
		if (topic) params.set("topic", topic);

		const url = `${BASE_URL}${idPath}?${params}`;
		const res = await fetch(url, { headers: HEADERS });

		if (!res.ok) {
			if (res.status === 404) {
				console.error(
					`Library not found: ${libraryId}\nRun "node lookup.js search <name>" to find the correct ID.`,
				);
			} else {
				console.error(`Context7 docs failed: HTTP ${res.status}`);
			}
			process.exit(1);
		}

		const data = await res.json();

		// Print metadata header
		if (data.title) console.log(`# ${data.title}`);
		if (data.description) console.log(`\n${data.description}`);
		if (data.version) console.log(`\nVersion: ${data.version}`);
		if (topic) console.log(`Topic: ${topic}`);
		console.log(`Tokens: ~${tokens}\n`);
		console.log("---\n");

		// The documentation content lives in different fields depending on
		// the Context7 response shape.
		const content =
			data.content ??
			data.documentation ??
			data.text ??
			data.sections?.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n") ??
			JSON.stringify(data, null, 2);

		console.log(content);
	} catch (err) {
		console.error(`Context7 docs error: ${err.message}`);
		process.exit(1);
	}

	process.exit(0);
}

// Unknown command
console.error(`Unknown command: "${command}". Use "search" or "docs".`);
process.exit(1);
