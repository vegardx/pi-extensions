# Issue Operations

## Commands

### List issues

```bash
gh issue list [flags]
```

Key flags: `--state` (open/closed/all), `--assignee`, `--author`, `--label`, `--milestone`, `--mention`, `--search` (GitHub query syntax), `--limit`

JSON fields: `assignees, author, body, closed, closedAt, comments, createdAt, id, isPinned, labels, milestone, number, projectCards, projectItems, reactionGroups, state, stateReason, title, updatedAt, url`

```bash
# Issues assigned to me
gh issue list --assignee @me --state open

# Issues with specific labels
gh issue list --label "bug" --label "priority:high"

# Issues in a milestone
gh issue list --milestone "v2.0"

# Full search syntax
gh issue list --search "is:open no:assignee label:bug"
```

### View an issue

```bash
# Human-readable
gh issue view 42

# With comments
gh issue view 42 --comments

# Structured JSON
gh issue view 42 --json title,body,labels,assignees,comments,milestone

# Open in browser
gh issue view 42 --web
```

### Create an issue

```bash
# Interactive
gh issue create

# With values
gh issue create --title "Bug: X happens" --body "Steps to reproduce..."

# With labels and assignee
gh issue create --title "Fix Y" --body "..." --label "bug" --assignee @me

# From a template
gh issue create --template "bug_report.md"

# With milestone and project
gh issue create --title "Task" --body "..." --milestone "v2.0" --project "Board"
```

### Edit an issue

```bash
# Change title
gh issue edit 42 --title "Updated title"

# Add/remove labels
gh issue edit 42 --add-label "in-progress" --remove-label "triage"

# Assign
gh issue edit 42 --add-assignee @me

# Change milestone
gh issue edit 42 --milestone "v2.0"

# Update body
gh issue edit 42 --body "New description"
```

### Comment on an issue

```bash
gh issue comment 42 --body "Working on this now"
```

### Close / reopen

```bash
# Close as completed
gh issue close 42

# Close as not planned
gh issue close 42 --reason "not planned"

# Reopen
gh issue reopen 42
```

### Other operations

```bash
# Pin/unpin
gh issue pin 42
gh issue unpin 42

# Transfer to another repo
gh issue transfer 42 owner/other-repo

# Lock/unlock conversation
gh issue lock 42 --reason "resolved"
gh issue unlock 42

# Delete (requires confirmation)
gh issue delete 42

# Create branch from issue
gh issue develop 42 --checkout
```
