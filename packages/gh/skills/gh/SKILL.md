---
name: gh
description: Use this skill for GitHub operations via the gh CLI — PRs, issues, CI/CD, releases, search, and API calls. Explains multi-host auth routing for github.com, corporate GHE (e.g. dnb.ghe.com), and GHES instances. Other workflow commands (/commit, /develop park path, /review PR mode) dispatch through these conventions.
---

# GitHub CLI

Use the `gh` CLI for GitHub operations. Prefer it over any MCP GitHub
server — it's faster, more reliable, and uses 9–32× fewer tokens for the
same operation.

## Multi-host routing

You may be authenticated to multiple GitHub hosts in the same shell
session — public `github.com`, a corporate GHEC-DR tenant
(`<tenant>.ghe.com`), a self-hosted GHES instance, or any combination.
Determining the right host before running a command is the one thing you
have to get right; everything else falls out of it.

### How to figure out the host

Try these in order:

1. **Explicit URL in the user's message.** If the user pastes
   `https://dnb.ghe.com/org/repo/pull/42`, extract the host — that's
   authoritative.
2. **Current repo's remote.** Inside a git repo:
   ```bash
   git remote get-url origin
   # e.g. git@dnb.ghe.com:org/repo.git → host is dnb.ghe.com
   # e.g. https://github.com/org/repo.git → host is github.com
   ```
   If you're in a repo, this is the host for operations on that repo.
3. **Default assumption.** If the current repo is on a corporate GHE
   host, assume the user means that host unless they say otherwise. If
   they reference a well-known public repo (e.g. `facebook/react`,
   `kubernetes/kubernetes`), assume `github.com`.
4. **Ask.** If none of the above pins it down, ask the user.

### Running commands against a host

**When the target is the current repo, do not set a host flag.**
`gh` auto-detects from the git remote. This works for every host type —
public, GHEC-DR, GHES:

```bash
# All of these work in a repo on dnb.ghe.com OR github.com OR GHES —
# gh picks the host from the current origin remote.
gh pr create --fill
gh pr list
gh run list --branch main
gh release create v1.0.0
gh api repos/{owner}/{repo}/pulls
```

**When the target is a different repo, use `-R <host>/<owner>/<repo>`.**
Available since `gh` 2.90+; it's the cleanest form:

```bash
gh pr list -R dnb.ghe.com/org/other-repo
gh issue view 123 -R github.com/anthropic/claude-code
```

For **`gh api`** against a different host, use `--hostname`:

```bash
gh api --hostname dnb.ghe.com repos/org/other-repo/pulls
```

**Backward-compatible fallback** for older `gh` versions:

```bash
GH_HOST=dnb.ghe.com gh pr list -R org/other-repo
```

**Public `github.com` cross-repo (the default host) — no prefix needed:**

```bash
gh pr list -R owner/repo
```

### Verify auth before operations

Before running anything, if you haven't already this session:

```bash
gh auth status -h dnb.ghe.com
gh auth status -h github.com
```

If you see "not logged in", tell the user to run `gh auth login -h <host>`
and stop — don't try to work around it.

## Cross-repo and fork-aware pushes

This is the gotcha corner where most workflow skills (`/commit`,
`/review` PR mode, `/pr-review`) dispatch through these rules.

### Detecting whether a PR is cross-repo

```bash
gh pr view <N> --json isCrossRepository,maintainerCanModify,headRepository,headRepositoryOwner,headRefName,baseRefName
```

- `isCrossRepository: true` → the PR's head branch lives in a **fork**,
  not the upstream. Pushing to `origin` from the upstream clone will
  create a stray branch on the upstream and will **not** update the PR.
- `maintainerCanModify: true` → the PR author allowed upstream
  maintainers to push to the head branch. You can push to the fork
  directly (see below).
- `maintainerCanModify: false` or absent → you can't push. Offer the user
  a patch series (`git format-patch origin/<base>..HEAD`) or have them
  ask the PR author to pick up the changes.

### Pushing to a fork head

When `maintainerCanModify` is true and the PR is cross-repo:

```bash
fork_owner="<headRepositoryOwner.login>"           # e.g. janedoe
fork_path="<headRepository.nameWithOwner>"          # e.g. janedoe/repo
head_branch="<headRefName>"                         # e.g. feat/foo

# Swap only the path component of the origin URL so you keep host + protocol.
fork_url=$(git remote get-url origin | sed "s|[^/:]*/[^/]*\.git$|${fork_path}.git|")

# Idempotent remote add — safe to run every time.
git remote add "$fork_owner" "$fork_url" 2>/dev/null || true
git fetch "$fork_owner" "$head_branch"

# Push to the fork, update the PR.
git push "$fork_owner" "HEAD:${head_branch}"
```

Do **not** delete the fork remote automatically — the user may want it
around for follow-up commits. They can clean up with
`git remote remove <fork_owner>` when they're done.

### Head-drift detection

Between the time you pulled the PR and the time you try to push, the
author may have pushed / amended / rebased. Verify before pushing:

```bash
remote_head="${target}/${target_branch}"
git merge-base --is-ancestor "$remote_head" HEAD
```

- **Exit 0** (local is a descendant): push directly, fast-forward.
- **Exit 1** (remote moved): compare trees at the divergence point —
  ```bash
  our_base=$(git merge-base "$remote_head" HEAD)
  git diff --quiet "$our_base" "$remote_head"
  ```
  - **Exit 0** (trees identical): the author amended/rebased to the
    same content with different SHAs. Replay your commits onto the new
    head — no conflicts expected:
    ```bash
    git rebase --onto "$remote_head" "$our_base" HEAD
    ```
  - **Exit 1** (trees differ): real upstream commits you don't have.
    Stop and ask the user: rebase-onto-remote (may conflict),
    force-push (destructive — require explicit consent), or abort.

## General patterns

### Prefer structured output when parsing

```bash
gh pr list --json number,title,author,state,updatedAt
gh pr list --json number,title,labels --jq '.[] | select(.labels | map(.name) | index("bug"))'
```

### Prefer subcommands over `gh api`

Use `gh pr`, `gh issue`, `gh run`, `gh release` etc. when they cover
what you need. Fall back to `gh api` only for operations without a
dedicated subcommand.

### Always be explicit about the target repo

When the target isn't the current directory's repo, pass `-R` (or
`--hostname` for `gh api`). Implicit targeting causes subtle bugs when
the current directory's remote is the corporate host but you're trying
to reference a public repo (or vice versa).

## Operations quick reference

| Category | Commands | Reference |
|---|---|---|
| Pull requests | `gh pr list/view/create/review/merge/diff/checks` | [reference/pr.md](reference/pr.md) |
| Issues | `gh issue list/view/create/edit/comment/close` | [reference/issues.md](reference/issues.md) |
| CI/CD | `gh run list/view/watch/rerun`, `gh workflow run` | [reference/ci.md](reference/ci.md) |
| Releases | `gh release create/list/view/download` | [reference/releases.md](reference/releases.md) |
| Search | `gh search code/issues/prs/repos/commits` | [reference/search.md](reference/search.md) |
| Raw API | `gh api` for REST and GraphQL | [reference/api.md](reference/api.md) |

### Common patterns

```bash
# List my open PRs on the current repo
gh pr list --author @me --state open

# View PR diff
gh pr diff 123

# Check CI status on a PR
gh pr checks 123

# Create a PR from current branch
gh pr create --fill

# List issues assigned to me
gh issue list --assignee @me

# Search code across an org
gh search code "pattern" --owner org-name

# Get repo info as JSON
gh repo view --json name,description,defaultBranchRef

# Checkout a PR locally (auto-fetches the fork if needed)
gh pr checkout 123

# Clone a repo
gh repo clone owner/repo

# Fork a repo
gh repo fork owner/repo --clone

# Create a new repo
gh repo create my-repo --private --clone
```

## Used by

- `/commit` — fork-aware push and PR create/update.
- `/develop` (park path) — `gh issue create` routed via the current
  remote's host.
- `/review` (future PR mode) — fork-aware checkout and head-drift
  detection when reviewing a remote PR.
