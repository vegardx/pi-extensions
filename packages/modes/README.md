# modes

Permission-mode cycle with phase/task plan model and worktree-bound execution. Replaces `/develop`.

## Modes

| Mode | Tools | Bash | Confirmation | Plan needed | Compaction |
|------|------|------|--------------|-------------|------------|
| `hack` | all | all | none — full tool access | no | none — user owns context length |
| `plan` | read-only (`read`, `bash`, `grep`, `find`, `ls`, `websearch`, `webfetch`, `plan_phase`, `plan_task`, `plan_view`) | blocked if write-capable | none — writes are refused outright | — (creates one) | — |
| `auto` | all | all | none — fully autonomous | yes (works the active phase) | three-tier (plan→implement, mid-phase, phase-end) |

Current mode is shown in the footer (`hack` renders red — no safety net). **Shift+Tab** cycles `hack → plan → auto → hack`. The cycle adds structure step by step, then drops it again.

- `hack → plan`: prompts for handling carried-over context (keep / lossy-compact the active phase). Headless skips the prompt and silently keeps context.
- `plan → auto`: opens a picker (Implement / Park / Continue discussing) when a plan is in flight; otherwise just flips. The picker forces an explicit `/implement` so you don't stumble into auto with stale plan text.
- `auto → hack`: flips silently — going more permissive, context flows through.

Fresh sessions start in the mode chosen by `extensionConfig.modes.defaultMode` (default `plan`). Existing persisted sessions always use their saved mode.

## Commands

| Command | Description |
|---------|-------------|
| `/plan [desc]` | Sync to default branch, enter plan mode. If this session has a bound plan, reuse it; otherwise create a new one owned by this session. |
| `/plan list` | List all plans, grouped by ownership (this session / other sessions / legacy). Stuck plans are flagged with `⊘ stuck — open a PR or /plan archive`. |
| `/plan resume <slug>` | Bind this session to a specific plan. Confirms before adopting a plan owned by another session. |
| `/plan archive <slug>` | Soft-archive: mark all non-terminal phases as `abandoned`, tear down their worktrees, keep branches and the plan file on disk. |
| `/plan delete <slug>` | Hard-delete: remove `~/.pi/plans/<slug>/` permanently. Refuses if any worktree is dirty; worktrees and branches are not touched. |
| `/implement [desc]` | Sync, create a feature branch, switch to auto |
| `/park` | Create a GitHub parent issue + per-phase sub-issues for the current plan |
| `/ship [phaseId?]` | Commit, push, open PR; flips active phase to in-review |
| `/sync` | Refresh plan from GitHub PR/issue state |
| `/worktree list \| prune` | List or prune worktrees attached to phases |
| `/modes-status` | Show current mode and active phase |

## Plan model

A **plan** is a thread of work for a repo. It contains an ordered list of **phases**.
A **phase** is what ships as one PR — one issue, one Copilot session, one PR.
A **task** is a concrete work item inside a phase (short title + detailed body).

Plans live in `~/.pi/plans/<slug>/plan.json` (global, not per-repo). An index lives at `~/.pi/plans/index.json`.

### Plans are session-owned

Each plan records the session that created it (`createdBy.sessionId`)
and the sessions that have ever bound it (`seenIn`). Concretely:

- A session's plan binding lives in session state (`STATE_ENTRY`),
  so `pi -c`, `/resume`, and `/fork` keep their plan transparently.
- A **fresh** `pi` (no session continuation) does NOT inherit a plan
  from a previous session in the same repo. Run `/plan` to start a
  new one, or `/plan resume <slug>` to attach to one from another
  session — you'll be asked to confirm before adopting a plan owned
  by someone else.
- Plans created before this field existed ("legacy" plans) have no
  owner. They behave like cross-session adoption candidates: visible
  in `/plan list`, never auto-adopted, bind without a confirm prompt
  on `/plan resume`.
- No migration required — existing plans on disk keep working.

```
plan: feat-payments-webhooks
├── phase: p-add-webhook-endpoint  [shipped]    PR #142
├── phase: p-validate-signatures   [in-review]  PR #145
└── phase: p-retry-failed          [active]     branch: feat/p-retry-failed
       ├── task: t-detect-failures
       ├── task: t-retry-with-backoff
       └── task: t-add-tests
```

### Phase status state machine

```
planned ─► active ─► in-review ─► ready-to-ship ─► shipped
                          │
                          ▼
                     needs-attention ─► ready-to-ship

(any non-terminal) ─► abandoned
```

Transitions are gated by `plan_phase update` — invalid transitions are rejected.

## Worktree lifecycle

A phase has a worktree iff its status is `active` or `needs-attention`.

```
~/src/example/
├── repo-a/                          ← main checkout
└── worktrees/
    └── repo-a/
        └── feat-payments-webhooks/  ← plan slug
            └── p-retry-failed/      ← phase id, branch checked out
```

- Worktree is created when a phase enters `active` (refused if main is dirty).
- Worktree is removed when the phase leaves `active`/`needs-attention`.
- **Branches are never auto-deleted** — instant re-creation on `needs-attention`.
- `/worktree prune` removes worktrees attached to terminal phases (always confirms).

### Stacked phases (phase N+1 while phase N is in-review)

When `/implement` activates phase B and phase A is still `in-review` /
`ready-to-ship` / `needs-attention`, B's branch is forked from A's
branch — not from the default branch. A's PR isn't merged yet, so its
changes aren't on `main`; forking B from `main` would lose access to
A's work until A merges.

`pickBaseBranch` walks predecessors backwards to find the right base:
`shipped` predecessors mean the work is on `main` (fork from default);
in-flight predecessors (in-review / ready-to-ship / needs-attention /
active) mean fork from that branch; `abandoned` and `planned` are
skipped.

When B's PR review surfaces a need to update A, you `/implement` A
again (it's still active in the plan), commit on A's branch, and
rebase B onto the updated A.

### Resuming an in-flight phase (auto → plan → auto round-trip)

If you Shift+Tab from auto back to plan mid-phase — to discuss the
approach, refine tasks, or pause — the phase branch keeps its commits.
When you `/implement` again, modes detects the phase is already
`active` (or `needs-attention`) and **resumes non-destructively**:
plain `git checkout`, no reset, all your phase commits intact.

If the phase branch is missing locally (manually deleted, lost
worktree), `/implement` aborts with a clear error rather than silently
re-creating the branch from the default — that would erase any
commits still on a remote / reflog.

## Typical workflow

```
/plan add webhook support for payments
  → agent explores, calls plan_phase + plan_task to structure the work
  → agent presents the plan
Shift+Tab → Implement
  → /implement: creates feat branch, switches to auto
  → agent works on phase 1's tasks, calls plan_task(toggle) as it goes
  → all tasks done → review fires → triage findings
/ship
  → commit, push, gh pr create, phase → in-review
  → user can immediately move on to phase 2 (own worktree, own PR)
/sync (or session_start)
  → in-review → shipped (PR merged) or abandoned (PR closed)
```

## Tools

The agent uses three tools to manage the plan:

| Tool | Actions |
|------|---------|
| `plan_phase` | `add`, `update`, `remove`, `reorder`, `list` |
| `plan_task` | `add`, `update`, `toggle`, `remove`, `move` |
| `plan_view` | read-only markdown summary |

State persists in `~/.pi/plans/<slug>/plan.json`.

## Plan-mode write protection

Plan mode steers the agent toward read-only behaviour through three layers. The first two are hard gates; the third is best-effort and is **not a security boundary** (see the disclaimer at the top of `bash-classifier.ts`).

1. **Tool restriction** — `edit` and `write` are absent from the active tool set.
2. **System prompt injection** — the agent is told what mode it's in and what's allowed.
3. **Bash classifier** — the `tool_call` hook screens each `bash` invocation through a static priority allowlist, a denylist, and a static allowlist. Only commands that match none of these are sent to a fast-tier LLM for an `allow` / `block` / `redirect` verdict; when no fast model is configured, the LLM step is skipped entirely. The LLM call **falls open** on error (the static denylist has already passed at that point) — relying on this layer for security is a mistake.

## Settings

```json
{
  "extensionConfig": {
    "modes": {
      "defaultMode": "plan",
      "compaction": {
        "workingTokens": 150000,
        "summaryTokens": 100000,
        "phaseTokens": 10000
      },
      "review": {
        "enable": false,
        "agents": ["code-reviewer", "code-simplifier", "security-analyst"]
      },
      "githubProject": "owner/repo/projects/N"
    }
  }
}
```

| Key | Default | Doc |
|---|---|---|
| `defaultMode` | `"plan"` | Mode for fresh sessions: `plan` \| `auto` \| `hack`. Persisted sessions keep their saved mode. |
| `compaction.workingTokens` | `150000` | Working budget covering `sys + work` (system prompt + tool schemas + live messages). Mid-phase compaction fires when `sys + work` exceeds this. Summary tokens live in their own budget. |
| `compaction.summaryTokens` | `100000` | Cumulative rolling-summary budget. Soft-warns once when exceeded; not enforced. Total target ceiling = `workingTokens + summaryTokens` — should fit the active model's `contextWindow`. |
| `compaction.planMaxContextTokens` | `0` | Footer cap (denominator) used while in plan mode. Plan mode is exempt from mid-phase compaction — the human is in the loop — so this only affects the footer display. `0` = use the active model's `contextWindow`. |
| `compaction.phaseTokens` | `10000` | Output token cap per slice summary. The conversation being summarised is unbounded; the cap is on the frozen output that joins the rolling summary. |
| `review.enable` | `false` | Run batch review after plan execution completes. **Off by default** — see callout below. Opt in per-repo by setting `true`. |
| `review.agents` | `[code-reviewer, code-simplifier, security-analyst]` | Reviewer roles to run. |
| `githubProject` | `""` | GitHub Project to assign issues to when `/park` creates them. |

> **Autoreview is off by default.** The pipeline (`/review`, post-execution batch) runs end-to-end but the surrounding triage and feedback flow needs more design work before it's on for everyone — see the `TODO(autoreview)` block on `runBatchReview` for the open issues. Opt in per-repo by setting `extensionConfig.modes.review.enable: true`.

> **Breaking change:** the previous `compaction.maxContextTokens` setting has been replaced by `compaction.workingTokens` (semantically the same trigger threshold), and the new `compaction.summaryTokens` budgets the rolling compaction summary. There is no compatibility alias — rename the key in your config.

Optional peer dependencies:

- `pi-ext-review` — auto-review pass after execution and `/review` in the post-exec picker
- `pi-ext-commit` — `/commit` in the post-exec picker

## Context management

Modes owns context fully via three-tier compaction:

1. **plan → implement** — collapses planning chatter at `/implement`, producing the initial rolling summary (`## Plan` + `## Planning notes`).
2. **mid-phase** — fires from `turn_end` when `sys + work > compaction.workingTokens` (auto mode, active phase). The summary token cost is subtracted before comparison so a growing rolling summary never triggers compaction itself.
3. **phase-end** — freezes the just-completed phase at `/ship` as a section in the rolling summary.

### Three-bucket context budget

The live context decomposes into three buckets, in prefix order (sys → summary → work). Order matches the API request layout and the direction the KV-cache reuses (longest stable prefix first):

```
┌─ active model contextWindow ───────────────────────────────┐
│  sys     summary               work             free       │
│  ■■■■    ■■■■■■■■■■■■    ■■■■■■■■■■■■■■■■■■■■■■■■■                  │
│  └─ summaryTokens ─┘└────────── workingTokens (sys + work) ─────┘│
└────────────────────────────────────────────────────────────────┘
```

- **sys** — system prompt + active tool schemas. Stable prefix; rarely changes.
- **summary** — rolling compaction summary. Grows incrementally on each compaction; persists in the prefix.
- **work** — live messages since the most recent compaction breadcrumb. Hot tail; resets at every compaction.

Tune `workingTokens + summaryTokens` so the total fits the active model's `contextWindow` with margin for the next turn's response.

### Footer

In `auto` and `hack` modes the footer renders the breakdown:

```
sys 12k · sum 30k · work 78k · 120k/250k (256k)
```

- `sys`, `sum`, `work` — the three buckets, rounded to 1k.
- `120k/250k` — `getContextUsage().tokens` over `workingTokens + summaryTokens`.
- `(256k)` — the active model's `contextWindow`, shown only when it differs from the denominator. The `sum` segment is hidden until the first compaction lands.

In `plan` mode the footer reverts to the simpler `current/limit` form — plan mode is exempt from mid-phase compaction (the human is in the loop), so the breakdown adds noise.

### Byte-stable prefix invariant

Each compaction's summary reuses the previous compaction's summary **byte-for-byte** as a prefix; only a new `## Phase ...` section is appended. Sections are never re-summarised. This keeps the prompt cache hot across phase boundaries:

```
after /implement:   ## Plan ... + ## Planning notes ...
after phase 1:      ## Plan ... + ## Planning notes ... + ## Phase p-1 (part 1, shipped, PR #N) ...
after phase 2:      ## Plan ... + ## Planning notes ... + ## Phase p-1 ... + ## Phase p-2 ...
```

### Slice chain

When a phase overflows mid-flight, multiple `## Phase p-X (part N, ...)` sections accumulate:

```
## Phase p-long (part 1, in progress)    ← mid-phase compaction #1
## Phase p-long (part 2, in progress)    ← mid-phase compaction #2
## Phase p-long (part 3, shipped, PR #M) ← /ship
```

Each part captures raw messages once — no summary-of-summaries, no quality drift.

### Disable pi auto-compaction

Modes assumes pi's automatic compaction is OFF; it conflicts with the slice-chain invariant. Set in `~/.pi/agent/settings.json`:

```json
{ "compaction": { "enabled": false } }
```

Manual `/compact` still works (uses pi's default summary) as an escape hatch.

## Notes

- Outside a git repository, `/plan` and `/implement` skip sync and branch steps.
- `/park`, `/ship`, `/sync` require `gh` CLI to be authenticated.
- Branches are never deleted by this extension — only worktree directories.
- This extension replaces `pi-ext-develop`; do not run both in one session.
