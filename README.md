# π-extensions

[![CI](https://github.com/vegardx/pi-extensions/actions/workflows/ci.yml/badge.svg)](https://github.com/vegardx/pi-extensions/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

My opinionated setup for [pi](https://github.com/badlogic/pi-mono) — a
collection of extensions I use daily for coding sessions.

## Extensions

| Package | Type | What it does |
|---|---|---|
| [`startup`](packages/startup) | `utility` | Reports loaded extensions and config on session start |
| [`review`](packages/review) | `command` | `/review` command — fans out specialist reviewers over a diff or codebase |
| [`commit`](packages/commit) | `command` | Generates and confirms git commit messages |
| [`derp`](packages/derp) | `command` | `/derp <text>` — fire-and-forget GitHub bug reporter that doesn't interrupt the session |
| [`wrap-up`](packages/wrap-up) | `command` | End-of-session handover doc + resource cost prompt |
| [`session-title`](packages/session-title) | `system` | Auto-names terminal sessions from context |
| [`prompt-suggestion`](packages/prompt-suggestion) | `system` | Ghost-text next-message prediction after each turn |
| [`gh`](packages/gh) | `skill` | GitHub skills (PR, issues, etc.) |
| [`context7`](packages/context7) | `skill` | Library docs lookup via Context7 API |
| [`exa`](packages/exa) | `skill` | Semantic web search via Exa API |
| [`caffeinate`](packages/caffeinate) | `utility` | macOS keep-awake helper for long-running sessions |

## Background models

Several extensions call an LLM on a side task — ghost text, auto-titling,
branch slug generation. None of them hard-code a provider or model. Instead,
they all follow the same pattern: declare a **tier** (`fast` / `normal` /
`heavy`) and let you decide what that means in `settings.json`.

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

`secondary` is used for cross-model checking — the auto-review module (`packages/review/auto-review`) runs each reviewer lane against both `primary` and `secondary` and only surfaces findings both agree on. The `modes` extension invokes this after each implement loop.

The shared implementation lives in [`packages/_shared`](packages/_shared) —
a model resolver, settings helpers, and a macOS caffeinate wrapper reused
across the extensions that need them.

→ [Full background model docs](docs/configuring-models.md) — tiers,
resolution order, cross-model checking, provider and gateway notes.

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

- [Configuring background models](docs/configuring-models.md)
- [pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)

## Inspired by

- [mattpocock/skills](https://github.com/mattpocock/skills) (MIT) — `diagnose` and `improve` skills adapted from Matt Pocock's engineering skills for coding agents
