# pi-ext-develop

Plan a change before you code it, with **plan-phase tool lockdown**,
**structured todo extraction**, and **live `[DONE:n]` progress tracking**
during execution. `/develop <description>` syncs you to the default
branch, restricts tools to read-only exploration, drives plan-mode, then
pops an Implement / Park / Continue-discussing picker the moment the plan
is ready. No `/sync` needed — pass no arguments to `/develop` and it just
syncs.

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
  `isSafeCommand`, `cleanStepText`. Ported from pi's `plan-mode`
  example, unit-tested.
- `skills/develop/SKILL.md` — the plan-mode workflow. Usable standalone
  via `/skill:develop` even without the extension loaded.
- `__tests__/helpers.test.ts` + `__tests__/plan-utils.test.ts` — 50+
  tests covering prefix / slug / secret-scan / title and plan / DONE
  / safety logic.

## Commands

| Command | Effect |
|---|---|
| `/develop` (no args) | Verify repo → dirty-tree guard → detect default branch → checkout + pull. Replaces `/sync`. |
| `/develop <description>` | Same sync, then enter **plan phase**: restrict tools to `read`/`grep`/`find`/`ls` plus a read-only bash allowlist, and hand off a plan-mode follow-up message to the agent. After the agent finishes the plan, the extension extracts numbered steps and pops a picker. |
| `/implement` | Create the feature branch, rename the session, restore full tools, enter **execution phase**. Works any time after `/develop <desc>`. |
| `/park` | Scan the (snapshotted) plan for secrets, `gh issue create`, persist `branch.<name>.tracking-issue <N>` in git config. Works any time after `/develop <desc>`. |
| `/develop-choose` | Re-open the three-way picker — useful if you dismissed it with ESC. |
| `/develop-todos` | Show the current plan progress (non-blocking notification). |

## Phase lifecycle

```
/develop <desc>  →  awaiting-plan  →  awaiting-choice  →  executing  →  consumed
                    │                   │                 │
                    │                   └─ Park ─────────→ consumed
                    │                   └─ Continue ─────→ dormant
                    │
                    └─ tools: read/grep/find/ls + safe bash
                       widget: "📋 planning <branch>"
                                     │
                    tools unchanged ──┤         tools: restored (edit/write back)
                    widget: "📋 N-step plan"    widget: "⚙ 0/N (<branch>)"
                                                [DONE:n] parsed live
                                                on all-done: "Plan complete"
                                                + handoff picker
```

- **awaiting-plan** — agent is writing the plan; tools locked down.
- **awaiting-choice** — plan done, todos extracted, picker armed.
- **executing** — branch created, full tools, `[DONE:n]` parsing live.
- **dormant** — user chose "Continue discussing"; lockdown lifted but
  `/implement` / `/park` still work.
- **consumed** — Implement finished (all steps marked done) or Park
  fired. Terminal state. `/develop <desc>` will clear it.

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
complete on `<branch>`!" message, flips phase to `consumed`, clears
the widget, and pops a picker offering to dispatch a follow-up
command. The picker lists `Run /verify`, `Run /review`, and
`Run /commit` (only those that `pi.getCommands()` shows as
installed), plus a "Stay here" option. Picking one calls
`pi.sendUserMessage("/<cmd>", { deliverAs: "followUp" })`, queuing
the command as a fresh user-message turn after the current one
returns. Picking Stay leaves you in control — review, test, and
commit by hand.

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
/develop                       # sync-only, replaces /sync
/develop add payment webhooks  # plan + pick
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
