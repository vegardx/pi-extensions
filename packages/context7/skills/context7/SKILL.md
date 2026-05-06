---
name: context7
description: Fetches current, version-accurate documentation for libraries and frameworks using the Context7 API. Use when the task involves coding with a specific library and current API references, method signatures, or usage examples are needed. Covers requests like "how do I use X", "show me docs for", "API reference for", "examples of X", or "how does X work" for libraries including React, Next.js, Supabase, Prisma, tRPC, Vue, Svelte, Drizzle, and thousands more.
---

# Context7

Context7 resolves fresh, version-aware library documentation. It has indexed
thousands of popular libraries and exposes them through a simple REST API.
This skill calls that API directly — no MCP server, no background process.

**No API key required.** The Context7 API is public. Set `CONTEXT7_API_KEY`
in your environment if you have one — it is sent as a `Bearer` token and
gives higher rate limits.

## Setup

No installation step needed — the script uses Node.js 18+ built-in `fetch`.
Optionally set `CONTEXT7_API_KEY` in your environment for higher rate limits:

```bash
export CONTEXT7_API_KEY=your-key
```

## Workflow

Documentation lookup is a two-step process:

1. **Search** for the library to get its Context7 ID.
2. **Fetch** documentation using that ID.

All commands are relative to this skill directory.

## Step 1 — Find the library ID

```bash
node lookup.js search "react"
node lookup.js search "nextjs" --num-results 5
node lookup.js search "supabase auth"
node lookup.js search "prisma orm"
```

This returns a list of matches with their IDs (e.g. `/facebook/react`,
`/vercel/next.js`). Pick the one that matches the library you need.

## Step 2 — Fetch documentation

```bash
# Basic fetch — ~5 000 tokens of docs
node lookup.js docs /facebook/react

# More context
node lookup.js docs /vercel/next.js --tokens 8000

# Topic-focused (returns docs relevant to that area)
node lookup.js docs /vercel/next.js --topic "app router" --tokens 6000
node lookup.js docs /supabase/supabase --topic "authentication"
node lookup.js docs /prisma/prisma --topic "migrations" --tokens 4000
```

## Options

### search

| Option | Default | Description |
|---|---|---|
| `--num-results N` | 5 | Number of libraries to list |

### docs

| Option | Default | Description |
|---|---|---|
| `--tokens N` | 5000 | Approximate token budget. Increase for broader coverage. |
| `--topic TOPIC` | (all) | Focus docs on a topic area (e.g. "hooks", "routing", "auth") |

## Tips

- If search returns too many generic results, be more specific:
  `"react query tanstack"` beats `"react data fetching"`.
- Increase `--tokens` when you need complete API coverage; 5 000 is
  enough for focused questions, 10 000+ for comprehensive overviews.
- Use `--topic` to target a sub-area; it significantly reduces noise for
  large libraries (Next.js, Supabase, etc.).
- If the docs step returns 404, the library ID from search may have
  changed. Re-run the search step.

## Examples

```bash
# What hooks are available in React?
node lookup.js search "react"
node lookup.js docs /facebook/react --topic "hooks" --tokens 6000

# How does the Next.js App Router work?
node lookup.js search "nextjs"
node lookup.js docs /vercel/next.js --topic "app router" --tokens 8000

# Supabase realtime
node lookup.js search "supabase"
node lookup.js docs /supabase/supabase --topic "realtime" --tokens 5000

# Prisma schema and migrations
node lookup.js search "prisma"
node lookup.js docs /prisma/prisma --topic "schema" --tokens 5000
```
