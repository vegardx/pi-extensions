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
| `copilot <N>` | Wait for Copilot's review to appear on PR #N, then validate findings, fix valid ones, resolve threads, and auto-merge. Pre-checks whether a review is expected before polling. |
| `issues` | List open issues — assigned to you first, then the rest. Summarize, prioritize, act. |
| `actions` | Go through failing GitHub Actions runs. Fetch logs, analyze root cause, suggest or apply fixes. |
| `stale` | Find stuck PRs — failing CI, needs rebase, idle review. Offer to fix up, nudge, or close. |

## Invocation

- `/skill:triage` — ask what to triage
- `/skill:triage prs` — jump straight to PR review triage
- `/skill:triage copilot` — pick a PR and watch for Copilot's review
- `/skill:triage copilot <N>` — watch PR #N directly
- `/skill:triage issues` — jump straight to issue triage
- `/skill:triage actions` — jump straight to failing CI triage
- `/skill:triage stale` — jump straight to stale PR triage

> **`prs` and `copilot` modes** are handled by the TypeScript extension
> (`/triage` command). They spawn dedicated `primary.normal` sub-agents
> in per-PR git worktrees for autonomous fix+push+resolve workflows.
> `issues`, `actions`, and `stale` remain skill-driven.

## Dispatch

If `$ARGUMENTS` matches one of the modes above, load the corresponding
reference document and follow its workflow:

- `prs` → handled by `/triage prs` (TypeScript extension)
- `copilot` / `copilot <N>` → handled by `/triage copilot` (TypeScript extension)
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
