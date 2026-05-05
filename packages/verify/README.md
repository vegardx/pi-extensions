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
executing (every step `[DONE:n]`). Coordination uses two
session-state breadcrumb entries; neither extension imports the other.

| Entry | Writer | Reader | Payload |
|---|---|---|---|
| `develop-verify-request` | `/develop` | `/verify` | `{ iteration, planText, branch, requestedAt }` |
| `develop-verify-result`  | `/verify`  | `/develop` | `{ iteration, verdicts, errorCount, model, completedAt }` |

**Auto mode.** When `/verify`'s `findAutoModeIteration` helper finds
a request entry whose iteration is greater than the latest result
entry's iteration, it runs in auto mode:

- Suppresses the post-result findings picker. `/develop` is driving;
  the user shouldn't be asked anything.
- Writes a structured `develop-verify-result` entry with the verdicts
  and error count.
- Dispatches `/develop-verify-resume` (a hidden command registered
  by `/develop`) so the loop driver can consume the result and
  decide retry / bail / clean-exit.

**Standalone mode.** No request entry, or all answered — `/verify`
behaves exactly as before: report plus send/save/dismiss picker.

For the loop's bail conditions (cap=5, no-progress two iterations
running) and the post-loop picker (review / commit / stay), see
[`packages/develop/README.md`](../develop/README.md#auto-verify-loop-ralph-style).

## Files

- `index.ts` — extension factory, command handler, plan-source
  resolution, auto-mode coordination (`findAutoModeIteration` is
  exported for tests), fan-out, report rendering.
- `prompts/verify.md` — system prompt for the per-step verifier
  subagent. Defines the JSON output schema.
- `__tests__/parser.test.ts` — tests for `extractPlanSteps` and
  `parseVerdict` (the pure helpers).
- `__tests__/auto-mode.test.ts` — tests for `findAutoModeIteration`
  (the request/result iteration comparison that drives auto mode).

The shared parallel-subagent infrastructure lives in
[`packages/_shared/parallel-subagent.ts`](../_shared/parallel-subagent.ts).
