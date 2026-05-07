# Actions Triage

Go through failing GitHub Actions workflow runs, analyze root causes,
and suggest or apply fixes.

## Workflow

### 1. List failing runs

```bash
# Recent failures on this repo
gh run list --status failure --limit 10 \
  --json databaseId,displayTitle,headBranch,event,createdAt,workflowName

# Optionally narrow to a specific branch or workflow
gh run list --status failure --branch main --limit 5
gh run list --status failure --workflow "ci.yml" --limit 5
```

Present as a table:

```
| Run ID | Workflow | Branch | Title | Age |
|--------|----------|--------|-------|-----|
| 12345  | CI       | main   | fix: update deps | 2h |
| 12340  | CI       | feat/x | feat: add login  | 1d |
```

### 2. Pick a run to investigate

Let the user pick, or work through them newest-first.

### 3. Fetch failure details

```bash
# Get job-level summary
gh run view <run-id> --json jobs \
  --jq '.jobs[] | select(.conclusion == "failure") | {name: .name, steps: [.steps[] | select(.conclusion == "failure") | .name]}'
```

This shows which jobs and steps failed. Then get the logs:

```bash
# Logs for failed steps only (best for most cases)
gh run view <run-id> --log-failed
```

### 4. Handle large logs

CI logs can be huge. Use these patterns to extract the relevant part:

```bash
# Last 200 lines of failed output (usually contains the error)
gh run view <run-id> --log-failed 2>&1 | tail -200

# Search for error patterns
gh run view <run-id> --log-failed 2>&1 | grep -i -A5 "error\|failed\|exception\|FAIL"

# If a specific step name is known, filter to just that step
gh run view <run-id> --log-failed 2>&1 | grep -A50 "^<job>/<step>"
```

Log lines from `--log-failed` follow the format:
```
<job-name>\t<step-name>\t<timestamp> <content>
```

Extract the step that matters and focus analysis there.

### 5. Analyze root cause

Common failure patterns:

| Pattern | Likely cause |
|---------|------|
| `tsc: error TS` | Type error — read the file, fix the type |
| `ENOENT` / `MODULE_NOT_FOUND` | Missing file or dependency |
| `npm ERR! peer dep` | Peer dependency conflict |
| `test.*fail` / `FAIL` / `AssertionError` | Test failure — read the test + implementation |
| `permission denied` | Auth/permissions issue in the workflow |
| `rate limit` / `403` | API rate limiting |
| `timeout` / `ETIMEDOUT` | Network or resource timeout |
| `lint` / `biome` / `eslint` | Formatting or lint violation |
| `OOM` / `JavaScript heap` | Memory issue — likely a test or build leak |

Cross-reference the error with the codebase:
1. Identify the file and line from the error message
2. Read the relevant code
3. Check if the failure is in code we control or a dependency/infra issue

### 6. Present analysis

For each failing run, present:
- **Root cause**: one sentence
- **Category**: code bug / dependency issue / infra/flaky / config error
- **Fixable by us?**: yes/no
- **Suggested fix**: concrete action or "rerun" if flaky

### 7. Apply fix (if applicable)

If the failure is fixable:

1. Check out the failing branch:
   ```bash
   git checkout <headBranch>
   git pull
   ```
2. Apply the fix
3. Run the check locally if possible (`npm test`, `npm run check`, etc.)
4. Commit and push:
   ```bash
   git add <files>
   git commit -m "fix(ci): description"
   git push
   ```

If the failure is flaky / transient, offer to rerun:
```bash
gh run rerun <run-id> --failed
```

If it's an infra/permissions issue in the workflow file itself:
```bash
# Read the workflow
cat .github/workflows/<name>.yml
# Fix and commit
```

### 8. Verify

After pushing a fix or rerunning:

```bash
# Watch the new run
NEW_RUN=$(gh run list --branch <branch> --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$NEW_RUN" --exit-status
```

Report whether the fix worked. If it failed again, analyze the new
failure.

### 9. Summary

After working through failures:
- N runs investigated
- N fixed (pushed code fix)
- N rerun (flaky/transient)
- N unfixable (dependency/infra — noted for manual follow-up)
