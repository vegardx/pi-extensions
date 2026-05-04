# CLAUDE.md — pi-ext-dev

Monorepo for pi.dev extensions. npm workspaces, `packages/*`, one extension per package.

## Conventions

- **Formatting**: Biome defaults (tabs, width 2, double quotes, 80-col line length). Do not override `indentStyle` / `indentWidth` — the tab default is intentional (accessibility) and the repo has opted into it.
- **Linting**: Biome recommended, `noExplicitAny` off (extension event payloads are loose).
- **TypeScript**: strict, ES2022, Node16 resolution, no emit (pi loads .ts at runtime via jiti).
- **Tests**: vitest with `globals: true` — no need to import `describe`/`it`/`expect`.
- **pi host deps**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@sinclair/typebox` are root devDeps for type resolution. Each package declares them as `peerDependencies: "*"`. Never add them as `dependencies` — pi provides them host-side.

## Adding an extension

Prefer `make new-ext NAME=foo` — it scaffolds `packages/foo/` with the right `package.json` (per-package `pi` manifest + peerDeps) and a minimal `index.ts`.

## Verification

```bash
make check      # lint + typecheck + test
pi -e ./packages/<name>
```

## What lives where

- Extension lifecycle, events, tool/command/shortcut/flag APIs → see `README.md` and the upstream [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).
- Per-package docs in `packages/<name>/README.md`.
