---
name: develop
description: Plan a change before coding. Sync to the default branch, explore the codebase read-only, produce a numbered plan, then either create a feature branch and execute with per-step progress tracking, or park the plan as a GitHub tracking issue. Use when starting any new feature, bug fix, refactor, or documentation task. Invoked by the /develop extension command; can also be used standalone via /skill:develop.
---

# Develop

Plan a change on the default branch, then either start implementing (with
`[DONE:n]` progress markers tracked by the extension) or park the plan as
a GitHub tracking issue for later pickup. Safe to use both from inside
the `pi-ext-develop` extension (which enforces read-only plan-phase tools
and parses the plan into a live todo widget) and standalone — the
workflow is the same.

## Workflow

1. Prerequisites and sync (automated when called from `/develop`)
2. Plan phase — read-only exploration, produce a numbered plan
3. Wait for the user to pick Implement / Park / Continue discussing
4. Implement path: execute the plan; emit `[DONE:n]` as you finish steps
5. Park path: stop; the extension will write a GitHub issue

## Step 1: Prerequisites and sync

These steps are handled for you when called from the `/develop` extension
command. Only do them manually if running standalone via
`/skill:develop`:

```bash
git rev-parse --is-inside-work-tree
# resolve default branch
git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||'
# fall back to main / master if that returns nothing
git checkout <default-branch>
git pull --ff-only origin <default-branch>
```

Do **not** create the feature branch yet. Planning runs on the default
branch so the park path can defer branch creation.

## Step 2: Plan phase

**When invoked via `/develop`, your tools are restricted.** Only `read`,
`grep`, `find`, `ls`, and a read-only subset of `bash` are available.
`edit` and `write` are blocked; `bash` commands that mutate state (rm,
mv, git add/commit/push, package installs, sudo, editors, redirection,
etc.) are blocked at call time. Running them returns a refusal rather
than executing — produce the plan first, then let the user pick
Implement to unlock full tools.

Explore the codebase as needed: `read` files, `grep` for patterns, walk
directory trees with `find` / `ls`, inspect history with `git log` /
`git diff` / `git status` — all allowed.

Produce a plan under a `Plan:` header with numbered steps. **The exact
header and numbered format matters** — the extension parses this format
into a live todo widget. Keep it simple:

```
Plan:
1. Add the webhook route handler in src/routes/webhooks.ts
2. Wire the refund processor through to the payments module
3. Add unit tests for the failure paths
4. Update the README with the new endpoint
```

Style notes:

- Header can be plain `Plan:`, `**Plan:**`, or `## Plan:` — all fine.
- Numbered items: `1. foo` or `1) foo`. Stick to numbers; bullets are
  ignored.
- Keep each step under ~60 characters for the widget; detail can go in
  surrounding prose.
- Avoid starting a step with `` ` ``, `/`, or `-` — those look like
  code/paths/bullets and the parser skips them.

You can put context, risks, or questions above or below the `Plan:`
block — only the numbered lines under the header become todos. A useful
shape:

```markdown
## Context
Short summary of what I'm about to do and why.

## Files affected
- `path/to/file.ts` — what changes here
- `path/to/other.ts` — what changes here

Plan:
1. First step
2. Second step
...

## Risks / open questions
- Anything ambiguous the user should weigh in on.
```

Finish the turn at the end of the plan. **Do not start implementing.**
The extension watches for `agent_end` and will pop a three-way picker
the moment you stop. If you are running standalone (no extension),
explicitly ask the user: "Implement, Park, or Continue discussing?" and
wait.

## Step 3: Wait for the user's choice

When called via `/develop`, the extension dispatches for you:

- **Implement** — the extension creates the branch, renames the
  session, restores full tools, injects an execution-context message,
  and triggers a new turn. Proceed to Step 4.
- **Park** — the extension grabs the plan snapshot (taken the moment
  you finished producing the plan, so later chat can't corrupt it),
  secret-scans it, creates a GitHub issue, and stores the intended
  branch name in git config. You are done; stop.
- **Continue discussing** — plan-phase lockdown is lifted so normal
  conversation works; no dispatch. Keep iterating on the plan with
  the user until they run `/implement` or `/park` (or reopen the
  picker with `/develop-choose`).

Standalone (no extension) equivalents:

- Implement: ask the user to run `git checkout -b <prefix><slug>` and
  continue once they confirm.
- Park: ask the user to run `gh issue create --title … --body-file …`
  using the plan as the body.

## Step 4: Implement path — execute the plan

You are now on the feature branch, full tools restored. The extension
has injected an execution-context message listing the remaining steps.

Execute the plan in order. When you finish a step, **include its
marker inline in your reply** — for example:

```
I've added the webhook route handler and the refund processor [DONE:1]
[DONE:2]. Running tests next.
```

Multiple `[DONE:n]` markers per turn are fine. The extension parses
these from `turn_end` and updates the todo widget live.

Rules:
- Emit `[DONE:n]` **after** the code change has landed and, if
  applicable, tests for that step pass. Don't mark a step done while
  still debugging it.
- If you discover the plan was wrong mid-execution, say so in prose
  and propose a revised plan. Don't silently deviate and emit `[DONE:n]`
  for something the user didn't agree to.
- When every step is marked done, the extension shows a "Plan complete"
  message and clears its widget. At that point: wrap up (run full
  tests, `git status`, etc.) and stop. Do not rebase, merge, or push —
  that is the user's call.

## Branch naming (for reference / standalone use)

The extension derives this automatically. For manual use, the rules are:

| Intent | Prefix | Signals |
|--------|--------|---------|
| New feature | `feat/` | add, implement, create, new, support, introduce, build |
| Bug fix | `fix/` | fix, bug, broken, error, crash, issue, regression, patch |
| Refactor | `refactor/` | refactor, restructure, reorganize, simplify, cleanup, rework |
| Documentation | `docs/` | doc, docs, documentation, readme, guide, tutorial |
| Tooling / config | `chore/` | chore, config, ci, tooling, deps, upgrade, bump |

Slug: lowercase the description, keep `[a-z0-9]+` tokens, take the
first 3–5, join with `-`, cap at 50 characters.

Example: `add payment webhooks for refund flow` → `feat/add-payment-webhooks-for-refund`.

## When NOT to use

- Mid-task continuations on an existing branch — keep working.
- Tiny one-line fixes — the plan-first ceremony isn't worth it.
- Not in a git repository — the extension aborts at step 1.

## Safety

The park path publishes to GitHub. Before parking, the extension scans
the plan for plausible secrets (API keys, `.env` fragments, long
high-entropy strings). If any are detected, it asks for explicit
confirmation. When running standalone, do the scan yourself before
handing the plan text to `gh issue create`.
