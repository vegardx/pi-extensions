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

`verify` declares itself a **`secondary`-set, `normal`-tier**
consumer. The point of the secondary set is cross-checking: a user
configures a primary model family for everyday work, a secondary
family for second-opinion checks, and `verify` reads from
`secondary` so its verdicts are independent of whatever model
produced the work being verified.

Resolution order (high → low priority):

1. `extensionConfig.verify.model` in `settings.json` — persistent
   per-extension override.
2. `backgroundModels.secondary.normal` — the tier-and-set lookup.
3. `backgroundModels.primary.normal` — fallback when secondary lacks
   the tier (the resolver's "secondary uses primary as a sensible
   default" rule).
4. `ctx.model` — active session model.
5. Nothing usable → notify, `/verify` stops.

Example `settings.json`:

```jsonc
{
  "backgroundModels": {
    "primary": {
      "normal": "anthropic/claude-sonnet-4-5-20250929"
    },
    "secondary": {
      "normal": "openai/gpt-4o"
    }
  }
}
```

For multi-model checking, configure both sets (primary and secondary)
with different model families. Run `/verify` once with default
(`secondary`); then optionally re-run with an explicit override
pointing at primary's model, and compare. Disagreements are signal
worth investigating.

## Cost guardrail

Each plan step gets its own subagent, run in parallel. For long plans
or expensive models this can rack up cost. Default cap on parallel
subagents is **15**; tasks beyond that batch behind the cap.

Configure via `settings.json`:

```jsonc
{
  "extensionConfig": {
    "verify": { "maxParallel": 8 }
  }
}
```

For order-of-magnitude reference: a 10-step plan × `normal` tier on
Anthropic sonnet is roughly $0.10–0.30 per `/verify` run depending
on per-step context size.

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

When `/develop`'s plan-complete picker offers "Run /verify" (in PR B
of this branch's plan), picking it dispatches `/verify` via
`pi.sendUserMessage("/verify", { deliverAs: "followUp" })`. The
extension reads `/develop`'s session state to pick up the plan
automatically — no argument needed.

## Files

- `index.ts` — extension factory, command handler, plan-source
  resolution, fan-out, report rendering.
- `prompts/verify.md` — system prompt for the per-step verifier
  subagent. Defines the JSON output schema.
- `__tests__/parser.test.ts` — tests for `extractPlanSteps` and
  `parseVerdict` (the pure helpers).

The shared parallel-subagent infrastructure lives in
[`packages/_shared/parallel-subagent.ts`](../_shared/parallel-subagent.ts).
