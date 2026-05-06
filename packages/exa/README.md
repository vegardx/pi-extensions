# pi-ext-exa

On-demand Exa semantic search skill for pi. Loads only when needed — no
background process, no MCP server.

## What it provides

A single skill `exa-search` that the agent loads on-demand when a search
task matches its description. The skill drives a Node.js script that calls
the [Exa API](https://exa.ai) directly.

## Setup

```bash
# 1. Install the npm dependency (once)
cd packages/exa && npm install

# 2. Export your API key (add to ~/.zshrc or equivalent)
export EXA_API_KEY=your-key
```

Get a key at <https://exa.ai>.

## Usage

The skill is loaded automatically by pi when a task calls for web search.
You can also force-load it with:

```
/skill:exa-search
```

Then ask the agent to search, e.g.:

```
Search for prior art on distributed rate limiting in Node.js
```

### Direct CLI use

```bash
cd packages/exa/skills/exa-search
node search.js "your query"
node search.js "your query" --num-results 10
node search.js "your query" --include-content
node search.js "your query" --type neural
```

## Why a skill instead of an extension tool?

Skills are **on-demand**: only the short description enters the system
prompt at startup. The full instructions and script are loaded only when
the agent decides (or you instruct) it to search. This keeps the base
context lean — no tool always present in the schema consuming tokens.

An extension tool would register the function call in every turn's tool
list even when search is irrelevant. The skill approach is the right fit
for an occasional-use capability like web search.
