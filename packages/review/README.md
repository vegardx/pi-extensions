# pi-ext-review

Multi-lens review pipeline behind the **`reviewer` delegate target**.
There is no `/review` command: the agent (or a TS-side consumer like
`/commit`) invokes the pipeline through the `subagent` extension's
`delegate` tool, and the curated findings come back as a summary text
plus structured `details`.

```
delegate({ to: "reviewer", message, params?: { lenses?, scope?, artifactDir? } })
```

Hard-depends on `subagent` (`dependsOn: ["subagent"]`) — without the
delegate tool there is no way to reach the pipeline.

## Pipeline

```
Stage 0    scanners        tsc / biome / npm audit / … (deterministic, pre-AI)
Stage 0.5  indexer         structured sketch of the diff, threaded into every lens
Stage 1    lens fan-out    generic · code-review · security · simplification (parallel)
Stage 2    curator         fuzzy dedupe + cross-validation + confidence
Stage 3    split           high+fix → autoApplied · high/medium or low-CRITICAL → surfaced · rest dropped
```

The full report is written as an artifact under `<agentDir>/review/`
(override via `params.artifactDir`); the text that crosses back through
the delegate tool is a compact summary, so big reviews never blow up
the caller's context. TS-side consumers read `details`
(`RunReviewerResult`: `findings`, `autoApplied`, `surfaced`, `errors`,
`artifactPath`, …) — e.g. `/commit` walks them with Accept / Skip /
Explain.

## Lenses

Four lenses run in parallel on the same scope. Each reviews its own
lane and returns `[]` when nothing applies.

- **generic** — structure (coupling, boundaries, layering, data flow),
  scope discipline, documentation drift, dependency hygiene
- **code-review** — bugs, logic, reuse, test coverage, convention
  compliance
- **security** — OWASP Top 10, injection, auth, secrets, crypto
- **simplification** — dead code, redundant abstraction, verbose
  patterns, misleading names

Each lens also exists as a standalone skill
(`/skill:generic`, `/skill:code-review`, `/skill:security`,
`/skill:simplification`; `disable-model-invocation: true`).

## Scope

`params.scope`:

- `"auto"` (default) — branch diff vs. the default branch, falling back
  to the working tree when the branch diff is empty.
- `"branch"` / `"working"` — force one; the run aborts when that diff
  is empty.

## Models

Each agent (four lenses + `indexer` + `curator`) resolves its model
independently:

1. `extensionConfig.review.models.<agent>` = `{ "set", "tier" }`
2. `extensionConfig.review.defaultModel` = `{ "set", "tier" }`
3. Built-ins: `security` and `curator` on `secondary.heavy`, everything
   else on `secondary.normal`.

```json
{
  "extensionConfig": {
    "review": {
      "models": { "security": { "set": "primary", "tier": "heavy" } },
      "defaultModel": { "set": "secondary", "tier": "normal" }
    }
  }
}
```

## What's inside

- `index.ts` — extension wrapper; registers the `reviewer` delegate
  target.
- `run-reviewer.ts` — the pipeline (`runReviewer(opts, ctx)`), with an
  injectable `deps` seam so tests stub every stage. Stage budgets
  derive from the delegate `timeoutMs` when present, else from the
  diff-proportional heuristic.
- `lens-client.ts` — one lens = one `runSubagent` call; JSON parsing +
  the `reviewTimeoutMs` heuristic.
- `curator.ts` — one-shot synthesis subagent with read-only code
  access.
- `models.ts` — pure per-agent `{set, tier}` resolution.
- `findings.ts` — pure finding types (`LensId`, `RawFinding`,
  `OrchestratedFinding`), parsing, dedupe.
- `indexer.ts` — Stage 0.5 diff sketch. Best-effort; failures are
  non-fatal.
- `static-checker.ts` + `scanners/` — Stage 0 deterministic tools.
- `git.ts` — thin `spawnSync` wrappers.
- `prompts/` — the four lens prompts + `indexer.md` + `curator.md`.
  Every prompt enforces valid-JSON-only output.
- `skills/<lens>/SKILL.md` — standalone single-lens skills.
- `__tests__/` — vitest coverage (pipeline with stubbed stages, models
  config, findings, scanners, target registration).

## Consumers

- **`/commit`** offers a pre-commit review when
  `getDelegateTarget("reviewer")` is present, walks the curated
  findings (confidence-driven Accept / Skip / Explain), queues accepted
  fixes to the agent, awaits idle, then continues to its commit plan.
- **`modes`** offers "Run review (branch scope)" in its post-exec
  picker.
- Cross-extension consumers may only `import type` from this package
  (enforced by `scripts/check-cross-extension-imports.mjs`); all value
  access goes through the delegate registry.
