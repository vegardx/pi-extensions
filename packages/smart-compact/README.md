# pi-ext-smart-compact

Replaces pi's default auto-compaction summary with a single, work-focused LLM call.

## What it does differently

Default compaction writes a generic chronological summary of the conversation. `smart-compact` instructs the model to first identify **what you are actively working on right now**, then write a summary that optimises for continuing that work — weighting recent decisions, exact file paths, error messages, and next steps over completed or abandoned side-work.

One LLM call. File operation lists are appended deterministically from pi's tracked file ops — no separate analysis step, no LLM inference of file paths.

## How it works

Hooks `session_before_compact`. When auto-compaction triggers (or you run `/compact`):

1. All messages being compacted (`messagesToSummarize` + `turnPrefixMessages`) are serialised to text.
2. A single LLM call is made with a prompt that asks the model to identify the current task and write a continuity-focused summary.
3. The result replaces what default compaction would have produced. The same recent-message tail is kept (controlled by `keepRecentTokens` in settings).
4. `<read-files>` and `<modified-files>` sections are appended to the summary directly from pi's tracked file operations (`fileOps`), not inferred from the conversation text. This keeps the file lists accurate and saves the model from scanning the entire history for paths.
5. Falls back to default compaction on any error. A one-time warning is shown if no model/auth is configured; runtime failures surface an error notification.

## Configuration

Uses `backgroundModels.primary.normal` by default for the summarization model. Override in order of priority:

1. **Per-extension** — `extensionConfig.smart-compact.model` in `settings.json`
2. **Background tier** — `backgroundModels.primary.normal` in `settings.json` (shared with other extensions on the normal tier)
3. **Session model** — falls back to the active session model

```json
{
  "extensionConfig": {
    "smart-compact": {
      "model": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

## Compaction trigger timing

By default `smart-compact` only changes *what the summary says* — it relies on pi's native `reserveTokens` threshold to decide *when* to compact.

**Option A — extension-owned threshold (`compactAt`)**

Set `extensionConfig.smart-compact.compactAt` to a token count. At the end of each turn, if the context has reached that many tokens, `smart-compact` calls `ctx.compact()` itself:

```json
{
  "extensionConfig": {
    "smart-compact": {
      "compactAt": 100000
    }
  }
}
```

This gives you a single, model-agnostic knob: compact when I have 100k tokens in context, regardless of the model's context window size.

**Option B — pi's native threshold (`reserveTokens`)**

Increase `compaction.reserveTokens` to fire compaction earlier (more tokens reserved for the response = earlier trigger):

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 60000
  }
}
```

The default is `16384` (~92% of context window). `60000` fires at ~70% on a 200k model.
