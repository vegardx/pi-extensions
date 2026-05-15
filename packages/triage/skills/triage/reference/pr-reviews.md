# PR Review Triage

Go through open PRs that have automated review comments (Copilot,
GitHub Actions bots, etc.), validate each finding against the actual
code, fix valid ones, and push back to the branch.

## Workflow

### 1. Discover PRs with review comments

```bash
# List open PRs
gh pr list --json number,title,headRefName,state

# For each PR, check for bot reviews
gh api "repos/{owner}/{repo}/pulls/{N}/reviews" \
  --jq '.[] | select(.user.login | endswith("[bot]")) | {id: .id, user: .user.login, state: .state, body: .body}'
```

Skip PRs with no bot review comments — they have nothing to triage.

Present the list of PRs that DO have review comments and let the user
pick which to work through (or work through all of them sequentially).

### 2. Fetch review comments

For each PR with a bot review:

```bash
# Get the review body (top-level summary)
gh api "repos/{owner}/{repo}/pulls/{N}/reviews/{review_id}" \
  --jq '{body: .body, state: .state}'

# Get inline comments from that review
gh api "repos/{owner}/{repo}/pulls/{N}/reviews/{review_id}/comments" \
  --jq '.[] | {path: .path, line: .line, body: .body, side: .side}'
```

If the review body contains inline comments in markdown (some bots embed
them in the body rather than as actual inline comments), parse those too.

### 3. Validate each finding

For each comment/finding:

1. Read the referenced file and surrounding context
2. Classify and decide thread outcome:

| Classification | Meaning | Thread outcome |
|---|---|---|
| **Agree** | Issue is real, suggestion is correct. | Apply fix, resolve thread. |
| **Partial** | Concern is real but the suggested fix is wrong or incomplete. | Apply corrected fix, comment explaining the difference, resolve thread. |
| **Disagree** | Bot misread the code, concern doesn't apply, or already handled. | Comment explaining why, resolve thread. |

Present your assessment to the user with a brief explanation before acting.

**All threads must be resolved** — unresolved threads block auto-merge.
The distinction is what fix (if any) is applied and what comment is left,
not whether the thread is resolved.

### 4. Plan and apply fixes

For agree/partial findings on a single PR:

1. `gh pr checkout {N}` to get on the PR branch
2. Apply fixes (use `edit` tool or write as appropriate)
3. For **partial** findings, note what was done differently — you'll
   need this for the thread reply in step 5
4. Run the project's check/test/lint commands if available
5. Commit with conventional commit format:
   ```bash
   git add <specific-files>
   git commit -m "fix(scope): description of fix"
   ```
6. Push back to the branch (follow `/skill:gh` routing for fork-aware
   push and head-drift detection)

### 5. Resolve all threads

Every thread must be resolved — unresolved threads block auto-merge.
For thread operations (fetch IDs, reply, resolve) see
`/skill:gh` → `reference/pr.md#review-thread-operations`.

- **Agree** — resolve silently.
- **Partial** — reply explaining what was done differently, then resolve.
- **Disagree** — reply explaining why it was not applied, then resolve.

### 5. CI gate

After pushing:

```bash
# Wait a moment for CI to trigger, then check
sleep 10
gh pr checks {N}
```

If checks are pending, inform the user and offer to:
- Wait (`gh run watch <run-id> --exit-status`)
- Move on to the next PR and come back later

If checks fail, analyze the failure (see [actions.md](actions.md) for
log extraction patterns) and offer to fix.

### 6. Merge decision

**Ask the user** whether to merge this PR. Don't merge automatically.

Options to present:
- Merge now (`gh pr merge {N} --squash --delete-branch`)
- Enable auto-merge on this PR (`gh pr merge {N} --squash --delete-branch --auto`)
- Skip merge (leave for later)

### 7. Auto-merge enablement

If the user picks auto-merge and it fails with "not allowed":

```bash
# Check current repo setting
gh api "repos/{owner}/{repo}" --jq '.allow_auto_merge'
```

If `false`, ask the user:

> Auto-merge is not enabled on this repository. Enable it?
> This allows PRs to merge automatically once all required checks pass.

If they confirm:

```bash
gh api "repos/{owner}/{repo}" -X PATCH -f allow_auto_merge=true
```

Then retry the auto-merge:

```bash
gh pr merge {N} --squash --delete-branch --auto
```

Only ask about repo-level auto-merge once per session — if the user
declines, don't ask again for subsequent PRs.

### 8. Repeat

Move to the next PR and repeat from step 2. After all PRs are done,
summarize what was accomplished:
- N PRs processed
- N findings validated (X valid, Y invalid)
- N fixes applied and pushed
- N PRs merged / N queued for auto-merge / N skipped
