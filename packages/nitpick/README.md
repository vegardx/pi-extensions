# pi-ext-nitpick

A pi.dev extension that runs a **long-lived reviewer subagent** alongside your
main coding agent. The reviewer sees every `edit`/`write` as it happens,
keeps a running list of simplification opportunities across the whole turn,
and feeds its final consolidated list back to the main agent at `agent_end`.
The main agent applies the fixes directly — you only see the applied/skipped
summary.

## Architecture

There is one background reviewer per session, spawned lazily on the first
eligible edit as `pi --mode rpc --no-session --tools read,grep,find,ls
--append-system-prompt <simplify.md> --model <reviewerModel>`. We talk to it
via `@mariozechner/pi-coding-agent`'s `RpcClient`.

For each `tool_result` (edit or write):

1. Filters run (path exclusions, min-changed-lines, max-bytes, content-hash
   dedupe).
2. A diff/content task is `prompt()`'d to the reviewer.
3. The reviewer replies with its **complete current running list** of
   findings — every reply is a snapshot, not a delta.
4. Calls are serialized internally (one RPC conversation can't run two turns
   at once), but run in parallel with the main agent's work. By the time the
   main agent's turn ends, most reviews are already done.

At `agent_end`:

1. Await any in-flight review.
2. If the reviewer's last reply contains findings, bundle it into a
   follow-up message, flip a one-shot suppression flag, and trigger a new
   turn via `pi.sendMessage({deliverAs: "followUp", triggerTurn: true})`.
3. Reset the reviewer's conversation (`client.newSession()`) so the next
   turn starts with a clean context. The process stays warm — no cold
   start per turn.

The follow-up message is posted with `display: false`, so the bundled review
never shows up in the TUI. You see only the main agent's reply summarising
what it applied and what it skipped.

### Why a long-lived reviewer?

Because later diffs can change or **retract** earlier findings. If the first
edit adds a one-shot helper and the reviewer says "inline it," and the
second edit adds a second call site, the reviewer *already has the context
to retract that bullet* before the list is ever surfaced. You can't get
that behavior from N independent single-shot subagents.

## Activation

On by default. Disable per-session with either:

```bash
pi --nitpick=false          # CLI flag
```

or from inside pi:

```
/nitpick off
```

State (enabled flag) persists for the session via `pi.appendEntry`, so
`/reload` is safe. Per-turn findings are ephemeral. The resolved model is
re-computed at each `session_start` so edits to `settings.json` are
picked up without needing to reconfigure in-session.

## Commands

| Command | Effect |
|---|---|
| `/nitpick` or `/nitpick status` | Show enabled state, resolved model, current in-session override (if any), whether the reviewer process is warm, active review count, and the last error (if any). |
| `/nitpick on` | Enable. |
| `/nitpick off` | Disable, stop the reviewer process, drop any pending findings. |
| `/nitpick model <provider/id>` | Set an in-session model override. Tears down the current reviewer process so the next edit spawns a new one with the new model. Not persisted — for persistent overrides, edit `settings.json`. |
| `/nitpick model clear` | Drop the in-session override; resolution falls back to `settings.json` and then `ctx.model`. |
| `/nitpick show` | Print the reviewer's current findings (or the last error if the reviewer failed). |
| `/nitpick clear` | Drop findings and reset the reviewer's conversation (keeps the process warm). |

## Model selection

Nitpick declares itself a **`normal`-tier** consumer — code review needs
enough reasoning to read diffs and produce structured findings; a
haiku-class model under-performs, an opus-class model is overkill for the
volume.

Resolution order (high → low priority), via
`packages/_shared/model-resolver.ts`:

1. `/nitpick model <provider/id>` — in-session override, not persisted.
2. `settings.json → extensionConfig.nitpick.model` — persistent
   per-extension override.
3. `settings.json → backgroundModels.normal` — the "what does
   `normal` tier mean to me" setting, shared with any future
   `normal`-tier consumer.
4. `ctx.model` — the active session model. Always has auth but may be
   more expensive than necessary.
5. Nothing usable → notify once, reviews disabled for the session.

There are **no hard-coded model IDs**. If you use pi through a gateway
(e.g. `radicalai`, Vercel AI Gateway, OpenRouter), point the resolver
at whatever model your gateway exposes under whatever provider id you
authenticate with:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json (project)
{
  "backgroundModels": {
    "normal": "radicalai/claude-haiku-4-5-20251001"
  }
}
```

Or override per-extension:

```jsonc
{
  "extensionConfig": {
    "nitpick": { "model": "openrouter/anthropic/claude-sonnet-4.5" }
  }
}
```

Start failures surface as TUI warnings and are also visible via
`/nitpick status` (as `lastError`).

## Loop prevention

When nitpick bundles findings and triggers a follow-up turn, it sets a
one-shot suppression flag. Any `edit`/`write` events during that follow-up
turn are **not** sent to the reviewer, and the subsequent `agent_end` does
not surface anything. This guarantees one review round per user turn:
suggestion → apply → done. If you want another review pass on the freshly
applied code, send another user message.

## Guardrails

- Reviewer subagent runs with `--tools read,grep,find,ls` only — it cannot
  edit, write, or run bash.
- Excludes `node_modules/`, `dist/`, `build/`, `.git/`, coverage dirs, venvs,
  plus all common lockfiles and binary asset extensions.
- Skips files > 200 KB and diffs with fewer than 3 changed lines.
- Content-hash dedupe per file — re-editing the same bytes is a no-op.
  Cleared at turn boundaries alongside the reviewer's conversation reset.
- Surface-once / follow-up-turn suppression (above): no nested review rounds.

## Using a local model

The reviewer uses whatever model id you give it, so pointing it at a local
endpoint is a matter of registering the provider and switching:

```ts
// .pi/extensions/local-models.ts
export default (pi) => {
	pi.registerProvider("local-openai", {
		baseUrl: "http://localhost:1234/v1",
		apiKey: "LOCAL_OPENAI_API_KEY",
		api: "openai-completions",
		models: [
			{
				id: "qwen3-coder",
				name: "Qwen3 Coder (local)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 131072,
				maxTokens: 8192,
			},
		],
	});
};
```

Then in pi:

```
/nitpick model local-openai/qwen3-coder
```

## Test

```
pi -e ./packages/nitpick
```

Edit a file through the agent. The status footer will show `nitpick:
reviewing N file(s)` while the reviewer is working. At the end of the turn
the main agent continues with a short "applied / skipped" summary. The
review bundle itself stays hidden.

## Known limitations

- **Node-only transport.** `RpcClient` in `@mariozechner/pi-coding-agent`
  hardcodes `spawn("node", [cliPath, ...args])`. If you run pi via bun
  without node on PATH, the reviewer subprocess will fail to spawn.
- **One reviewer conversation is sequential.** Bursts of near-simultaneous
  edits queue behind each other inside the subagent. The reviews still
  overlap with the main agent's work, which is where the wins come from.
- **Per-turn conversation reset.** The reviewer does not carry findings
  across turns. If you want a cross-turn memory, send another user message
  that re-edits the relevant files.
