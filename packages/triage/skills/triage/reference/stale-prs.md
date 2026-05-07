# Stale PR Triage

Find PRs that are stuck — failing CI, needing rebase, or waiting on
review with no activity. Offer to fix, nudge, or close.

## Workflow

### 1. Identify stale PRs

```bash
# All open PRs with metadata
gh pr list --state open \
  --json number,title,headRefName,author,createdAt,updatedAt,reviewDecision,mergeable,labels,isDraft \
  --limit 50
```

Classify each PR:

| Condition | Category |
|-----------|----------|
| `mergeable: "CONFLICTING"` | Needs rebase |
| `now - updatedAt > 7d`, no review | Idle — waiting on review |
| `now - updatedAt > 14d` | Stale — likely abandoned |
| `reviewDecision: "CHANGES_REQUESTED"` + idle | Stale — unresolved review |
| `isDraft: true` + idle > 14d | Stale draft |

Also check CI status per PR:

```bash
gh pr checks <N> --json name,state,conclusion \
  --jq '.[] | select(.conclusion == "FAILURE" or .state == "PENDING")'
```

### 2. Present findings

Group by category:

```
## Needs rebase (2)
- #45: "Add rate limiting" (feat/rate-limit) — 3 conflicts
- #32: "Fix session timeout" (fix/session) — 1 conflict

## Failing CI (1)
- #48: "Update deps" (chore/deps) — lint step failing

## Idle / waiting on review (3)
- #40: "Refactor auth" — no reviewers assigned, 10d idle
- #38: "Add metrics" — review requested from @jane, 8d idle
- #35: "Fix docs typo" — approved but never merged, 12d idle

## Stale (2)
- #22: "WIP: new API" (draft) — 30d idle
- #18: "Experiment: caching" — 45d idle, changes_requested
```

### 3. Act on each

Ask the user what to do for each category. Common actions:

**Needs rebase:**
```bash
gh pr checkout <N>
git fetch origin main
git rebase origin/main
# If conflicts, resolve them
git push --force-with-lease
```

**Failing CI:**
- Analyze the failure (follow [actions.md](actions.md) workflow)
- Fix and push

**Idle / waiting on review:**
```bash
# Assign a reviewer
gh pr edit <N> --add-reviewer @someone

# Post a nudge comment
gh pr comment <N> --body "Friendly ping — this is ready for review."

# If approved but not merged — just merge it
gh pr merge <N> --squash --delete-branch
```

**Stale:**
```bash
# Close with explanation
gh pr close <N> --comment "Closing — this has been idle for X days. Reopen if still relevant."

# Or delete the branch if it's clearly abandoned
gh pr close <N> --delete-branch --comment "Closing stale PR."
```

### 4. Safety

- **Never force-push without asking** — the PR author may have local
  work that depends on the current history.
- **Never close without asking** — even stale PRs may be intentionally
  parked.
- **Rebase conflicts**: if a rebase has non-trivial conflicts (> 3
  files), report the situation and let the user decide whether to
  proceed or leave it.

### 5. Summary

After working through stale PRs:
- N PRs rebased
- N CI failures fixed
- N reviewers nudged
- N PRs closed
- N PRs merged (were approved + idle)
- N skipped
