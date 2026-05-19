# π-extensions

[![CI](https://github.com/vegardx/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/vegardx/pi-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> This is my pi-extensions. There are many like it, but this one is mine.

My personal [pi](https://github.com/badlogic/pi-mono) setup. Highly opinionated. Constantly changing. Often half-broken on `main`.

Building it is the most fun I've had with software in years. Using it is mostly fine. Sometimes it just explodes in your face mid-turn — that's the deal you sign up for when your IDE is also your lab notebook.

If something looks weird, it probably is. If something works really well, that's the part you should steal.

## What I care about

The agent runs on someone else's GPU; my job is to make every token count. You can't have everything, but smart caching, a lean working context, and small phases that parallelise get you most of the way:

- **Cache hits over context length.** System prompts, the plan-doc seed, and carry-forward summaries are byte-stable across turns and phases. The KV-cache reuses the whole stable prefix; you pay for the new tail, not the rebuilt head.
- **Working slice small enough to stay sharp.** Mid-phase compaction fires *before* the live message tail gets long. Frontier models degrade past a certain point — the goal is to live in the sweet spot, not 80% of `contextWindow`.
- **Short context, faster turns.** Less context = faster tokens-per-second from most providers. Less wall time, less waiting around.
- **Small phases, run in parallel.** A plan broken into small independent phases ships faster end-to-end than one giant chain. The plan model is what unlocks parallelism — fanout workers per chain, or peer sessions in separate worktrees.
- **Cheap models for cheap work.** Tiered backgrounds (`fast` / `normal` / `heavy`) — ghost text isn't running on the frontier and the seven review lenses aren't running on Haiku.


## What's in the box

### Phase/task plans + a four-mode permission cycle

The centerpiece. `/plan` builds a phase/task tree in read-only plan mode; `/implement` flips to `auto`, creates a worktree-bound feature branch, and works the active phase end-to-end; `/ship` opens the PR and walks to the next phase. Shift+Tab cycles `hack → plan → ask → auto`, adding structure step by step.

Each phase runs in its own pi session, **seeded** deterministically from the plan doc — no LLM call. Three-tier compaction (mid-phase, per-phase summary, plan-doc seed) keeps context lean across multi-phase runs.

→ [Mode-transitions diagram](packages/modes/README.md#mode-transitions) · [Plan model](packages/modes/README.md#plan-model)

### `/review` — seven specialist lenses

Seven reviewers run in parallel against the active model: architect, code-reviewer, scope-analyst, security-analyst, code-simplifier, doc-reviewer, dependency-checker. Each has its own focus and prompt; you walk findings interactively.

Modes' auto-review pipeline runs the same lenses but gives the orchestrator a `consult_secondary_model` tool — uncertain findings get a second opinion before they reach you.

→ [`packages/review`](packages/review)

### A small library of project-local skills

Reusable agent workflows invoked as `/skill:<name>`: `diagnose` (disciplined bug loop), `improve` (architectural friction), `document` (CONTEXT.md / DESIGN.md), `propose-skill` (recurring pattern → new skill), `gh` (multi-host GitHub ops), `triage` (inbox sweeps), plus the lookup skills `context7` and `exa-search`. Skills compose — `/commit` calls `gh`, anything broken hands off to `diagnose`.

→ [Skills table below](#skills)

### Tiered background models, provider-agnostic

Side tasks (ghost text, auto-titling, branch slugs, commit messages, the seven review lenses, the explore sub-agent) declare a tier — `fast` / `normal` / `heavy` — and you decide what those mean in `settings.json`. Cheap models for the cheap stuff, frontier for the heavy lifting. Swap providers without touching extension code.

→ [Configuring background models](docs/configuring-models.md)

### Non-blocking sub-agents in plan mode

`/plan` delegates codebase questions to a persistent **explore** sub-agent and one-shot web lookups to a stateless **research** sub-agent. Both non-blocking — fire several `explore_ask` calls, keep planning, drain answers when ready. Slow turns don't stall the main agent; long-running explorations don't blow context.

→ [Async explore](packages/modes/README.md#async-explore-plan-mode)

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

## Extensions

| Package | Surface | What it does |
| --- | --- | --- |
| [`modes`](packages/modes) | `/plan` `/implement` `/park` `/ship` `/sync` `/worktree` `/modes-status` | Centrepiece. Phase/task plans, mode cycle, worktree-bound execution, three-tier compaction, async explore/research. Replaces `/develop`. |
| [`commit`](packages/commit) | `/commit` | Drives the `commit` skill end-to-end. |
| [`review`](packages/review) | `/review` | Drives the `review` skill — seven specialist reviewers fanned out in parallel. |
| [`wrap-up`](packages/wrap-up) | `/pause` `/continue` | Session handover doc, branch/repo-aware resume. |
| [`derp`](packages/derp) | `/derp <text>` | Fire-and-forget GitHub bug reporter that doesn't interrupt the session. |
| [`startup`](packages/startup) | `/extensions` | Reports loaded extensions, commands, tools, configs, and active models on session start. |
| [`prompt-suggestion`](packages/prompt-suggestion) | (none — addendum-driven ghost text) | Inline ghost-text next-message suggestions parsed from a sentinel block emitted by the main agent. Requires pasting `INLINE_SUGGESTION_SYSTEM_ADDENDUM` into your `AGENTS.md`. |
| [`caffeinate`](packages/caffeinate) | `/caffeinate` | macOS keep-awake helper, refcounted, footer indicator. |
| [`webfetch`](packages/webfetch) | `webfetch` tool | Fetch a URL and extract main content as clean Markdown (Defuddle + optional LLM summary). |
| [`gh`](packages/gh) [`triage`](packages/triage) [`context7`](packages/context7) [`exa`](packages/exa) | skills | See the Skills table above. |
| [`questions`](packages/questions) | shared | Tabbed multi-question prompt — options, optional text input, optional per-option preview, submit. Mirrors Claude Code's `AskUserQuestion` shape. Shared by `review`, `wrap-up`, and `modes`. Not loaded standalone. |
| [`_shared`](packages/_shared) | internal | Model resolver, settings helpers, macOS caffeinate wrapper. Used by other packages, not loaded directly. |

## Get it running

```bash
npm install
pi -e ./packages/startup                          # smoke-test one extension
pi install git:github.com/vegardx/pi-extensions   # install everything
```

## Docs

- [`packages/modes/README.md`](packages/modes/README.md) — modes deep-dive: state diagram, plan model, session lifecycle, compaction, multi-driver execution.
- [`docs/configuring-models.md`](docs/configuring-models.md) — background-model tiers, resolution order, cross-model checking, providers, gateways.
- [pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — upstream reference for writing your own.

## Inspired by

- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) — `diagnose` and `improve` skills adapted from Matt Pocock's engineering skills for coding agents.
