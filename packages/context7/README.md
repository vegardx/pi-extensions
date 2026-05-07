# pi-ext-context7

On-demand Context7 library documentation skill for pi. Resolves up-to-date
library docs on demand via the [Context7 REST API](https://context7.com) —
no MCP server, no background process.

## What it provides

A single skill `context7` that the agent loads on-demand when a task calls
for current library documentation. The skill drives a Node.js script that
calls the Context7 API directly using Node.js built-in `fetch` — no extra
npm dependencies required.

**No API key required.** The Context7 API is public. Set `CONTEXT7_API_KEY`
in your environment if you have one — it is sent as a `Bearer` token and
gives higher rate limits.

## Setup

No installation step needed — the script uses Node.js 18+ built-in `fetch`.
Just make sure you're running Node ≥ 18:

```bash
node --version  # should be v18.0.0 or newer
```

Optionally export your API key for higher rate limits (add to `~/.zshrc` or
equivalent):

```bash
export CONTEXT7_API_KEY=your-key
```

## Usage

The skill is loaded automatically by pi when a task calls for library
documentation. You can also force-load it with:

```
/skill:context7
```

Then ask the agent about a library, e.g.:

```
Look up how Supabase realtime subscriptions work
Look up the Next.js App Router API
Show me how to use Prisma migrations
```

### Direct CLI use

The two-step workflow:

```bash
cd packages/context7/skills/context7

# Step 1: find the library ID
node lookup.js search "react"
node lookup.js search "nextjs" --num-results 5

# Step 2: fetch docs
node lookup.js docs /facebook/react --topic "hooks" --tokens 6000
node lookup.js docs /vercel/next.js --topic "app router" --tokens 8000
```

## Why a skill instead of an MCP server?

The official Context7 MCP server is a persistent background process that
consumes resources and must be configured in every host that wants to use
it. This skill achieves the same result — fresh, version-aware docs — with:

- **No background process**: the script runs, returns output, and exits.
- **No configuration**: no MCP host setup, no JSON config blocks.
- **On-demand loading**: only the one-line description enters the system
  prompt at startup; full instructions are loaded only when the agent
  needs them.
- **Zero extra dependencies**: Node.js 18+ `fetch` is sufficient.
