# pi-ext-smart-compact

Replaces pi's default auto-compaction summary with a single, work-focused LLM call.

## What it does differently

Default compaction writes a generic chronological summary of the conversation. `smart-compact` instructs the model to first identify **what you are actively working on right now**, then write a summary that optimises for continuing that work — weighting recent decisions, exact file paths, error messages, and next steps over completed or abandoned side-work.

One prompt, one call, no separate analysis step.

## How it works

Hooks `session_before_compact`. When auto-compaction triggers (or you run `/compact`):

1. All messages being compacted (`messagesToSummarize` + `turnPrefixMessages`) are serialised to text.
2. A single LLM call is made with a prompt that asks the model to identify the current task and write a continuity-focused summary.
3. The result replaces what default compaction would have produced. The same recent-message tail is kept (controlled by `keepRecentTokens` in settings).
4. Falls back to default compaction silently on any error.

## Configuration

Uses `backgroundModels.primary.normal` by default. Override per-project or globally:

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

`smart-compact` only changes *what the summary says* — it does not change *when* compaction fires. To make compaction trigger earlier (before the context is nearly full), increase `reserveTokens` in your settings:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 60000
  }
}
```

The default is `16384`, which fires at ~92% of the context window. `60000` fires at ~70% on a 200k model.
