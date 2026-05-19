# pi-ext-gh

Skills-only package. `/skill:gh` is the canonical reference for running
GitHub operations via the `gh` CLI — covers multi-host auth routing,
cross-repo / fork-aware pushes, head-drift detection, and links out to
per-category operation references (PR, issues, CI/CD, releases, search,
raw API).

Ported from the `gh` plugin in
[awesome-agents](https://dnb.ghe.com/github/awesome-agents), adapted for
pi (dropped the "don't use the MCP GitHub server" guidance since pi
doesn't have the same tool competition).

## What's inside

- `skills/gh/SKILL.md` — main skill. Host-detection rules, when to set
  `-R` vs. `--hostname`, how to push to a fork on a cross-repo PR, how
  to detect head drift.
- `skills/gh/reference/` — category-specific command refs:
  - `pr.md` — pull requests
  - `issues.md` — issues
  - `ci.md` — GitHub Actions workflows and runs
  - `releases.md` — releases
  - `search.md` — `gh search` across code / issues / PRs / repos / commits
  - `api.md` — raw `gh api` (REST and GraphQL)

## How to invoke

Explicitly:

```
/skill:gh
```

The description also lets pi's agent auto-suggest it when a GitHub
operation comes up.

## Why this exists

Other workflow packages (`pi-ext-commit`, `pi-ext-develop`'s park path,
future `pi-ext-review` PR mode) all do GitHub operations. Rather than
re-documenting the host-routing rules in every package, they all point
at this skill. One source of truth for:

- "Am I on public `github.com`, corporate GHE, or GHES?"
- "When do I need `-R`? When do I need `--hostname`? When neither?"
- "How do I push to a fork on a cross-repo PR without creating a stray
  branch on the upstream?"
- "How do I detect the PR author force-pushed while I was working?"

## Related

- `/commit` — reads `branch.<name>.tracking-issue` (set by `/park`),
  pushes with the routing rules from this skill, creates or updates the
  PR, appends `Closes #N`.
- `/plan` park path — uses `gh issue create --body-file` with the
  host auto-detected from the current remote.
