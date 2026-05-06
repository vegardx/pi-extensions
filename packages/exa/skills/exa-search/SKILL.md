---
name: exa-search
description: Search the internet using Exa's semantic search API. Use when you need to find similar implementations, libraries, prior art, documentation, best practices, or any web content. Especially useful for discovering how others have solved the same problem.
---

# Exa Search

Exa is a semantic search engine optimised for technical content. It finds
conceptually relevant results rather than just keyword matches. This skill
calls the Exa API directly — no MCP server, no background process.

## Setup

Run once before first use (from the skill directory or the package root):

```bash
cd "$(dirname "$0")" && npm install
# or from the package root:
cd <monorepo>/packages/exa && npm install
```

Requires `EXA_API_KEY` in your environment. Get one at <https://exa.ai>:

```bash
export EXA_API_KEY=your-key
```

## Search

All commands are relative to this skill directory:

```bash
# Basic search (6 results, titles + URLs)
node search.js "your query"

# More results
node search.js "your query" --num-results 10

# Include full page content (summaries, up to 2 000 chars per result)
node search.js "your query" --include-content

# Force keyword or neural mode (default: auto)
node search.js "your query" --type keyword
node search.js "your query" --type neural

# Combined
node search.js "Redis session caching Node.js" --num-results 8 --include-content
```

## Tips

- Use specific, technical queries — "how to handle distributed sessions" beats "session library".
- Run two or three focused searches rather than one broad query.
- Use `--include-content` when you need to understand what a page says, not just confirm it exists.
- Prefer `--type neural` for conceptual/semantic questions; `--type keyword` for exact method/library names.

## Examples

```bash
# Find similar implementations
node search.js "Redis session store Express.js implementation"

# Discover libraries
node search.js "best Node.js rate limiting libraries 2024" --num-results 8

# Find gotchas
node search.js "common mistakes Redis caching production" --include-content

# Prior art with content
node search.js "feature flag system implementation TypeScript" --include-content
```
