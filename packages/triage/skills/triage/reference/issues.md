# Issue Triage

List open issues, assigned-to-you first, then the rest. Summarize,
prioritize, and act.

## Workflow

### 1. Fetch issues (ordered)

```bash
# Issues assigned to you (highest priority)
gh issue list --assignee @me --state open \
  --json number,title,labels,createdAt,updatedAt,author,milestone \
  --limit 50

# All other open issues
gh issue list --state open \
  --json number,title,labels,createdAt,updatedAt,author,assignees,milestone \
  --limit 50 \
  | jq '[.[] | select(.assignees | map(.login) | index(env.USER) | not)]'
```

If `jq` filtering on assignee is unreliable (env.USER mismatch), fetch
all and partition in your reasoning:

```bash
ME=$(gh api user --jq '.login')
gh issue list --state open \
  --json number,title,labels,createdAt,updatedAt,author,assignees,milestone \
  --limit 100
```

Split into two groups:
1. **Assigned to me** — these need my action
2. **Unassigned / assigned to others** — context, potential pickup

### 2. Present summary

For each group, present a compact table:

```
## Assigned to me (3)

| # | Title | Labels | Age |
|---|-------|--------|-----|
| 42 | Fix webhook timeout | bug, p1 | 3d |
| 38 | Add rate limiting | feat | 1w |
| 35 | Docs: update API ref | docs | 2w |

## Other open issues (7)

| # | Title | Labels | Assigned | Age |
|---|-------|--------|----------|-----|
| ...
```

### 3. Let the user choose

Ask what they want to do. Options per issue:

- **Start work** — create a feature branch, set tracking-issue config,
  and begin (follows `/skill:gh` branching conventions):
  ```bash
  branch="fix/issue-${number}-$(echo "$title" | tr ' ' '-' | tr '[:upper:]' '[:lower:]' | head -c 40)"
  git checkout -b "$branch"
  git config "branch.${branch}.tracking-issue" "$number"
  ```
- **Comment** — post a comment (`gh issue comment {N} --body "..."`)
- **Label** — add/remove labels (`gh issue edit {N} --add-label "..." --remove-label "..."`)
- **Assign** — assign to self or others (`gh issue edit {N} --add-assignee @me`)
- **Close** — close with a reason (`gh issue close {N} --reason "completed|not_planned"`)
- **Skip** — move to next

### 4. Batch operations

If the user wants to bulk-act (e.g. "close all the stale docs issues"),
confirm the list explicitly before executing:

> Close issues #12, #18, #24 as not_planned? (y/n)

### 5. Summary

After working through the list:
- N issues triaged
- Actions taken (started work on X, closed Y, commented on Z)
- Remaining open issues: N
