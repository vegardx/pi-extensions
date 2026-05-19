# pi-ext-prompt-suggestion

Inline ghost-text prompt suggestions for [pi](https://pi.dev), delivered via
a hidden `suggest_next_prompt` tool call the main agent makes at the end of
each turn.

After pi finishes responding, the agent (optionally) calls
`suggest_next_prompt(text: "…")` as its final action. The extension routes
the string into the input as dim ghost text. Press Tab to accept into the
buffer, then Enter to submit. Any other key dismisses the suggestion. No
second LLM call, no extra cost.

The tool call is rendered as a zero-height row, so suggestions never appear
in the visible stream, the transcript, `/export`, or session resume — the
ghost text is the only visible artifact.

## Try it

```bash
pi -e ./packages/prompt-suggestion
```

You also need to teach the agent to call the tool — see [Setup](#setup).

## Setup

The agent only learns about the tool when you paste the calling contract
into your `AGENTS.md`. Without it, the tool stays unused and you get no
ghost text.

Append the contents of the exported `INLINE_SUGGESTION_SYSTEM_ADDENDUM`
constant to your `AGENTS.md` (global `~/.pi/agent/AGENTS.md` is the typical
home). It's a short paragraph that tells the agent to call
`suggest_next_prompt` at most once at the very end of a reply, with one
short imperative sentence directing your most likely next instruction.

> **Migrating from the sentinel addendum?** This release replaced the
> text-in-band sentinel transport with a tool call. If you pasted the
> previous `<<<…>>>`-bracketed addendum, replace it with the new wording
> from `INLINE_SUGGESTION_SYSTEM_ADDENDUM`. The constant is exported from
> this package's `index.ts`.

Read the source for the full wording:
[`sanitise.ts`](./sanitise.ts).

## Configuration

| Setting | Default | Effect |
|---|---|---|
| `extensionConfig.prompt-suggestion.enabled` | `true` | Set to `false` to disable for the scope. |

Per-scope settings are layered the usual way — global
`~/.pi/agent/settings.json`, then any project-local `.pi/settings.json`
walking up from cwd.

## Behavior

- Fires when the agent calls `suggest_next_prompt` at the end of a turn,
  provided the input is empty and pi is idle. Never fires while you're
  typing.
- Only fires after a real interactive submission. Extension-internal turns
  (e.g. `/commit`, `/review`) bypass the editor's `input` event and are
  skipped — you don't want a ghost text suggestion based on a slash-command
  reply.
- Renders a dim suffix inside the editor input. Tab accepts the suggestion
  into the buffer (does not submit); Enter submits the buffer as normal. Any
  other keystroke dismisses the suggestion.
- Suggestions are capped at 120 characters (with a trailing ellipsis).
- Suppressed in non-interactive modes (`pi -p`, RPC).
- The tool returns `terminate: true`, so calling it ends the agent's turn
  without an extra LLM round-trip.

## Scope and security

The extension only renders suggestions and writes the accepted one into the
buffer. It does **not** filter potentially harmful model output. Tab accepts
into the buffer, Enter submits — so you always get a visual confirmation
step. Still, if your workflow involves untrusted content (fetched web pages,
external PRs, third-party READMEs), a malicious suggestion could show up as
ghost text and be Tab-accepted by muscle memory. Command-safety belongs in a
separate, composable extension that intercepts submissions via
`pi.on("input", ...)`.

For display integrity, the sanitiser strips ANSI escapes, C0/C1 control
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

The hidden tool transport replaced an earlier sentinel-in-prose protocol —
the agent emitted a bracketed sentinel block at the end of each reply and
the extension parsed it out. That worked but leaked the sentinel into the
visible stream, transcripts, `/export` HTML, and session resume. The tool
call is invisible at every layer.

### Files

- `index.ts` — extension factory, event wiring, lifecycle gates, tool
  registration.
- `ghost-editor.ts` — `CustomEditor` subclass that paints the dim suffix
  and handles Tab/Enter semantics.
- `sanitise.ts` — input sanitiser + the `INLINE_SUGGESTION_SYSTEM_ADDENDUM`
  string the agent reads.
