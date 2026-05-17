# pi-ext-review

Multi-agent review: `/review` fans out seven specialist reviewers in
parallel, dedupes their findings, walks you through every one with
Accept / Skip / Explain, and hands the accepted fixes back to the main
agent as a single batch.

Ported from the `check` plugin in
[awesome-agents](https://dnb.ghe.com/github/awesome-agents), with
JSON-structured reviewer output for robustness and the main agent's
current model used for every reviewer (no separate reviewer model).

## What's inside

- `index.ts` — `/review` command: scope parsing, fan-out, dedupe,
  walk-through UI, final hand-off to the agent.
- `scope.ts` — pure argument → `ReviewScope` parser.
- `findings.ts` — pure: reviewer-output parsing, dedupe, severity promotion,
  severity-sorted ordering.
- `git.ts` — thin `spawnSync` wrappers for the git calls we make.
- `reviewer-client.ts` — spawns one `pi --mode rpc` subagent per role using
  the current model (`ctx.model.provider` / `ctx.model.id`), collects its
  JSON reply, tears it down.
- `lanes.ts` — pure: per-lane `{set, tier}` configuration reader.
  Resolves `extensionConfig.review.lanes.<id>` → `defaultLane` →
  built-in defaults. Used by the auto-review pass.
- `indexer.ts` — Phase 0.5 indexer sub-agent. Emits a structured map
  of the diff (entry points, modules, hot files, risk surfaces, open
  questions) that's threaded into every reviewer's task payload as
  pre-computed evidence. Best-effort; failures are non-fatal.
- `prompts/` — seven role-specific system prompts used by the RPC fan-out
  plus the indexer, orchestrator, and challenger prompts. Every prompt
  enforces valid-JSON-only output.
- `skills/review/SKILL.md` — the orchestrator workflow. Usable standalone
  via `/skill:review` even without the extension.
- `skills/<role>/SKILL.md` (seven files) — per-reviewer standalone
  skills. Invocable as `/skill:architect`, `/skill:code-reviewer`, etc.
  Hidden from the default skill advertisement
  (`disable-model-invocation: true`); still invocable explicitly.
- `__tests__/` — vitest coverage for scope + findings.

## Scopes

```
/review                   # working tree (unstaged + staged)
/review --staged          # staged only
/review --branch          # current branch vs. default
/review --all             # whole codebase, no diff
/review path/to/file.ts   # one or more paths
```

## Reviewers

Seven specialists run in parallel on the same scope. Each one reviews its
own lane and returns `[]` if nothing applies — so on a code-only diff,
dependency-checker returns empty without costing you review time, and on
a dependency-only diff the other six do the same.

- **architect** — coupling, module boundaries, layering, data flow
- **code-reviewer** — bugs, logic, reuse, test coverage, CLAUDE.md
- **scope-analyst** — feature creep, unrelated changes, over-engineering
- **security-analyst** — OWASP Top 10, injection, auth, secrets, supply
  chain, crypto misuse in the project's own code
- **code-simplifier** — redundancy, dead code, idiomatic replacements
- **doc-reviewer** — stale comments, missing API docs, outdated examples
- **dependency-checker** — known CVEs, deprecated packages, lock file
  hygiene, supply-chain red flags in third-party packages

### Per-role standalone skills

Each reviewer is **also available as its own skill** for when you want
one lens without the full fan-out:

```
/skill:architect              # single-lens architecture review
/skill:code-reviewer          # bugs / quality only
/skill:scope-analyst          # scope discipline only
/skill:security-analyst       # security only
/skill:code-simplifier        # simplification only
/skill:doc-reviewer           # docs drift only
/skill:dependency-checker     # dependencies only
```

The standalone skills use the main agent directly (no RPC fan-out),
ask for scope interactively, and present findings as walkable markdown
instead of JSON. They're marked `disable-model-invocation: true` so
they don't clutter the system prompt's skill list by default — they
exist for explicit user invocation.

## How it runs

1. Parse the scope argument.
2. Resolve the diff (or file list for `--all`) from git.
3. Spawn seven `pi --mode rpc` subagents in parallel via `RpcClient`,
   each with `--tools read,grep,find,ls --append-system-prompt
   prompts/<role>.md` and the current provider/model. While they
   run, the status footer shows `reviewing N/7` and a progress
   widget above the editor lists each reviewer with `⏳` (running)
   or `✓` (done) per role — so you can see exactly which
   specialists are still in flight.
4. Each reviewer's prompt gives it the same scope-handling rules: in
   diff scope, review only the changed lines and reply `[]` if nothing
   in its lane appears; in whole-codebase scope, sweep the full tree
   for lane-specific concerns. The reply is a JSON array per its
   prompt. Invalid JSON is surfaced as a per-reviewer warning; the
   rest of the run continues.
5. `dedupeFindings()` collapses by `file:line:title.lower()`, promotes
   severity to the highest seen, tracks consensus (2+ reviewers).
6. Summary report (counts, scope, file totals) is posted to the session.
7. Walk-through via `ctx.ui.select` — CRITICAL → IMPORTANT findings
   first, with Accept / Skip / Explain. **One option per finding is
   marked “(Recommended)” when we have high confidence** (CRITICAL or
   consensus of 2+ reviewers). Accept is recommended when there's a
   concrete `suggestedAction`; Explain is recommended when the issue
   looks real but no concrete fix was proposed. Skip is never
   recommended — being confidently wrong about dismissing an issue is
   worse than leaving the user neutral. The finding card also shows a
   `**Confidence**: high — recommending X (reasons)` line so you can
   see *why*. NOTEs are a read-only batch first, with an opt-in
   “walk NOTEs too” step.
8. Accepted fixes + Explain requests are packaged into a single
   `pi.sendMessage({ deliverAs: "followUp", triggerTurn: true })` to the
   main agent, which applies them and proposes a commit structure.
9. **Chain into `/commit`** — on /review completion, the user is
   asked: "Run `/commit`?". This fires whenever interactive UI is
   available and `/commit` is installed, regardless of whether
   findings were queued for the agent: a clean review (no findings,
   or every finding dismissed) is just as natural a moment to commit
   as a fix-walked one. If yes, the dispatch shape depends on whether
   a fix turn is pending:
   - **Fix turn pending** (the user accepted findings and confirmed
     applying them) — register a one-shot `agent_end` listener that
     fires after the next agent turn ends, then dynamic-import
     `pi-ext-commit/core` and call `runCommit(...)`.
   - **No fix turn pending** (no findings, or none accepted) —
     dynamic-import `pi-ext-commit/core` immediately and call
     `runCommit(...)` straight away.
   No slash dispatch — same in-process pattern `/develop` and
   `/commit → /review` use, for the same reason
   ([badlogic/pi-mono#2549](https://github.com/badlogic/pi-mono/issues/2549)
   / [#2994](https://github.com/badlogic/pi-mono/issues/2994) /
   [#3673](https://github.com/badlogic/pi-mono/issues/3673)). The
   listener is flag-gated and one-shot per opt-in: subsequent
   `agent_end` events are no-ops until another `/review` run opts in.

## Model

`/review` uses the **main agent's current model** — whatever you've set
with `/model` — for every reviewer. This means you only pay once for
model setup and you never hit a "no API key for reviewer" error. If no
model is active when you run `/review`, the command aborts with an error.

## Severity rubric

- **CRITICAL** — must fix: bugs, security vulnerabilities, data-loss
  risks, known-exploited CVEs
- **IMPORTANT** — should fix: quality issues, missing validation,
  complexity, reuse opportunities, deprecated dependencies
- **NOTE** — informational: scope observations, minor simplifications,
  stale CHANGELOG entries

## Test

```bash
pi -e ./packages/review
```

Then in pi:

```
/review --staged          # staged changes
/review                   # working tree
/review --all             # whole codebase (slow)
/review packages/startup/index.ts
```

## Auto-review pass (used by `/develop`)

In addition to the interactive `/review` command, this package exports
`runAutoReview(...)` from `pi-ext-review/auto-review`. It is consumed
by `/develop` after execution completes, before the post-execution picker.

Differences from the interactive `/review` command:

- **Configurable roles** (default: `code-reviewer` and
  `code-simplifier`). Set `extensionConfig.develop.autoReviewRoles`
  to any subset of the seven reviewer roles.
- **Per-lane model resolution.** Each reviewer role, the indexer, and
  the orchestrator can be independently configured to draw from a
  specific `{set, tier}` of `backgroundModels`. Defaults run the
  fan-out on `secondary/normal` (security-analyst on `secondary/heavy`)
  and the orchestrator on `secondary/heavy`. The fan-out is now a
  single secondary-first pass — the older “primary AND secondary in
  parallel” shape is gone. See **Lanes** below.
- **Indexer (Phase 0.5).** Before the reviewer fan-out, a single
  read-only sub-agent emits a structured map of the diff (entry
  points, modules, hot files, risk surfaces, open questions). The
  sketch is threaded into every reviewer's task payload. Failures
  are best-effort: reviewers continue without the index. Disable
  via `enableIndex: false` (programmatic). Configuring the `index`
  lane to a non-existent model does NOT disable the indexer — the
  resolver falls back through `secondary` → `primary` → the active
  session model, so the indexer will still run on a fallback.
- **`consult_other_model` tool** (was `consult_secondary_model`). The
  orchestrator can call this for any CRITICAL finding it is uncertain
  about. The consult model is resolved in the *opposite* set from the
  orchestrator's lane (orchestrator on `secondary` → consult on
  `primary`, and vice versa) so the orchestrator gets a second
  opinion from a different model family. Disable by setting
  `multiModel: false` programmatically (the consult target is then
  not resolved at all).
- **Confidence-based split** (Phase 3): findings are split by
  confidence and whether a concrete fix is available:
  - `confidence: "high"` + `suggestedAction` → fix prompt queued for
    the host agent.
  - `confidence: "high"/"medium"` without fix → discussion prompt:
    the host agent surfaces the finding to the user.
  - `confidence: "low"` + CRITICAL → surface with caveat.
  - `confidence: "low"` + IMPORTANT/NOTE → dropped.
- **Verification handoff** (Phase 4): auto-applying findings are
  delivered as a single batched `auto-review-followup` message; the
  host agent applies, runs tests, and reports back. The orchestrator
  never modifies files — the boundary is explicit.
- **No interactive walk**: there is no Accept / Skip / Explain picker.
  The fix and discussion prompts are sent directly via
  `pi.sendMessage(..., { triggerTurn: true })`.

### Lanes

The nine lanes (seven reviewer roles + `index` + `orchestrator`) each
resolve to one `{set, tier}` pair. Resolution order, high → low:

1. `extensionConfig.review.lanes.<laneId>` — explicit per-lane override.
2. `extensionConfig.review.defaultLane` — a single fallback for every
   lane that doesn't have an explicit override.
3. Built-in defaults (table below).

Built-in defaults:

| Lane                | set       | tier   |
| ------------------- | --------- | ------ |
| `index`             | secondary | normal |
| `architect`         | secondary | normal |
| `code-reviewer`     | secondary | normal |
| `scope-analyst`     | secondary | normal |
| `security-analyst`  | secondary | heavy  |
| `code-simplifier`   | secondary | normal |
| `doc-reviewer`      | secondary | normal |
| `dependency-checker`| secondary | normal |
| `orchestrator`      | secondary | heavy  |

Invalid entries (unknown set, unknown tier, missing fields) at any
layer are skipped — they fail closed to the next layer rather than
leaking malformed config to the resolver. Resolution itself can still
fail (the `{set, tier}` slot may not be configured under
`backgroundModels`); the model resolver's own fall-through (e.g.
`secondary` → `primary` for the same tier) then applies. A reviewer
role that resolves to no model at all is dropped with a warning; the
run continues with the remaining lanes.

Settings:

```jsonc
{
  "backgroundModels": {
    "primary":   { "heavy": "anthropic/claude-opus-4", "normal": "anthropic/claude-sonnet-4-20250514" },
    "secondary": { "heavy": "openai/gpt-4-turbo",     "normal": "openai/gpt-4o" }
  },
  "extensionConfig": {
    "develop": {
      "autoReview": false,           // disable entirely
      "autoReviewRoles": ["code-reviewer", "code-simplifier"],
      "autoReviewMultiModel": true    // false = no consult tool surface
    },
    "review": {
      "defaultLane": { "set": "secondary", "tier": "normal" },
      "lanes": {
        "orchestrator":     { "set": "secondary", "tier": "heavy" },
        "security-analyst": { "set": "secondary", "tier": "heavy" },
        "index":            { "set": "primary",   "tier": "fast"  }
      }
    }
  }
}
```

If a model tier is unresolvable the pass falls through per the lane
resolution order; if no lane resolves at all the pass is skipped
(fail-open: the user still gets the post-execution picker).

## Known limitations

- **Node-only transport.** `RpcClient` in `@mariozechner/pi-coding-agent`
  spawns `node`; if you run pi via bun without node on PATH, reviewer
  subprocesses won't start.
- **Seven concurrent RPC subagents.** On `--all` over a large codebase
  this is genuinely expensive — run it selectively.
- **Reviewer JSON is trusted.** A reviewer can claim a finding is
  CRITICAL when it's actually a style nit. Walk findings with a critical
  eye — severity is a hint, not a verdict.
- **Local only.** PR review (fork-aware checkout, push-to-update) is not
  implemented yet; run `/review` on a local working tree or branch.
- **No fix validation.** When the main agent applies accepted fixes, the
  extension doesn't re-run the reviewers to confirm. Run `/review`
  again after the fixes are committed if you want a clean pass.
