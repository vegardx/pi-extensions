# pi-ext-prompt-suggestion

Claude-Code-style inline ghost-text prompt suggestions for [pi](https://pi.dev).

After pi finishes responding, a secondary model (Haiku 4.5 by default)
predicts your next message and renders it as dim ghost text inside the input.
Press Tab to accept the suggestion into the buffer, then Enter to submit.
Any other key dismisses the suggestion.

## Try it

```bash
pi -e ./packages/prompt-suggestion
```

## Requirements

- An API key for whichever provider backs the suggestion model. No
  hard-coded default — see **Model selection** below for how the
  extension figures out which model to use.
- Any model available through `ctx.modelRegistry.find()` works — swap
  via `/suggest`, `--suggest-model=...`, or `settings.json`. Local
  Ollama, OpenAI, Groq etc. all work once pi itself can authenticate
  to them.

If no model can be resolved, or the resolved model has no API key,
the extension surfaces a single `notify()` warning for the session
and disables suggestions silently thereafter — it will not spam on
every turn.

## Scope and security

This extension only renders predictions and writes the accepted one into the
buffer. It does **not** filter potentially harmful model output. Tab accepts
into the buffer, Enter submits — so you always get a visual confirmation
step between the prediction and pi's agent. Still, if your workflow involves
untrusted content (fetched web pages, external PRs, third-party READMEs), a
malicious prediction could show up as ghost text and be Tab-accepted by
muscle memory.

Command-safety belongs in a separate, composable extension that intercepts
submissions via `pi.on("input", ...)` and rejects or rewrites dangerous
patterns. This extension stays narrowly focused on the prediction UX; layer
a safety extension on top if you want hard guarantees.

For display integrity, `sanitize()` strips ANSI escapes, C0/C1 control
characters, and Unicode bidi/format overrides from the suggestion before it
renders. That prevents a prediction from corrupting the terminal, but it is
not a command-safety filter.

## Behavior

- Fires once per turn, on the `agent_end` event, when the input is empty and
  pi is idle. Never fires while you are typing.
- Renders a dim suffix inside the editor input. Tab accepts the suggestion
  into the buffer (does not submit); Enter submits the buffer as normal. Any
  other keystroke dismisses the suggestion and cancels the in-flight
  prediction.
- Predictions are capped at 120 characters (with a trailing ellipsis) as a
  belt-and-braces guard on top of the 10-word limit.
- Suppressed during session resume (the first synthetic `agent_end` after
  loading a prior session). Comes back on the next real turn.
- Suppressed in non-interactive modes (`pi -p`, RPC).

## Flags

| Flag | Default | Description |
|---|---|---|
| `--suggest` | `true` | Enable/disable the feature for this run |
| `--suggest-model` | _(unset)_ | `provider/modelId` to use (session override). Without this, the resolver decides; see **Model selection** below. |

## Commands

| Command | Effect |
|---|---|
| `/suggest` | Interactive picker: list of models with configured auth, plus an "off" option. Selection persists in `~/.pi/agent/prompt-suggestion.json`. |
| `/suggest-status` | Dump the extension's runtime state for debugging |

## Model selection

Prompt-suggestion declares itself a **`fast`-tier** consumer — ghost
text runs on every `agent_end` and wants a cheap, fast model.

Resolution order (high → low priority):

1. `/suggest` picker selection — persisted in
   `~/.pi/agent/prompt-suggestion.json`.
2. `--suggest-model=<provider/id>` CLI flag — session override.
3. `settings.json → extensionConfig.prompt-suggestion.model` —
   persistent per-extension override.
4. `settings.json → backgroundModels.fast` — the "what does `fast`
   tier mean to me" setting, shared with any other `fast`-tier
   consumer.
5. `ctx.model` — the active session model. Always has auth but may
   be more expensive than necessary for background calls.
6. Nothing usable → notify once, ghost text disabled for the session.

No hard-coded model IDs. Example `settings.json`:

```jsonc
{
  "backgroundModels": {
    "fast": "anthropic/claude-haiku-4-5-20251001"
  },
  "extensionConfig": {
    "prompt-suggestion": { "model": "openai/gpt-4o-mini" }
  }
}
```

## How it works

pi rejected a first-party ghost-text API
([pi-mono#2355](https://github.com/badlogic/pi-mono/issues/2355)); this
extension is the supported workaround, built on the `CustomEditor` subclass
pattern that pi-mono's `rainbow-editor.ts` and `modal-editor.ts` examples
demonstrate. Credit to [@conarti](https://github.com/conarti)'s
[`feat/tui-ghost-text`](https://github.com/conarti/pi-mono/tree/feat/tui-ghost-text)
fork for the Enter-accept-and-submit semantics used here.

### Files

- `index.ts` — extension factory (flags, commands, event wiring)
- `ghost-editor.ts` — `CustomEditor` subclass that paints the dim suffix
- `predictor.ts` — model call, message trimming, `AbortController` plumbing
- `__tests__/predictor.test.ts` — unit tests for the pure helpers
