# modes

Permission-mode cycle with phase/task plan model and worktree-bound execution. Replaces `/develop`.

## Modes

| Mode | Tools | Bash | Confirmation | Plan needed | Compaction |
|------|------|------|--------------|-------------|------------|
| `hack` | all | all | none — full tool access | no | none — user owns context length |
| `plan` | read-only (`read`, `bash`, `grep`, `find`, `ls`, `websearch`, `webfetch`, `plan_phase`, `plan_task`, `plan_view`) | blocked if write-capable | none — writes are refused outright | — (creates one) | — |
| `ask` | all | all | none during execution; the post-exec picker pauses you at the commit/ship boundary | yes (works the active phase) | three-tier (plan→implement, mid-phase, phase-end) |
| `auto` | all | all | none — fully autonomous | yes (works the active phase) | three-tier (plan→implement, mid-phase, phase-end) |

> **Note:** in this release, `ask` and `auto` execute the active phase the same way. The auto end-of-phase loop (commit → ship → next phase, no prompts) lands in a follow-up PR; until then both modes stop after the last task and surface the post-exec picker so you can run `/commit` and `/ship` yourself.

Current mode is shown in the footer (`hack` renders red — no safety net; `ask` renders green — supervised; `auto` renders accent). **Shift+Tab** cycles `hack → plan → ask → auto → hack`. The cycle adds structure step by step, then drops it again.

- `hack → plan`: prompts for handling carried-over context (keep / lossy-compact the active phase). Headless skips the prompt and silently keeps context.
- `plan → ask`: opens the picker (Implement (auto) / Implement (ask) / Park / Continue discussing) when a plan is in flight; otherwise just flips. The picker forces an explicit `/implement` so you don't stumble into execution with stale plan text.
- `ask → auto`: flips silently — going more permissive, context flows through.
- `auto → hack`: flips silently — going more permissive, context flows through.

Fresh sessions start in the mode chosen by `extensionConfig.modes.defaultMode` (default `plan`). Existing persisted sessions always use their saved mode.

### Choosing a mode at /implement

When you commit to a plan via the picker (Shift+Tab plan→ask) or `/implement`, two implement options are offered:

- **Implement (auto)** — chug through commit/ship/next phase autonomously (auto-loop wiring lands in a follow-up PR; for now matches ask).
- **Implement (ask)** — execute the phase's tasks autonomously, then pause at the commit/ship boundary so you can review the diff before it ships.

`extensionConfig.modes.implementDefault` (default `auto`) controls which option is highlighted first — set it to `ask` if you prefer human-in-the-loop by default.

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

## Session model

A plan owns **two kinds of pi sessions**: one **planning session** for plan
mode and one **auto session per phase** for execution. They survive
round-trips: when you Shift+Tab back to plan mid-phase, you land in the
planning session you started in; when you `/implement` again you resume
the phase's auto session. The two contexts never bleed into each other.

| Action                                          | Branch        | Session                                 |
| ----------------------------------------------- | ------------- | --------------------------------------- |
| `/plan` first time                              | sync default  | NEW (planning session)                  |
| `/plan resume <slug>`                           | sync default  | `switchSession(plan.planSessionPath)`   |
| `/plan` from auto (Shift+Tab or auto→plan)      | (no checkout) | `switchSession(plan.planSessionPath)`   |
| `/implement` first time on phase                | create        | NEW (auto session for phase)            |
| `/implement` resume (active / needs-attention)  | checkout      | `switchSession(phase.sessionPath)`      |
| `/ship`                                         | merge/PR      | (no session change)                     |

Session paths are stored on the plan/phase records:

- `plan.planSessionPath` — the planning session.
- `phase.sessionPath` — the phase's auto session. Set on first
  `/implement`, reused on resume, never cleared.

Legacy plans (created before this field existed) behave as orphans on
resume: a fresh session is started, with one-time loss of prior context.
No migration required.

### Per-phase session seeding

`/implement` does not pull the planning conversation into the new auto
session. Instead, the new session is **seeded** from the plan doc — a
deterministic render of:

- the plan title and slug,
- every phase's id, status, title, goal, and (for shipped phases) PR
  number and `phase.summary`,
- the active phase's tasks,
- a short instruction footer ("only execute phase `p-X`'s tasks; run
  `/ship` when done").

No LLM call. The seed text is byte-stable for a given plan, so the prompt
cache hits across phases.

### Cross-phase carry-forward

At `/ship`, the just-shipped phase's auto session is summarised and
stored as `phase.summary` on the plan doc (capped at
`compaction.phaseTokens`, default 10k). Future phases' seeds include
shipped phases' summaries verbatim — phase N walks in pre-loaded with
what phases 1…N−1 actually discovered, not just what was originally
planned.

`compaction.summaryTokens` (default 100k) bounds the cumulative size of
carry-forward summaries in the seed. Soft-warns when exceeded; not
enforced — dropping older summaries silently would lose the discovery
signal.

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
| `compaction.summaryTokens` | `100000` | Cumulative cross-phase carry-forward budget (Σ `phase.summary` chars across shipped phases). Soft-warns once when exceeded; not enforced. Total target ceiling = `workingTokens + summaryTokens` — should fit the active model's `contextWindow`. |
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

Modes owns context via two compaction mechanisms:

1. **mid-phase compaction** — fires from `turn_end` when `sys + work` exceeds `compaction.workingTokens` (auto mode, active phase). Routes through `ctx.compact()` and a `session_before_compact` handler so pi rebuilds `agent.state.messages` after appending the modes-flavoured summary. The rolling summary AND the plan-doc seed are subtracted before comparison so neither triggers compaction by itself.
2. **per-phase summary** at `/ship` — summarises the auto session and stores the result on `phase.summary` (capped at `compaction.phaseTokens`). Future phases' seeds inline shipped phases' summaries verbatim so phase N walks in pre-loaded with what phases 1…N-1 discovered.

### Four-bucket context budget

The live auto-session context decomposes into four buckets, in prefix order (sys → seed → summary → work). Order matches the API request layout and the direction the KV-cache reuses (longest stable prefix first):

```
┌─ active model contextWindow ───────────────────────────────────┐
│  sys   seed   summary       work             free              │
│  ■■■   ■■■    ■■■■■■■■    ■■■■■■■■■■■■■■■■■■■■■■■■■■■           │
│         └─ summaryTokens ─┘└── workingTokens (sys + work) ──┘  │
└────────────────────────────────────────────────────────────────┘
```

- **sys** — system prompt + active tool schemas. Stable; rarely changes.
- **seed** — plan-doc seed (active phase's tasks + prior shipped phases' summaries). Written once at `ctx.newSession({ setup })`; stable for the phase's lifetime.
- **summary** — rolling compaction summary inside this auto session. Grows on mid-phase compaction.
- **work** — live messages since the most recent mid-phase compaction. Hot tail; resets at every compaction.

`compaction.summaryTokens` (default 100k) bounds the cumulative cross-phase carry-forward (Σ `phase.summary` chars across shipped phases). Soft-warns once when exceeded; not enforced — dropping older summaries silently would lose the discovery signal that motivates the carry-forward.

Tune `workingTokens + summaryTokens` so the total fits the active model's `contextWindow` with margin for the next turn's response.

### Footer

In `auto` and `hack` modes the footer renders the breakdown:

```
sys 12k · seed 8k · sum 30k · work 70k · 120k/250k (256k)
```

- `sys`, `seed`, `sum`, `work` — the four buckets, rounded to 1k. `seed` and `sum` are hidden when zero.
- `120k/250k` — `getContextUsage().tokens` over `workingTokens + summaryTokens`.
- `(256k)` — the active model's `contextWindow`, shown only when it differs from the denominator.

In `plan` mode the footer reverts to the simpler `current/limit` form — plan mode is exempt from mid-phase compaction (the human is in the loop), so the breakdown adds noise.

### Byte-stable prefix invariant (within a phase's auto session)

Each mid-phase compaction's summary reuses the previous compaction's summary **byte-for-byte** as a prefix; only a new `## Phase ...` section is appended. Sections are never re-summarised. This keeps the prompt cache hot across mid-phase boundaries within the same auto session.

At `/ship`, the auto session is summarised one final time into `phase.summary` on the plan doc. The next phase's auto session starts with a fresh seed that inlines that summary verbatim.

### Slice chain (within one phase)

When a phase overflows mid-flight, multiple `## Phase p-X (part N, in progress)` sections accumulate inside that phase's auto session:

```
## Phase p-long (part 1, in progress)    ← mid-phase compaction #1
## Phase p-long (part 2, in progress)    ← mid-phase compaction #2
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
- Plans created before per-phase sessions landed don't have
  `planSessionPath` / `phase.sessionPath` recorded. On first re-entry
  (`/plan resume <slug>` or `/implement` on an in-flight phase) a
  fresh session is started — a one-time loss of prior chat context,
  not a crash. The plan doc on disk is unchanged.
