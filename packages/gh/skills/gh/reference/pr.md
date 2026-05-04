# Pull Request Operations

## Commands

### List PRs

```bash
gh pr list [flags]
```

Key flags: `--state` (open/closed/merged/all), `--author`, `--assignee`, `--base`, `--head`, `--label`, `--draft`, `--search` (GitHub query syntax), `--limit`

JSON fields: `number, title, author, state, baseRefName, headRefName, body, additions, deletions, changedFiles, comments, commits, createdAt, updatedAt, closingIssuesReferences, files, isDraft, labels, mergeStateStatus, mergeable, reviewDecision, reviewRequests, reviews, statusCheckRollup, url`

```bash
# Open PRs by author
gh pr list --author @me --state open --json number,title,reviewDecision

# PRs targeting a specific branch
gh pr list --base main --state open

# PRs with specific labels
gh pr list --label "needs-review" --json number,title,author

# Full GitHub search syntax
gh pr list --search "is:open review:required draft:false"
```

### View a PR

```bash
gh pr view <number> [flags]
```

```bash
# Human-readable summary
gh pr view 123

# Structured JSON
gh pr view 123 --json title,body,files,reviews,statusCheckRollup

# View in browser
gh pr view 123 --web
```

### PR diff

```bash
# Full diff
gh pr diff 123

# File names only
gh pr diff 123 --name-only
```

### Check CI status

```bash
gh pr checks 123
gh pr checks 123 --json name,state,conclusion,url
```

### Create a PR

```bash
# Auto-fill title/body from commits
gh pr create --fill

# With explicit values
gh pr create --title "Add feature" --body "Description" --base main

# Create as draft
gh pr create --fill --draft

# With reviewers and labels
gh pr create --fill --reviewer user1,user2 --label "feature"

# Link to issue
gh pr create --fill --body "Closes #42"
```

### Review a PR

```bash
# Approve
gh pr review 123 --approve

# Request changes
gh pr review 123 --request-changes --body "Please fix X"

# Comment only
gh pr review 123 --comment --body "Looks good overall, one question..."
```

### Merge a PR

```bash
# Default merge strategy
gh pr merge 123

# Squash merge
gh pr merge 123 --squash

# Rebase merge
gh pr merge 123 --rebase

# Delete branch after merge
gh pr merge 123 --squash --delete-branch

# Auto-merge when checks pass
gh pr merge 123 --auto --squash
```

### Other operations

```bash
# Add comment
gh pr comment 123 --body "Comment text"

# Mark as ready for review
gh pr ready 123

# Close without merging
gh pr close 123

# Reopen
gh pr reopen 123

# Checkout locally
gh pr checkout 123

# Update branch with base
gh pr update-branch 123

# Edit PR metadata
gh pr edit 123 --title "New title" --add-label "urgent" --add-reviewer user1
```

## Posting reviews with inline comments via gh api

`gh pr review` only supports an overall body — no inline/line comments. Use `gh api` to post reviews with inline comments.

### Single-call review (recommended)

```bash
COMMIT_SHA=$(gh pr view <number> --json headRefOid --jq '.headRefOid')

gh api repos/{owner}/{repo}/pulls/<number>/reviews \
  --method POST \
  --input - <<EOF
{
  "commit_id": "${COMMIT_SHA}",
  "body": "Overall review summary",
  "event": "REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/file.ts",
      "line": 47,
      "side": "RIGHT",
      "body": "Issue description and suggested fix."
    }
  ]
}
EOF
```

### Multi-line range comment

```json
{
  "path": "src/service.ts",
  "start_line": 10,
  "start_side": "RIGHT",
  "line": 14,
  "side": "RIGHT",
  "body": "This block could be simplified."
}
```

### Event values

- `APPROVE` — approve the PR
- `REQUEST_CHANGES` — block merge until addressed
- `COMMENT` — leave feedback without verdict
