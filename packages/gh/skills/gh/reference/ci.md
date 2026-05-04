# CI/CD Operations

These operations have **no MCP equivalent** — this is a unique capability of the gh CLI skill.

## Workflow Runs

### List runs

```bash
gh run list [flags]
```

Key flags: `--branch`, `--workflow`, `--status` (queued/in_progress/completed/action_required/cancelled/failure/neutral/skipped/stale/success/timed_out/waiting), `--user`, `--event`, `--limit`

JSON fields: `attempt, conclusion, createdAt, databaseId, displayTitle, event, headBranch, headSha, jobs, name, number, startedAt, status, updatedAt, url, workflowDatabaseId, workflowName`

```bash
# Recent runs on current branch
gh run list --branch $(git branch --show-current) --limit 5

# Failed runs
gh run list --status failure --limit 10

# Runs for a specific workflow
gh run list --workflow "ci.yml" --limit 5

# JSON output
gh run list --json databaseId,displayTitle,status,conclusion,headBranch --limit 10
```

### View a run

```bash
# Summary
gh run view <run-id>

# Full logs
gh run view <run-id> --log

# Only failed job logs (most useful for debugging)
gh run view <run-id> --log-failed

# JSON details
gh run view <run-id> --json jobs,conclusion,startedAt,updatedAt

# View specific job
gh run view <run-id> --job <job-id>
```

### Watch a run (live updates)

```bash
# Watch until completion
gh run watch <run-id>

# Watch with exit code (useful for scripting)
gh run watch <run-id> --exit-status
```

### Rerun failed jobs

```bash
# Rerun all failed jobs
gh run rerun <run-id> --failed

# Rerun entire run
gh run rerun <run-id>

# Rerun with debug logging
gh run rerun <run-id> --debug
```

### Cancel / delete

```bash
gh run cancel <run-id>
gh run delete <run-id>
```

### Download artifacts

```bash
# Download all artifacts
gh run download <run-id>

# Download specific artifact
gh run download <run-id> --name "test-results"

# Download to specific directory
gh run download <run-id> --dir ./artifacts
```

## Workflows

### List workflows

```bash
gh workflow list
gh workflow list --json id,name,state
```

### Trigger a workflow

```bash
# Trigger workflow_dispatch event
gh workflow run <workflow> --ref <branch>

# With inputs
gh workflow run deploy.yml --ref main -f environment=staging -f version=1.2.3
```

### Enable / disable

```bash
gh workflow enable <workflow>
gh workflow disable <workflow>
```

## Common patterns

```bash
# Check if current branch CI is green
gh pr checks $(gh pr view --json number --jq '.number')

# Find and view the latest failed run
RUN_ID=$(gh run list --status failure --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID" --log-failed

# Wait for CI then merge
gh run watch <run-id> --exit-status && gh pr merge 123 --squash

# Trigger deploy and watch it
gh workflow run deploy.yml --ref main && sleep 5 && gh run list --workflow deploy.yml --limit 1
```
