# π-extensions

[![CI](https://github.com/vegardx/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/vegardx/pi-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

My opinionated setup for [pi](https://github.com/badlogic/pi-mono) — a phase/task plan model, a four-mode permission cycle, and a small skill ecosystem on top.

## The workflow

```
/plan    →  Shift+Tab  →  /implement  →  /ship
 plan        ask/auto      auto loop      PR up
```

`/plan` builds a phase/task plan in [plan mode](packages/modes#mode-transitions) (read-only tools, no writes). Shift+Tab opens the Implement / Park / Continue picker. `/implement` creates a feature branch, switches to `auto`, and works the active phase end-to-end. `/ship` commits, pushes, opens the PR, and the auto loop walks to the next phase.

Each phase runs in its own pi session, **seeded** from a deterministic render of the plan doc — no LLM call. Shipped phases' summaries carry forward into later phases verbatim, so phase N walks in pre-loaded with what 1…N-1 actually discovered. Plan mode delegates codebase questions to a persistent **explore** sub-agent (non-blocking) and one-shot **research** lookups for the web. Full details in [`packages/modes/README.md`](packages/modes/README.md).

## The mode cycle

`hack` → `plan` → `ask` → `auto` → `hack`, cycled by **Shift+Tab**:

| Mode | What it is |
| --- | --- |
| `hack` | All tools, no safety net — full tool access, you own context length. |
| `plan` | Read-only tools (`read`, `grep`, `find`, `ls`, `bash` reads, `websearch`, `webfetch`, plan tools, `explore_*`, `research`). Writes refused outright. |
| `ask` | Same tools as `auto`, but pauses at the commit/ship boundary so you can review the diff. |
| `auto` | Fully autonomous — `/commit` (non-interactive) → `/ship` → `/implement` next phase, all without prompting. |

See the [mode-transitions diagram](packages/modes/README.md#mode-transitions) for the full state machine, including which transitions prompt the user, where session boundaries fire, and where compaction happens.

## Skills

Project-local skills, invoked with `/skill:<name>` (or auto-loaded by their parent extension):

| Skill | What it does |
| --- | --- |
| [`commit`](packages/commit/skills/commit/SKILL.md) | End-to-end commit workflow: analyse working tree, propose conventional-commit plan, execute, push, open/update PR. |
| [`review`](packages/review/skills/review/SKILL.md) | Multi-agent code review — fans out seven specialist lenses (architect, code-reviewer, scope-analyst, security-analyst, code-simplifier, doc-reviewer, dependency-checker). |
| [`triage`](packages/triage/skills/triage/SKILL.md) | GitHub inbox triage — PRs with review comments, open issues, failing CI, stale PRs. |
| [`gh`](packages/gh/skills/gh/SKILL.md) | GitHub via `gh` CLI: PRs, issues, CI/CD, releases, multi-host auth routing (github.com, GHE, GHES). |
| [`exa-search`](packages/exa/skills/exa-search/SKILL.md) | Semantic web search via Exa's API — current information, prior art, library comparisons. |
| [`context7`](packages/context7/skills/context7/SKILL.md) | Version-accurate library docs via the Context7 API — React, Next.js, Prisma, tRPC, etc. |
| [`diagnose`](packages/modes/skills/diagnose/SKILL.md) | Disciplined diagnosis loop for hard bugs and perf regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test. |
| [`improve`](packages/modes/skills/improve/SKILL.md) | Find architectural friction and propose deepening opportunities. |
| [`document`](packages/modes/skills/document/SKILL.md) | Create or update project documentation when terminology is resolved. |
| [`propose-skill`](packages/modes/skills/propose-skill/SKILL.md) | Analyse the current session for repeated patterns and propose new project-local skills. |

The `review` skill backs `/review`, which the `modes` extension can run automatically after each implement loop (off by default — opt in per-repo via `extensionConfig.modes.review.enable`).

## Extensions

| Package | Surface | What it does |
| --- | --- | --- |
| [`modes`](packages/modes) | `/plan` `/implement` `/park` `/ship` `/sync` `/worktree` `/modes-status` | Centrepiece. Phase/task plans, mode cycle, worktree-bound execution, three-tier compaction, async explore/research. Replaces `/develop`. |
| [`commit`](packages/commit) | `/commit` | Drives the `commit` skill end-to-end. |
| [`review`](packages/review) | `/review` | Drives the `review` skill — seven specialist reviewers fanned out in parallel. |
| [`wrap-up`](packages/wrap-up) | `/pause` `/continue` | Session handover doc, branch/repo-aware resume. |
| [`derp`](packages/derp) | `/derp <text>` | Fire-and-forget GitHub bug reporter that doesn't interrupt the session. |
| [`startup`](packages/startup) | `/extensions` | Reports loaded extensions, commands, tools, configs, and active models on session start. |
| [`session-title`](packages/session-title) | `/title` `/title-position` `/retitle` | Pins a user-configurable title (header or terminal title bar); auto-titles new sessions. |
| [`prompt-suggestion`](packages/prompt-suggestion) | `/suggest` `/suggest-status` | Inline ghost-text next-message predictions after each turn. |
| [`caffeinate`](packages/caffeinate) | `/caffeinate` | macOS keep-awake helper, refcounted, footer indicator. |
| [`webfetch`](packages/webfetch) | `webfetch` tool | Fetch a URL and extract main content as clean Markdown (Defuddle + optional LLM summary). |
| [`gh`](packages/gh) [`triage`](packages/triage) [`context7`](packages/context7) [`exa`](packages/exa) | skills | See the Skills table above. |
| [`structured-dialog`](packages/structured-dialog) | shared | Tabbed multi-item TUI primitive shared by `review`, `wrap-up`, and `modes`. Not loaded standalone. |
| [`_shared`](packages/_shared) | internal | Model resolver, settings helpers, macOS caffeinate wrapper. Used by other packages, not loaded directly. |

## Background models

Several extensions call an LLM on a side task — ghost text, auto-titling, branch slug generation, commit messages, the explore/research sub-agents, the seven review lenses. None hard-code a provider or model. Each declares a **tier** (`fast` / `normal` / `heavy`) and you decide what that means in `settings.json`.

```jsonc
// ~/.pi/agent/settings.json
{
  "backgroundModels": {
    "primary": {
      "fast":   "anthropic/claude-haiku-4-5-20251001",
      "normal": "anthropic/claude-sonnet-4-6",
      "heavy":  "anthropic/claude-opus-4-7"
    },
    "secondary": {
      "fast":   "openai/gpt-5.4-mini",
      "normal": "openai/gpt-5.5",
      "heavy":  "openai/gpt-5.5-pro"
    }
  }
}
```

`secondary` is the cross-model check — `/review` (and the post-implement auto-review pass in `modes`) runs each reviewer lane against both `primary` and `secondary` and only surfaces findings both agree on.

→ [Full background-model docs](docs/configuring-models.md) — tiers, resolution order, cross-model checking, provider and gateway notes.

## Quickstart

```bash
npm install
pi -e ./packages/startup    # smoke-test
```

## Install all extensions

```bash
pi install git:github.com/vegardx/pi-extensions
```

## Docs

- [`packages/modes/README.md`](packages/modes/README.md) — modes deep-dive: state diagram, plan model, session lifecycle, compaction, multi-driver execution.
- [Configuring background models](docs/configuring-models.md)
- [pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)

## Inspired by

- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) — `diagnose` and `improve` skills adapted from Matt Pocock's engineering skills for coding agents.
