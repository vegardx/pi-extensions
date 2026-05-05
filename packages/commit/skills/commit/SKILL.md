---
name: commit
description: End-to-end commit workflow. Analyze the working tree, propose a conventional-commit plan (single or multi-commit), execute the commits after explicit confirmation, push, and create or update a pull request. Auto-appends `Closes #N` when the branch is linked to a tracking issue (typically set by `/develop`'s park path). Invoked by the /commit extension command; can also be used standalone via /skill:commit.
---

# Commit

Analyze changes, plan commits, execute, push, and manage the PR. Closes
the loop opened by `/develop` — commits generated here auto-link to any
tracking issue `/park` wrote to `git config`.

This skill can be invoked two ways:

- **With the `pi-ext-commit` extension** — `/commit [optional guidance]`.
  The extension owns the deterministic parts (preflight, pickers, git
  routing, head-drift detection, `gh` calls). You see the workflow
  mostly through `ctx.ui.select` pickers; this skill content only loads
  if the user runs `/skill:commit` or the extension isn't available.
- **Standalone** — `/skill:commit [guidance]`. You drive the whole flow
  yourself; user replies in plain text for each decision.

## Workflow

1. Preflight — verify repo, changes exist, current branch is safe
2. Offer `/review` first
3. Propose a commit plan
4. Execute commits after confirmation
5. Push (fork-aware routing, head-drift detection)
6. Create or update the PR, auto-linking tracking issue
7. Optionally return to the default branch

## Step 1: Preflight

```bash
git rev-parse --is-inside-work-tree      # must be a git repo
git status --porcelain                     # must have changes
git branch --show-current                  # must be on a named branch
```

If you're on the default branch (`main` / `master`), ask whether to
continue — usually the user meant to branch first.

## Step 2: Offer `/review` first

`/review` runs a multi-agent review and surfaces findings before the
commit message hardens around them. Offer it, but let the user skip.

Standalone wording: "Run `/review` first, or commit now?"

If running with the extension, the picker handles this; when the user
picks Review, the extension dispatches `/review` for them via
`pi.sendUserMessage` and prints a short re-invoke note. Standalone
(this skill alone), suggest `/review` to the user and stop — you
can't dispatch slash commands from skill context.

## Step 3: Propose a commit plan

Gather context:

```bash
git status --short
git diff --stat
git diff
git diff --cached
```

Decide whether this is one logical commit or multiple. Use
**conventional commit** format:

- `type(scope): short subject`
- Subject ≤ 72 chars
- Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `style`,
  `perf`, `ci`, `build`
- Multi-line body only when the change needs explanation

**Multi-commit plans**: order the commits meaningfully (deps first,
then logical layers). For each commit specify:

- Files to stage — explicit paths, never `git add -A` / `-u` / `.`
  (those can stage `.env` and other files you didn't mean to touch).
- The commit message.

If `$ARGUMENTS` contains guidance (e.g. `/commit fix the webhook
timeout`), use it as the starting point.

Output the plan as readable markdown and finish the turn. Do NOT commit
yet — the user must confirm first.

## Step 4: Execute

After explicit user confirmation:

```bash
# For each commit in the plan, in order:
git add <explicit> <paths> <only>
git commit -m "<subject>"            # or -m subject -m body
```

After every commit run `git log -1 --oneline` so the user can verify.
Stop at the last commit — do not push yet.

## Step 5: Push — fork-aware routing

**This is where most "the PR didn't update" bugs come from.** Before
pushing, check whether the current branch has an open PR and whether
that PR is cross-repo:

```bash
branch=$(git branch --show-current)
gh pr list --head "$branch" --state open \
  --json number,title,body,isCrossRepository,maintainerCanModify,headRepository,headRepositoryOwner,headRefName \
  --limit 1
```

See [`/skill:gh`](../gh/SKILL.md) for the full routing rules. Summary:

- **No PR, or same-repo PR** → `git push origin HEAD:<branch>`.
- **Cross-repo PR, `maintainerCanModify: false`** → DO NOT push. Offer
  a patch series via `git format-patch origin/<base>..HEAD` instead.
- **Cross-repo PR, `maintainerCanModify: true`** → push to the fork:
  add the fork remote (derived from origin with the path swapped),
  fetch its head, push there.

### Head-drift detection

```bash
remote_head="${target}/${target_branch}"
git merge-base --is-ancestor "$remote_head" HEAD
```

- Exit 0 → fast-forward push, you're good.
- Exit 1 → remote moved. Check if trees match at the base:
  ```bash
  our_base=$(git merge-base "$remote_head" HEAD)
  git diff --quiet "$our_base" "$remote_head"
  ```
  - Trees match → author amended/rebased; replay:
    `git rebase --onto "$remote_head" "$our_base" HEAD`
  - Trees differ → real upstream commits. Ask user: rebase (may
    conflict), force-push (destructive — require explicit consent), or
    abort.

Never force-push without explicit user confirmation.

## Step 6: PR create or update

### Tracking issue

Read the link:

```bash
issue=$(git config "branch.${branch}.tracking-issue" 2>/dev/null || true)
```

If set, append `Closes #<issue>` as the final line of the PR body. When
the PR merges into the default branch, GitHub auto-closes the issue.

If unset, optionally offer to link one:

- Ask for an issue number (digits, optional `#` prefix).
- Validate `^[1-9][0-9]{0,6}$`.
- Persist: `git config branch.${branch}.tracking-issue <N>`.

### Title and body

**PR writing rules**:

- Describe what the diff does *now* — not alternatives, not prior
  iterations, not discarded approaches.
- Plain factual language. Avoid filler: *critical, crucial, essential,
  significant, comprehensive, robust, elegant*.
- Title follows conventional commit style matching the commit(s).
- Body: brief summary paragraph, optional bullet list of concrete
  changes. Short.

### When the extension drives

The extension asks the agent to emit the title and body wrapped in
sentinels so it can parse them reliably:

```
---TITLE---
short one-line title
---BODY---
multi-line markdown body
---END---
```

Produce exactly those sentinels with no other content between them.
Free-form commentary around them is fine; the extension only reads
what's between the sentinels.

### Create or update

```bash
# New PR
gh pr create --title "<title>" --body-file -    # body on stdin

# Existing PR — overwrite title/body
gh pr edit <number> --title "<title>" --body-file -
```

## Step 7: Return to default

Offer to checkout + pull the default branch so the user is ready for
the next task:

```bash
default=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')
git checkout "$default"
git pull --ff-only origin "$default"
```

Don't force this — the user may want to keep working on the feature
branch (follow-up commits, fixes).

## When NOT to use

- No changes in the working tree — nothing to commit.
- Detached HEAD — resolve the branch situation first.
- Mid-rebase or merge conflict — finish that first.
- Your changes aren't ready for review — run tests, `/review`, etc.
  before committing.

## Related

- `/develop` — plans a change; `/park` writes `branch.<name>.tracking-issue`
  which this skill picks up.
- `/review` — multi-agent code review. Recommended before committing.
- `/skill:gh` — multi-host routing, fork-aware pushes, head-drift
  detection. This skill dispatches through it.
