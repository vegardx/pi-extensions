# pi-ext-verify

Verify each step of a development plan against the working tree using
parallel read-only subagents.

## What it does

Given a numbered plan (a "Plan:" section with steps, the same shape
`/develop` produces), `/verify` fans out one read-only subagent per
step, each looking only at its own step. Every subagent gets the full
plan for context but reports a verdict for **its** step only:

- `done` — clear evidence in the working tree.
- `partial` — started but incomplete or doesn't fully match the plan.
- `missing` — no evidence the step was done.
- `unverifiable` — can't be checked from the working tree (e.g. "open
  a PR", "send to upstream").

Verdicts come back as JSON, get aggregated into a TUI report, and you
get a picker for what to do next: send findings to the host agent so
it addresses them, save them, or dismiss.

## Try it

```bash
pi -e ./packages/verify
# in pi:
/verify           # picks up the plan from /develop's session state, or
                  # opens a picker (/develop plan, paste inline, cancel)
/verify path/to/plan.md   # read a plan from a markdown file
/verify "Plan:\n1. step ..."   # inline text
```

## Plan source resolution

Order of preference:

1. **Argument as file path** — if `/verify <arg>` and `<arg>` exists
   as a readable file, the file's contents are the plan.
2. **Argument as inline text** — otherwise, the argument string is
   the plan.
3. **`/develop`'s session state** — when no argument is given,
   `/verify` reads the most recent `develop-state` entry from the
   session and uses its `planText` field. This is the typical path
   when the `/develop` plan-complete picker dispatches `/verify`.
4. **Picker** — if neither (1)–(3) produces a plan, an interactive
   picker offers any `/develop` plan it found plus a "paste plan
   inline" option that opens a multi-line editor.

If nothing usable resolves, `/verify` notifies and stops.

## Model selection

`verify` declares itself a **`primary`-set, `fast`-tier** consumer.
Each plan step is a bounded, structured-output task (a JSON verdict),
and under the `/develop` auto-loop verify runs up to 5× per plan, so
cost matters. Fast-tier models handle this kind of focused
working-tree-evidence check well; the verdict parser already
tolerates code-fence wrapping for models that don't strictly obey
JSON-only prompts.

Resolution order (high → low priority):

1. `extensionConfig.verify.model` in `settings.json` — persistent
   per-extension override.
2. `backgroundModels.primary.fast` — the tier-and-set lookup.
3. `ctx.model` — active session model.
4. Nothing usable → notify, `/verify` stops.

Example `settings.json`:

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast":   "anthropic/claude-haiku-4-5-20251001",
      "normal": "anthropic/claude-sonnet-4-5-20250929"
    }
  }
}
```

> **Migration note.** A previous version of this extension declared
> `secondary.normal`. If you'd configured `backgroundModels.secondary.fast`
> or `secondary.normal` specifically for verify, those entries are no
> longer consulted by `/verify` directly. Use `extensionConfig.verify.model`
> if you want to pin a specific model regardless of the tier table.
> The `secondary` set is reserved for future multi-model fan-out
> consumers (e.g. `/review`).

If you want a heavier verifier (e.g. for high-stakes runs), override
via `extensionConfig.verify.model` to a `normal`-tier id. The cost
guardrail (`maxParallel`) still applies.

## Cost guardrail

Each plan step gets its own subagent, run in parallel. For long plans
or expensive models this can rack up cost — the auto-loop runs
`/verify` up to 5× per plan, multiplying the per-run cost. Default
cap on parallel subagents is **15**; tasks beyond that batch behind
the cap.

Configure via `settings.json`:

```jsonc
{
  "extensionConfig": {
    "verify": { "maxParallel": 8 }
  }
}
```

For order-of-magnitude reference: a 10-step plan × `fast` tier on
Anthropic haiku is well under $0.05 per `/verify` run.

## Picker after the report

When the verifier finishes, the report appears in the TUI followed by
a picker (only when there are concerns; if every step is `done` /
`unverifiable` the picker is skipped):

- **Send findings to the agent** — injects a structured follow-up
  message via `pi.sendMessage(..., { triggerTurn: true })`. The host
  agent gets the plan + concerns and is asked to address each one.
- **Save findings** — keeps the report visible; user handles by hand.
- **Dismiss** — verifier was wrong / not actionable; drop the report.

## Integration with `/develop`

`/develop` runs an automated verify loop the moment its plan finishes
executing (every step `[DONE:n]`). It calls `runVerify(...)`
**directly** (in-process, via dynamic `import("pi-ext-verify/core")`).
This bypasses slash-command dispatch entirely —
`pi.sendUserMessage("/cmd")` is hard-coded to skip slash expansion in
pi-coding-agent ≤ 0.73.0 (`expandPromptTemplates: false`; see
badlogic/pi-mono#2549/#2994/#3673), so a `dispatchSlashCommand("/verify")`
approach would deliver `/verify` as literal user text instead of
running the command.

### Public entry point

```ts
import { runVerify } from "pi-ext-verify/core";

await runVerify({
  ctx,                  // ExtensionCommandContext (cwd / sessionManager / signal / ui)
  pi,                   // ExtensionAPI
  planText,             // pre-resolved plan text from /develop's state
  autoMode: true,       // suppress findings picker, write audit-log entry
  iteration: 1,         // recorded on the develop-verify-result entry
});
// → { ran: true, steps, verdicts, errors, model } | { ran: false, abortReason }
```

When `autoMode` is true, `runVerify` writes a `develop-verify-result`
session entry as an audit log; the caller does not need to. Standalone
callers (the `/verify` slash command) leave `autoMode` unset.

### Audit-log entries

The `develop` <-> `verify` coordination still leaves a paper trail in
the session for diagnostics and resume:

| Entry | Writer | Payload |
|---|---|---|
| `develop-verify-request` | `/develop` | `{ iteration, planText, branch, requestedAt }` |
| `develop-verify-result`  | `runVerify` (when `autoMode: true`) | `{ iteration, verdicts, errorCount, model, completedAt }` |

Neither entry is consulted as a transport anymore. `/verify`'s
`findAutoModeIteration` helper still exists (and is unit-tested) for
diagnostic purposes — "is there an unanswered request entry?" — but
the `/verify` command no longer auto-detects auto-mode from session
state; the caller of `runVerify` decides.

For the loop's bail conditions (cap=5, no-progress two iterations
running) and the post-loop picker (review / commit / stay), see
[`packages/develop/README.md`](../develop/README.md#auto-verify-loop-ralph-style).

## Files

- `core.ts` — `runVerify(opts)` plus the pure helpers (`extractPlanSteps`,
  `parseVerdict`, `findAutoModeIteration`). Imported by both the slash
  command handler and `/develop`'s auto-loop.
- `index.ts` — thin extension factory: `declareExtension`,
  `registerCommand("verify")` delegating to `runVerify`. Re-exports
  the pure helpers so tests don't have to reach into `./core`.
- `prompts/verify.md` — system prompt for the per-step verifier
  subagent. Defines the JSON output schema.
- `__tests__/parser.test.ts` — tests for `extractPlanSteps` and
  `parseVerdict` (the pure helpers).
- `__tests__/auto-mode.test.ts` — tests for `findAutoModeIteration`
  (the request/result iteration comparison; now a diagnostic helper).

The shared parallel-subagent infrastructure lives in
[`packages/_shared/parallel-subagent.ts`](../_shared/parallel-subagent.ts).
