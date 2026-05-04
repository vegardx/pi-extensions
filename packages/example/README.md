# pi-ext-example

Minimal reference extension demonstrating the three main API surfaces:

- **Event hook** — notifies on `session_start`.
- **Slash command** — `/hello [name]` notifies with a greeting.
- **Tool** — LLM-callable `greet` tool with a typebox-schema parameter.

## Test

```bash
pi -e ./packages/example
```

Inside pi:
- Type `/hello` (or `/hello Alice`).
- Ask the model: "use the greet tool to greet Alice".

Use this package as a starting template for new extensions, or run `make new-ext NAME=<foo>` from the repo root for a blanker scaffold.
