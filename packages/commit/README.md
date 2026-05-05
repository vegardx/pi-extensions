# pi-ext-commit

End-to-end commit workflow. `/commit` analyzes the working tree, asks
the agent for a conventional-commit plan (single or multi), executes
after explicit confirmation, pushes with fork-aware routing and
head-drift detection, and creates or updates the PR. **Auto-appends
`Closes #N`** when the branch is linked to a tracking issue — closing
the loop on `/develop`'s park path.

Ported from the `commit` plugin in
[awesome-agents](https://dnb.ghe.com/github/awesome-agents). The
deterministic parts (preflight, pickers, push routing, head-drift
detection, `gh` calls) live in TypeScript; commit-message and PR-body
generation stay on the main agent via `pi.sendMessage` +
`ctx.waitForIdle()`.

## What's inside

- `index.ts` — `/commit [guidance]` command. Drives the workflow end-to-end.
- `helpers.ts` — pure helpers:
  - `parseTitleAndBody(text)` — pulls TITLE/BODY out of the agent's PR reply
  - `isSafeBranchName` / `isValidIssueNumber` — shell-injection guards
  - `buildForkUrl(originUrl, forkNameWithOwner)` — swaps the path
    component of the origin URL while preserving host, protocol, and
    auth bits. Used to add a fork remote on a cross-repo PR.
  - `summarisePlan(text)` — first usable line, for picker titles.
- `git.ts` — thin `spawnSync` wrappers for every git op we do.
- `gh.ts` — `gh` wrappers: `findOpenPr`, `viewPr`, `createPr`, `editPr`
  with JSON parsing and error surfacing.
- `skills/commit/SKILL.md` — the workflow described for the agent.
  Usable standalone via `/skill:commit` even without the extension.
- `__tests__/helpers.test.ts` — 24+ tests for pure helpers.

## Commands

| Command | Effect |
|---|---|
| `/commit` | Full workflow: analyze → propose → execute → push → PR. |
| `/commit <guidance>` | Same, but hands the guidance to the agent as the starting point for the plan. |

## Workflow

1. **Preflight** — verify repo, working tree has changes, current
   branch is safe. If you're on the default branch, a confirm dialog
   asks whether to continue (you usually want to branch first via
   `/develop <desc>`).
2. **Offer `/review`** — picker: run review first, or commit now. If
   review, the extension calls `runReview(...)` from `pi-ext-review/core`
   directly (in-process via dynamic `import()`), gated on the extension
   being installed. When `runReview` returns, `/commit`'s flow
   continues into the plan step automatically — no need to re-invoke
   `/commit` manually. (Earlier drafts dispatched `/review` via
   `pi.sendUserMessage("/review")` and asked the user to re-invoke,
   but that path was hard-coded to skip slash expansion in
   pi-coding-agent ≤ 0.73.0; see
   [badlogic/pi-mono#2549](https://github.com/badlogic/pi-mono/issues/2549),
   [#2994](https://github.com/badlogic/pi-mono/issues/2994), and
   [#3673](https://github.com/badlogic/pi-mono/issues/3673).)

   **Skipping the offer.** Callers of `runCommit({ ..., skipReviewOffer:
   true })` bypass this picker entirely with a one-line breadcrumb
   notification. Used by `/review`'s `chainToCommit` so the user
   isn't asked "Run /review before committing?" right after they
   already walked a /review run — see
   [`packages/review/README.md`](../review/README.md) step 9.
3. **Plan** — `pi.sendMessage(..., deliverAs: "followUp", triggerTurn:
   true)` with a prompt asking the agent to analyze the diff and
   propose a conventional-commit plan. `ctx.waitForIdle()` blocks the
   command until the agent's turn ends.
4. **Execute picker** — Commit / Edit plan / Cancel. Edit opens
   `ctx.ui.editor` prefilled with the agent's plan; the edited text is
   handed back to the agent verbatim as the execution instruction.
5. **Execute** — another `sendMessage` + `waitForIdle`. The agent runs
   `git add <explicit paths>` and `git commit` per the plan. After the
   turn, the extension compares `HEAD` before/after; if nothing
   advanced, it aborts the push/PR steps.
6. **Push picker** — Push and manage PR / Push only / Don't push.
7. **Push routing** — if no PR or same-repo PR, push to `origin`. If
   cross-repo with `maintainerCanModify: false`, offer
   `git format-patch` instead of pushing. If cross-repo with
   `maintainerCanModify: true`, add the fork as a remote (URL derived
   from origin with path swapped), fetch, and push there.
8. **Head-drift** — `git merge-base --is-ancestor` then tree comparison
   to distinguish "author amended/rebased to same content" from "real
   new upstream commits". In the first case, `git rebase --onto`
   replays automatically; in the second, the user is asked
   Rebase/Force-push/Abort.
9. **Tracking issue** — read `branch.<name>.tracking-issue`. If unset,
   optionally offer to link one (digits-only validation).
10. **PR title/body** — the agent is asked to emit title and body
    wrapped in `---TITLE---` / `---BODY---` / `---END---` sentinels.
    The extension parses them, previews, and offers Create/Update,
    Edit first, or Skip.
11. **Return to default** — optional `git checkout + pull` of the
    default branch.

## Integration with `/develop`

This closes the loop on `/develop`'s park path. When the user runs
`/develop <desc>` and picks Park, the extension persists
`git config branch.<name>.tracking-issue <N>` where `<N>` is the
created issue number. When the user later creates the branch (manually
or via `/develop <same desc>` + Implement) and runs `/commit`, step 9
reads that config and step 10 appends `Closes #<N>` to the PR body.
GitHub auto-closes the issue when the PR merges into the default
branch.

**Before this package**: the `/park` config was dead code — nothing read it.

## Safety

- **Never stages via `-A` / `-u` / `.`**. The plan prompt explicitly
  instructs the agent to use explicit paths, because blanket staging
  can pick up `.env` files and other files the user didn't mean to
  commit.
- **Explicit confirmation before any git mutation.** No commits are
  made before the Commit picker resolves.
- **Force-push requires two confirmations** — the fork-drift picker
  AND a separate confirm dialog. Never implicit.
- **Shell-injection guards** on every branch name and issue number
  interpolated into `git config` keys.

## Test

```bash
pi -e ./packages/commit
```

Try on a small change:

```
/commit
```

Walk through the workflow. To exercise the editor, pick "Edit plan
before committing" at step 4. To exercise fork handling, open a PR
from a fork (by forking the repo and opening a PR upstream) and run
`/commit` on the upstream clone.

## Known limitations

- **`gh` required** for the push + PR steps. If `gh` isn't installed
  or authed, the push step stops with an error; commits remain local.
- **Host routing relies on `gh`'s auto-detection.** See [`/skill:gh`](../gh/skills/gh/SKILL.md)
  for the rules. Works for public `github.com`, GHEC-DR tenants, and
  GHES. If you're operating on a non-default host **and** a cross-repo
  PR, `buildForkUrl` preserves the host — tested for both SSH and
  HTTPS origin formats.
- **No squash/rebase merge.** We create/update the PR; merging is
  still a user decision (via `gh pr merge` or the GitHub UI).
- **No commit-message signing.** The agent runs `git commit` with
  whatever your local config specifies (GPG/SSH sign if enabled,
  otherwise unsigned). We don't pass `-S` ourselves.
- **Agent must emit TITLE/BODY sentinels.** If the agent ignores the
  format instruction, the extension skips the PR step with a
  warning. The user can still create the PR manually.

## Related

- `/develop` — plans a change; `/park` writes the tracking issue this
  command reads.
- `/review` — multi-agent code review, recommended before committing.
- `/skill:gh` — multi-host routing reference.
