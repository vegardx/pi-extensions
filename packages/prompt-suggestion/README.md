# pi-ext-prompt-suggestion

Inline ghost-text prompt suggestions for [pi](https://pi.dev), driven by a
sentinel block the main agent emits at the end of each turn.

After pi finishes responding, the extension parses an optional
`<<<NEXT_PROMPT>>>...<<<END>>>` block out of the last assistant message and
renders the contents as dim ghost text inside the input. Press Tab to accept
into the buffer, then Enter to submit. Any other key dismisses the
suggestion. No second LLM call, no extra cost.

## Try it

```bash
pi -e ./packages/prompt-suggestion
```

You also need to teach the agent to emit the sentinel — see
[Setup](#setup).

## Setup

The extension only reads what the agent already produced. If the agent
doesn't emit the sentinel, you get nothing. Append the contents of the
exported `INLINE_SUGGESTION_SYSTEM_ADDENDUM` constant to your `AGENTS.md`
(global `~/.pi/agent/AGENTS.md` is the typical home).

The addendum is short — it tells the agent to optionally append a
sentinel-wrapped one-line guess of your most likely next message at the very
end of each reply, with the literal string `NONE` (or no block) when there's
nothing useful to suggest. Read the source for the full rules:
[`sentinel.ts`](./sentinel.ts).

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `extensionConfig.prompt-suggestion.enabled` | `true` | Set to `false` to disable for the scope. |

Per-scope settings are layered the usual way — global
`~/.pi/agent/settings.json`, then any project-local `.pi/settings.json`
walking up from cwd.

## Behavior

- Fires once per turn, on the `agent_end` event, when the input is empty and
  pi is idle. Never fires while you are typing.
- Only fires after a real interactive submission. Extension-internal turns
  (e.g. `/commit`, `/review`) bypass the editor's `input` event and are
  skipped — you don't want a ghost text suggestion based on a slash-command
  reply.
- Renders a dim suffix inside the editor input. Tab accepts the suggestion
  into the buffer (does not submit); Enter submits the buffer as normal. Any
  other keystroke dismisses the suggestion.
- Suggestions are capped at 120 characters (with a trailing ellipsis).
- Suppressed during session resume (the first synthetic `agent_end` after
  loading a prior session). Comes back on the next real turn.
- Suppressed in non-interactive modes (`pi -p`, RPC).

## Scope and security

The extension only renders predictions and writes the accepted one into the
buffer. It does **not** filter potentially harmful model output. Tab accepts
into the buffer, Enter submits — so you always get a visual confirmation
step. Still, if your workflow involves untrusted content (fetched web pages,
external PRs, third-party READMEs), a malicious suggestion could show up as
ghost text and be Tab-accepted by muscle memory. Command-safety belongs in a
separate, composable extension that intercepts submissions via
`pi.on("input", ...)`.

For display integrity, the parser strips ANSI escapes, C0/C1 control
characters, surrounding quotes/punctuation, and Unicode bidi/format
overrides from the suggestion before it renders. That prevents a suggestion
from corrupting the terminal, but it is not a command-safety filter.

## How it works

pi rejected a first-party ghost-text API
([pi-mono#2355](https://github.com/badlogic/pi-mono/issues/2355)); this
extension is the supported workaround, built on the `CustomEditor` subclass
pattern that pi-mono's `rainbow-editor.ts` and `modal-editor.ts` examples
demonstrate. Credit to [@conarti](https://github.com/conarti)'s
[`feat/tui-ghost-text`](https://github.com/conarti/pi-mono/tree/feat/tui-ghost-text)
fork for the Enter-accept-and-submit semantics used here.

### Files

- `index.ts` — extension factory, event wiring, lifecycle gates.
- `ghost-editor.ts` — `CustomEditor` subclass that paints the dim suffix
  and handles Tab/Enter semantics.
- `sentinel.ts` — sentinel parser + the `INLINE_SUGGESTION_SYSTEM_ADDENDUM`
  string the agent reads.
