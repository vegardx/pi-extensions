# triage

GitHub inbox triage skill for pi. Systematically work through your
backlog: PR review comments, open issues, failing CI, or stale PRs.

## Usage

```
/skill:triage           # interactive — asks what to triage
/skill:triage prs       # PR review comments (Copilot, bots)
/skill:triage issues    # open issues, assigned-to-me first
/skill:triage actions   # failing GitHub Actions runs
/skill:triage stale     # stuck PRs (conflicts, idle, failing CI)
```

## Modes

| Mode | What it does |
|------|------|
| `prs` | Fetch bot review comments, validate each claim against the code, fix valid ones, push, ask about merge |
| `issues` | List all open issues (yours first), summarize, pick actions (start work, comment, close, label) |
| `actions` | List failing workflow runs, fetch logs, analyze root cause, fix or rerun |
| `stale` | Find PRs needing rebase, failing CI, or idle review — fix, nudge, or close |

## Prerequisites

- `gh` CLI authenticated for the current repo's host
- Inside a git repository (for PR/branch operations)

## Related skills

- `/skill:gh` — multi-host routing, fork-aware pushes, CI commands
- `/skill:commit` — commit/push/PR workflow after fixes are applied
- `/skill:review` — multi-agent code review (deeper than bot comments)
