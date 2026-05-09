# modes

Permission-mode cycle with phase/task plan model and worktree-bound execution. Replaces `/develop`.

## Modes

| Mode | Tools | Bash | Confirmation |
|------|-------|------|-------------|
| `plan` | read-only (`read`, `bash`, `grep`, `find`, `ls`, `websearch`, `webfetch`, `plan_phase`, `plan_task`, `plan_view`) | blocked if write-capable | none — writes are refused outright |
| `ask` | all | all | confirm before every `edit`, `write`, and non-safe bash — with option to switch to auto |
| `auto` | all | all | none — fully autonomous |

Current mode is shown in the footer. Cycle with **Shift+Tab**.

## Commands

| Command | Description |
|---------|-------------|
| `/plan [desc]` | Sync to default branch, enter plan mode, auto-create or reuse the plan for this repo |
| `/plan list` | List all plans across repos |
| `/plan resume <slug>` | Resume a specific plan in this repo |
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
  "extensions": {
    "modes": {
      "review": {
        "enable": true,
        "agents": ["code-reviewer", "code-simplifier", "security-analyst"]
      },
      "githubProject": "owner/repo/projects/N"
    }
  }
}
```

Optional peer dependencies:

- `pi-ext-review` — auto-review pass after execution and `/review` in the post-exec picker
- `pi-ext-commit` — `/commit` in the post-exec picker

## Notes

- Outside a git repository, `/plan` and `/implement` skip sync and branch steps.
- `/park`, `/ship`, `/sync` require `gh` CLI to be authenticated.
- Branches are never deleted by this extension — only worktree directories.
- This extension replaces `pi-ext-develop`; do not run both in one session.
