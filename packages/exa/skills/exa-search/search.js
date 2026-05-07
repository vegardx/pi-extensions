#!/usr/bin/env node
/**
 * Exa semantic search script.
 *
 * Usage:
 *   node search.js "query"
 *   node search.js "query" --num-results 10
 *   node search.js "query" --include-content
 *   node search.js "query" --type neural|keyword|auto
 *   node search.js "query" --num-results 5 --include-content
 *
 * Requires EXA_API_KEY environment variable.
 * Run `npm install` in packages/exa/ before first use.
 */

import Exa from "exa-js";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	console.log(`Usage: node search.js "query" [options]

Options:
  --num-results N      Number of results to return (default: 6)
  --include-content    Fetch and include page text (up to 2 000 chars per result)
  --type TYPE          Search type: auto|neural|keyword (default: auto)
`);
	process.exit(0);
}

// Parse arguments
const query = args[0];
let numResults = 6;
let includeContent = false;
let searchType = "auto";

for (let i = 1; i < args.length; i++) {
	if (args[i] === "--num-results" && args[i + 1]) {
		numResults = parseInt(args[i + 1], 10);
		i++;
	} else if (args[i] === "--include-content") {
		includeContent = true;
	} else if (args[i] === "--type" && args[i + 1]) {
		searchType = args[i + 1];
		i++;
	}
}

const apiKey = process.env.EXA_API_KEY;
if (!apiKey) {
	console.error("Error: EXA_API_KEY environment variable not set.");
	console.error(
		"Get a key at https://exa.ai and set: export EXA_API_KEY=your-key",
	);
	process.exit(1);
}

const exa = new Exa(apiKey);

try {
	let results;
	if (includeContent) {
		results = await exa.searchAndContents(query, {
			numResults,
			type: searchType,
			useAutoprompt: true,
			text: { maxCharacters: 2000 },
		});
	} else {
		results = await exa.search(query, {
			numResults,
			type: searchType,
			useAutoprompt: true,
		});
	}

	console.log(`Search: "${query}" — ${results.results.length} results\n`);

	for (let i = 0; i < results.results.length; i++) {
		const r = results.results[i];
		console.log(`### ${i + 1}. ${r.title || "(no title)"}`);
		console.log(`URL: ${r.url}`);
		if (r.publishedDate) {
			console.log(`Date: ${r.publishedDate.slice(0, 10)}`);
		}
		if (r.author) {
			console.log(`Author: ${r.author}`);
		}
		if (includeContent && r.text) {
			console.log(`\n${r.text.trim().slice(0, 2000)}`);
		}
		console.log();
	}
} catch (err) {
	console.error(`Exa search failed: ${err.message}`);
	process.exit(1);
}
