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
