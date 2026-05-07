---
name: triage
description: "GitHub inbox triage. Go through PRs with review comments, open issues, failing CI runs, or stale PRs. Validates findings, plans fixes, and drives the fix/push/merge loop. Use when you want to systematically work through your GitHub backlog. Covers: 'triage PRs', 'go through issues', 'fix failing CI', 'clean up stale PRs'."
---

# Triage

Systematically work through your GitHub backlog. Pick a mode or pass it
directly as an argument.

## Modes

| Argument | What it does |
|----------|------|
| `prs` | Go through PRs with automated review comments (Copilot, bots). Validate each claim, fix valid ones, push, optionally merge. |
| `issues` | List open issues — assigned to you first, then the rest. Summarize, prioritize, act. |
| `actions` | Go through failing GitHub Actions runs. Fetch logs, analyze root cause, suggest or apply fixes. |
| `stale` | Find stuck PRs — failing CI, needs rebase, idle review. Offer to fix up, nudge, or close. |

## Invocation

- `/skill:triage` — ask what to triage
- `/skill:triage prs` — jump straight to PR review triage
- `/skill:triage issues` — jump straight to issue triage
- `/skill:triage actions` — jump straight to failing CI triage
- `/skill:triage stale` — jump straight to stale PR triage

## Dispatch

If `$ARGUMENTS` matches one of the modes above, load the corresponding
reference document and follow its workflow:

- `prs` → read [reference/pr-reviews.md](reference/pr-reviews.md)
- `issues` → read [reference/issues.md](reference/issues.md)
- `actions` → read [reference/actions.md](reference/actions.md)
- `stale` → read [reference/stale-prs.md](reference/stale-prs.md)

If no argument is given, ask the user which mode they want.

## Dependencies

This skill depends on the `gh` CLI being authenticated for the current
repo's host. Verify before starting:

```bash
gh auth status
```

For multi-host routing, fork-aware pushes, and other `gh` mechanics,
follow the conventions in `/skill:gh`.

## General rules

- Always confirm destructive actions (close, force-push, delete branch).
- Present findings to the user before acting — don't silently skip or
  silently fix.
- When multiple items exist, work through them one at a time, confirming
  each action.
- Use conventional commits when committing fixes.
