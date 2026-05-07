# pi-ext-develop

Plan a change before you code it, with **plan-phase tool lockdown**,
**structured todo extraction**, and **live `[DONE:n]` progress tracking**
during execution. `/develop <description>` syncs you to the default
branch, restricts tools to read-only exploration, drives plan-mode, then
pops an Implement / Park / Continue-discussing picker the moment the plan
is ready. With **thin or no arguments**, `/develop` first runs a short
intake conversation so the agent can ask clarifying questions before it
starts planning. `/sync` keeps the old fast-forward-only behavior.

Ported from the `feature` + `sync` plugins in
[awesome-agents](https://dnb.ghe.com/github/awesome-agents), with the
plan-phase lockdown and progress tracking patterns borrowed from pi's
own `examples/extensions/plan-mode/`.

## What's inside

- `index.ts` — registers `/develop`, `/implement`, `/park`,
  `/develop-choose`, `/develop-todos`. Handles phase state, tool
  lockdown, context injection, plan extraction, `[DONE:n]` parsing,
  widget rendering, and session resume.
- `helpers.ts` — pure functions (prefix derivation, slug, secret scan,
  issue title). Unit-tested.
- `git.ts` — thin, no-throw shell wrappers for the git calls we make.
- `plan-utils.ts` — pure plan-extraction and progress helpers:
  `extractTodoItems`, `markCompletedSteps`, `extractDoneSteps`,
  `isSafeCommand` (implementation in `packages/_shared/plan-utils.ts`,
  re-exported here), `cleanStepText`. Ported from pi's `plan-mode`
  example, unit-tested.
- `skills/develop/SKILL.md` — the plan-mode workflow. Usable standalone
  via `/skill:develop` even without the extension loaded.
- `__tests__/helpers.test.ts` + `__tests__/plan-utils.test.ts` — 50+
  tests covering prefix / slug / secret-scan / title and plan / DONE
  / safety logic.

## Commands

| Command | Effect |
|---|---|
| `/develop` (no args, or thin args) | Sync to default branch, then enter **intake phase**: read-only tools plus a `develop_ready` sentinel tool. The agent asks focused clarifying questions until it understands the intent, then calls `develop_ready` and the extension transitions into plan phase automatically. |
| `/develop <substantive description>` | Same sync, then skip intake and enter **plan phase** directly: restrict tools to `read`/`grep`/`find`/`ls` plus a read-only bash allowlist, and hand off a plan-mode follow-up message to the agent. After the agent finishes the plan, the extension extracts numbered steps and pops a picker. |
| `/sync` | Verify repo → dirty-tree guard → detect default branch → checkout + pull. Equivalent to the pre-intake no-args `/develop` behavior. |
| `/implement` | Create the feature branch, rename the session (inheriting the smart slug), restore full tools, enter **execution phase**. Works any time after `/develop <desc>`. |
| `/park` | Scan the (snapshotted) plan for secrets, `gh issue create`, persist `branch.<name>.tracking-issue <N>` in git config. Works any time after `/develop <desc>`. |
| `/develop-choose` | Re-open the three-way picker — useful if you dismissed it with ESC. |
| `/develop-todos` | Show the current plan progress (non-blocking notification). |

*Thin* means fewer than 5 alphanumeric tokens — enough to disambiguate `/develop add payment webhooks with idempotency` (skips intake) from `/develop fix bug` (enters intake).

## Phase lifecycle

```
/develop (thin/empty)  →  awaiting-intake
                         tools: read/grep/find/ls + safe bash + develop_ready
                         widget: "❔ intake — gathering context"
                                       │
                                       │  agent calls develop_ready({description})
                                       ↓
/develop <desc>          awaiting-plan  →  awaiting-choice  →  executing  →  exec-complete  →  auto-reviewing  →  awaiting-auto-review-fix  →  consumed
                         │                   │                                       │
                         │                   ├─ Park ──────────────────────────────────────→ consumed
                         │                   └─ Continue ────────────────────────────────→ dormant
                         │
                         └─ tools: read/grep/find/ls + safe bash
                            widget: "📋 planning <branch>"
```

- **awaiting-intake** — agent is asking clarifying questions; tools
  locked to read-only plus `develop_ready`. No branch picked yet.
- **awaiting-plan** — agent is writing the plan; tools locked down.
- **awaiting-choice** — plan done, todos extracted, picker armed.
- **executing** — branch created, full tools, `[DONE:n]` parsing live.
- **exec-complete** — all todos marked done; auto-review pass fires
  (or is skipped) and the post-execution picker opens.
- **auto-reviewing** — configured reviewer roles running against the
  configured model tier(s). No user prompt; transitions to
  `awaiting-auto-review-fix` (when findings were queued for the agent)
  or directly to the post-execution picker (nothing to apply).
- **awaiting-auto-review-fix** — host agent is applying the auto-review
  fixes or discussing findings with the user. Next `agent_end` fires
  the post-execution picker.
- **dormant** — user chose "Continue discussing"; lockdown lifted but
  `/implement` / `/park` still work.
- **consumed** — post-loop picker resolved (or Park fired). Terminal
  state. `/develop <desc>` will clear it.

## Intake phase

When the description is thin (or empty), `/develop` enters intake instead
of going straight to plan mode. The extension:

1. Syncs to the default branch (same as before).
2. Activates `INTAKE_PHASE_TOOLS = read/grep/find/ls + safe bash + develop_ready`.
3. Sends a follow-up prompt instructing the agent to read just enough
   of the repo to ask focused questions, ask the user one tight batch
   at a time (max ~3 turns), and call `develop_ready({ description })`
   when it understands the intent well enough to plan.
4. The `develop_ready` tool handler validates non-empty input, derives
   a smart branch name via `deriveBranchNameWithModel`, transitions
   the phase to `awaiting-plan`, drops `develop_ready` from the active
   set, and queues the standard plan-phase prompt as a follow-up.

If the agent's input is already specific enough, the prompt tells it to
skip the questions and call `develop_ready` immediately — no extra
latency for clear inputs that fall under the heuristic threshold.

## Tool lockdown during plan phase

When `/develop <desc>` starts, the extension:

1. Snapshots the current toolset with `pi.getActiveTools()`.
2. Calls `pi.setActiveTools(["read", "bash", "grep", "find", "ls"])` —
   edit/write are dropped from the schema so the model doesn't even
   see them.
3. Registers a `tool_call` handler that returns `{ block: true, reason }`
   for any `edit` / `write` call (belt-and-braces) and for any `bash`
   command that doesn't match the read-only allowlist in `plan-utils.ts`.

When the picker resolves (Implement / Park / Continue discussing), the
extension calls `pi.setActiveTools(priorTools)` to restore the original
set. Custom tools the user had registered before `/develop` come back.

The bash allowlist covers `cat`, `head`, `tail`, `less`, `grep`, `find`,
`ls`, `pwd`, `echo`, `wc`, `sort`, `uniq`, `diff`, `file`, `stat`, `du`,
`df`, `tree`, `which`, `git status|log|diff|show|branch|remote|ls-…`,
`npm list|view|info|search|outdated|audit`, `yarn list|info|why|audit`,
`node --version`, `python --version`, `jq`, `sed -n`, `awk`, `rg`, `fd`,
`bat`, `eza`. Anything with redirection, `rm`, `mv`, `cp`, `mkdir`,
`touch`, `sudo`, package-install, git-write, or editor patterns is
blocked explicitly.

## Plan extraction

When the plan-phase turn ends, the extension:

1. Captures the last assistant message verbatim (the "plan snapshot" —
   used by `/park`, immune to subsequent chat).
2. Runs `extractTodoItems(planText)` — parses numbered steps under a
   `Plan:` header (plain, bolded, or inside a heading are all accepted;
   `1.` or `1)` numbering; first 60 chars used for the widget label;
   lines starting with `` ` ``, `/`, or `-` are skipped as code/paths/bullets).
3. Shows the parsed todo list as a `display: true` custom message so
   the user sees what the extension is about to track.
4. Pops the picker.

If no `Plan:` header is found, the extension notifies the user that
progress tracking will be off, but still runs the picker — you can
still Implement / Park, you just don't get `[DONE:n]` tracking.

## Execution-phase progress tracking

When the user picks Implement:

1. `git checkout -b <branch>` (or `git checkout <branch>` if it already
   exists).
2. `pi.setSessionName(branch)`.
3. Restore full tools.
4. Inject a `CUSTOM_EXECUTE_MARKER` message into the session so session
   resume can re-scan `[DONE:n]` markers starting from that point.
5. `pi.sendMessage({ deliverAs: "followUp", triggerTurn: true })` with
   a short nudge: "Feature branch `<branch>` is ready. Begin executing
   the plan. Remember to emit `[DONE:n]` markers as you finish each step."

The extension's `before_agent_start` handler injects a fresh
execution-context message at the start of **every** execution turn
listing the still-incomplete steps — so even if the context gets
compacted, the agent re-learns "here's what's left" each turn.

On every `turn_end`, the extension reads the assistant text, runs
`markCompletedSteps(text, todos)`, updates the widget, and persists.

When `todos.every(t => t.completed)`, the extension emits a "Plan
complete" message and **automatically kicks off the auto-review pass**
(see below) instead of asking the user what to do next.

## Auto-review pass (post-execution, cross-model consensus)

Once execution finishes, `/develop` transitions to `exec-complete` and
then runs a configurable **auto-review pass** before the post-execution
picker. The pass uses the reviewer lanes and model mode configured in
`extensionConfig.develop`.

```
  executing (all [DONE:n])
        ↓
  exec-complete
        ↓
  auto-reviewing        — reviewer subagents fan out in parallel
        ↓
  awaiting-auto-review-fix  (when findings were queued)
        ↓  next agent_end
  exec-complete → runPostExecutionPicker

  … or directly exec-complete → runPostExecutionPicker when no
  findings or the pass is skipped.
```

There is no retry loop. The pass fires once, results are applied
(or surfaced for discussion), and then the picker opens.

### Challenge phase (cross-model, CRITICAL findings only)

When `autoReviewMultiModel` is true (default), after the primary
fan-out `/develop` runs a second-pass **challenge** for every CRITICAL
finding that only one model tier flagged. Non-determinism means a real
bug found by primary may not appear in secondary's output — not because
they disagree, but because sampling varies. The challenger evaluates
the specific finding against the diff and responds with agree/disagree.
Agreed findings are promoted to cross-model consensus (annotated with
† in the report).

### Findings routing

- **Consensus + `suggestedAction`** — auto-applied: queued for the
  host agent as a fix prompt.
- **Consensus + no `suggestedAction`** — surfaced: host agent is asked
  to present the finding to the user (fix / investigate / skip).
- **Single-tier, not challenged (IMPORTANT/NOTE or challenge disagreed)** — dropped.
  Run `/review` for the full seven-lane interactive pass.

## Configuration

All auto-review knobs are under `extensionConfig.develop`:

| Key | Default | Effect |
|---|---|---|
| `autoReview` | `true` | Enable/disable the auto-review pass entirely. |
| `autoReviewRoles` | `["code-reviewer","code-simplifier"]` | Which reviewer lanes to run. Valid values: `architect`, `code-reviewer`, `scope-analyst`, `security-analyst`, `code-simplifier`, `doc-reviewer`, `dependency-checker`. |
| `autoReviewMultiModel` | `true` | When `true`, each role runs against `primary.heavy` + `secondary.heavy` and only cross-model consensus findings are acted on. When `false`, only `primary.heavy` is used and all findings with a `suggestedAction` are applied. |

```jsonc
{
  "backgroundModels": {
    "primary":   { "heavy": "anthropic/claude-opus-4" },
    "secondary": { "heavy": "openai/gpt-4-turbo" }
  },
  "extensionConfig": {
    "develop": {
      "autoReview": true,
      "autoReviewRoles": ["code-reviewer", "code-simplifier"],
      "autoReviewMultiModel": true
    }
  }
}
```

Set `primary` and `secondary` to two different model families for the
cross-model challenge to be meaningful. If both point at the same model
every finding becomes consensus trivially.

## Session resume

State is persisted via `pi.appendEntry("develop-state", …)`, so `/reload`
and re-opening a session both restore:

- Phase, description, branch, default branch, todos, plan snapshot.
- Tool lockdown if we were mid-plan-phase.
- `[DONE:n]` state during execution: on resume, the extension walks
  session entries after the most recent `CUSTOM_EXECUTE_MARKER` and
  re-runs `markCompletedSteps` over the assistant text, so the widget
  shows the true cumulative progress.

## Branch prefix rules

Same table as the awesome-agents `/feature` skill. See
`skills/develop/SKILL.md` for the full list. Ambiguous or unmatched
descriptions fall back to `feat/`.

## Park snapshot (the `/park` bug-fix)

Earlier drafts of this extension pulled the plan from "the most recent
assistant text" at `/park` time. That's fragile — if you discussed the
plan after it was produced, `/park` could capture a conversational
reply instead of the plan body. The current version stashes the plan
text the moment the plan-phase turn ends, and `/park` reads from that
snapshot. Falls back to "last assistant text" only if no snapshot
exists (for the degraded "no `Plan:` header" case).

## Test

```bash
pi -e ./packages/develop
```

Try:
```
/sync                          # fast-forward to the default branch
/develop                       # intake — agent asks what to build
/develop fix bug               # intake — agent asks for specifics
/develop add payment webhooks with idempotency  # skips intake
/develop-todos                 # show progress mid-execution
```

## Known limitations

- **`gh` required for the park path.** If `gh` isn't installed or
  authed, `/park` reports the error and stops.
- **Park is single-host.** `gh` auto-detects the host from the current
  remote. For non-default hosts, set `GH_HOST` or use a cloned-remote
  URL that already points at the right instance.
- **Tool lockdown is best-effort.** The model still sees the
  plan-phase system prompt claiming full tools in theory — we drop
  edit/write from the schema but `pi.setActiveTools` doesn't stop a
  model from *asking* for a blocked tool. That's what the `tool_call`
  blocker is for.
- **`[DONE:n]` depends on the model cooperating.** If the agent
  doesn't emit markers, progress tracking stays at 0/N. The user can
  read the plan and track mentally; the execution still works.
- **One `/develop` at a time per session.** Starting a new `/develop
  <desc>` clears any prior state, restoring tools first.
- **No worktree mode.** Awesome-agents has `/implementer` for parallel
  worktrees; that's out of scope here.
- **Intake quality depends on the agent.** The intake prompt asks for
  tight, specific questions, but a chatty model can still drag the
  conversation. Bail out with a fresh `/develop <substantive desc>`
  if it gets in the way.
- **Smart branch + session names depend on a fast-tier model.**
  `slugifyWithModel` resolves a `fast`-tier background model via
  `_shared/model-resolver.ts` (root `README.md` “Background models”).
  Override per-session with `PI_DEVELOP_SLUG_MODEL="provider/id"`.
  When no model resolves (offline, no auth, no config) it falls back
  to the deterministic token-truncation `slugify()` so the extension
  still works — the branch will just be the user's first words again.
  One extra fast-tier call per `/develop` invocation; the same slug
  drives `pi.setSessionName` in the Implement path.