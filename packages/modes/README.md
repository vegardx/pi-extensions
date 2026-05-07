# modes

Permission-mode cycle with integrated git workflow. Replaces `/develop`.

## Modes

| Mode | Tools | Bash | Confirmation |
|------|-------|------|-------------|
| `plan` | read-only (`read`, `bash`, `grep`, `find`, `ls`, `plan_step`) | blocked if write-capable | none — writes are refused outright |
| `default` | all | all | confirm before every `edit`, `write`, and non-safe bash |
| `auto` | all | all | none — fully autonomous |

The current mode is always shown in the footer. Cycle with **Shift+Tab**.

## Commands

| Command | Description |
|---------|-------------|
| `/plan [desc]` | Sync to default branch, enter plan mode, optionally seed the agent |
| `/implement [desc]` | Sync, derive a branch name, `git checkout -b`, switch to auto mode |
| `/park` | Create a GitHub tracking issue from the current plan, exit plan mode |
| `/modes-status` | Show current mode, phase, branch, and step progress |

## Shift+Tab cycle

- **From plan** — if a plan exists (steps or assistant text): show the picker (Implement / Park / Continue discussing). Otherwise cycle directly to default.
- **From default** → auto
- **From auto** → plan

## Typical workflow

```
/plan add webhook support for payments
  → agent explores, calls plan_step(add) for each step
  → agent presents the plan and stops
Shift+Tab → picker appears
  → Implement: creates feat/add-webhook-support, switches to auto
  → agent calls plan_step(toggle, id) as it completes each step
  → all steps done → auto-review fires → post-exec picker
```

Or skip planning entirely:

```
/implement fix the null pointer in auth middleware
  → sync + branch + auto mode, agent starts immediately
```

## plan_step tool

The agent uses this to build and track the plan. State is stored in tool result details so it survives session branching.

| Action | Args | Effect |
|--------|------|--------|
| `add` | `text` | Add a numbered step |
| `toggle` | `id` | Mark a step done or undone |
| `list` | — | List all steps |
| `clear` | — | Remove all steps |

## Enforcement layers

Plan mode enforces read-only access through three independent layers so the agent cannot accidentally or deliberately mutate the repo:

1. **Tool restriction** — `edit` and `write` are absent from the active tool set.
2. **System prompt injection** — the agent is told explicitly what mode it's in and what is allowed.
3. **Bash guard** — the `tool_call` hook checks every `bash` invocation against a write-command blocklist (redirects, `tee`, `sed -i`, `rm`, `git commit`, package installs, etc.) and blocks any match.

## Settings

No required configuration. Optional peer dependencies:

- `pi-ext-review` — enables auto-review pass after execution and `/review` in the post-exec picker
- `pi-ext-commit` — enables `/commit` in the post-exec picker

## Notes

- Outside a git repository, `/plan` and `/implement` skip the sync and branch steps.
- `/park` requires `gh` CLI to be authenticated.
- This extension is intended to replace `pi-ext-develop`; both can coexist temporarily but manage tool state independently, so avoid running `/develop` and `/plan`/`/implement` in the same session.
