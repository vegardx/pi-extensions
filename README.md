# pi-ext-dev

Monorepo for developing [pi.dev](https://pi.dev) extensions.

## What this is

[pi.dev](https://pi.dev) (`@mariozechner/pi-coding-agent`) is a minimal terminal coding agent. Extensions are TypeScript modules that extend pi's behavior — they can register tools callable by the LLM, commands, CLI flags, and hook into session lifecycle events. Extensions are loaded at runtime via [jiti](https://github.com/unjs/jiti), so **no build step** is needed.

This repo uses npm workspaces: one package per extension under `packages/`, shared tooling at the root.

## Prerequisites

- Node.js ≥ 20
- [pi](https://pi.dev) installed globally (`npm install -g @mariozechner/pi-coding-agent`)

## Quickstart

```bash
npm install
make check                        # lint + typecheck + test
pi -e ./packages/example          # smoke-test the example extension
```

Inside pi, try:

- `/hello world` — runs the example `/hello` command
- Ask the model: "use the greet tool to greet me" — triggers the example tool

## Adding a new extension

```bash
make new-ext NAME=my-ext
npm install                       # register the workspace
pi -e ./packages/my-ext           # test
```

Edit `packages/my-ext/index.ts` — the default export receives an `ExtensionAPI` instance.

## Installing extensions from this repo

Once this repo is pushed to GitHub, anyone can install every extension with:

```bash
pi install git:github.com/vegardx/pi-ext-dev
```

The root `package.json` has a `pi` manifest with `extensions: ["packages/*/index.ts"]`, so all extensions are picked up in one install.

To install a single extension only, clone the repo and use a local path install:

```bash
git clone https://github.com/vegardx/pi-ext-dev
pi install ./pi-ext-dev/packages/my-ext
```

## Layout

```
pi-ext-dev/
├── package.json              workspaces, root pi manifest, shared devDeps
├── biome.json                linter + formatter (2 spaces, Biome defaults)
├── tsconfig.base.json        shared strict TS config
├── tsconfig.json             repo-wide typecheck
├── vitest.config.ts
├── Makefile                  install / test / lint / check / new-ext
└── packages/
    └── example/              reference extension — copy as a starting point
        ├── package.json      per-package pi manifest + peerDeps
        ├── index.ts          default-export factory receiving ExtensionAPI
        └── README.md
```

## Extension API reference

See the [official pi extension docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) for the full `ExtensionAPI` surface: events, tools, commands, shortcuts, flags, custom UI, session persistence.

## Tooling

- **Biome** for lint + format (Biome defaults: tabs with width 2).
- **TypeScript** strict mode, no emit — pi loads `.ts` at runtime via jiti.
- **Vitest** with `globals: true`.
- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, and `@sinclair/typebox` are installed as root devDependencies purely for type resolution. Each package declares them as `peerDependencies: "*"` so published extensions don't bundle them — pi provides them host-side at runtime.

## Code review

Two options, pick whichever fits the PR:

- **Local — `/review`**. The `packages/review/` extension fans out seven specialist reviewers (architect, code-reviewer, scope-analyst, security-analyst, code-simplifier, doc-reviewer, dependency-checker) over a diff or the whole codebase. Runs against a real model, lands findings in-terminal. Depth > breadth. See `packages/review/README.md`.
- **GitHub Copilot code review**. Faster, shallower, runs on every PR you assign it to. Reads repo-level instructions from [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — keep that file in sync with `CLAUDE.md` and `packages/review/prompts/*.md` when conventions change. On each PR, sidebar → Reviewers → Copilot. Or set up a branch ruleset on `main` that requires Copilot as a reviewer to auto-request it. Requires a Copilot plan that includes code review (Business / Enterprise / Pro+).

The two are complementary: Copilot catches the obvious stuff cheap, `/review` goes deep when you want a thorough pass before merge.

## Background models

Several extensions in this monorepo call an LLM on a side task —
`prompt-suggestion` predicts the next message, `session-title` names
the session, `nitpick` runs a subagent reviewer. None of them
hard-code a provider/model id; each declares a **tier** and the user
decides what that tier means.

Configure once in `settings.json`:

```jsonc
// ~/.pi/agent/settings.json or .pi/settings.json (project)
{
  "backgroundModels": {
    "fast":   "anthropic/claude-haiku-4-5-20251001",
    "normal": "anthropic/claude-sonnet-4-5-20250929",
    "heavy":  "anthropic/claude-opus-4-5-20250929"
  },
  // Optional per-extension overrides win over the tier above.
  "extensionConfig": {
    "nitpick": { "model": "openrouter/anthropic/claude-sonnet-4.5" }
  }
}
```

Current tier assignments:

| Extension | Tier | Why |
|---|---|---|
| `prompt-suggestion` | `fast` | Ghost text on every turn; 40-token output. |
| `session-title` (auto-title) | `fast` | Once per session; 2–5 word output. |
| `nitpick` | `normal` | Continuous code review; needs real reasoning. |

Resolution order (high → low priority), same in every extension:

1. Extension-specific explicit override (CLI flag / in-session command).
2. `settings.json → extensionConfig.<name>.model`.
3. `settings.json → backgroundModels.<tier>`.
4. `ctx.model` (the active session model).
5. Nothing resolves with working auth → the feature disables itself
   for the session with a single `notify()`.

The shared implementation lives in `shared/model-resolver.ts`.
