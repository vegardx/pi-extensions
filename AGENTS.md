# AGENTS.md — pi-ext-dev

Monorepo for pi.dev extensions. npm workspaces, `packages/*`, one extension per package.

## Conventions

- **Formatting**: Biome defaults (tabs, width 2, double quotes, 80-col line length). Do not override `indentStyle` / `indentWidth` — the tab default is intentional (accessibility) and the repo has opted into it.
- **Linting**: Biome recommended, `noExplicitAny` off (extension event payloads are loose).
- **TypeScript**: strict, ES2022, Node16 resolution, no emit (pi loads .ts at runtime via jiti).
- **Tests**: vitest with `globals: true` — no need to import `describe`/`it`/`expect`.
- **pi host deps**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@sinclair/typebox` are root devDeps for type resolution. Each package declares them as `peerDependencies: "*"`. Never add them as `dependencies` — pi provides them host-side.

## Adding an extension

Create `packages/<name>/` with a `package.json` (per-package `pi` manifest + peerDeps) and an `index.ts` that wraps its factory in `defineExtension({ name, path, ... }, (pi) => { ... })`. See `packages/caffeinate/` for the minimal template.

The wrapper handles the default-off toggle (`extensionConfig.<name>.enabled`), env override (`PI_EXT_<NAME>=on|off`), and dependency declarations. **Never call `pi.registerCommand` / `registerTool` outside the factory passed to `defineExtension`** — that bypasses the toggle. The env-disable contract test (`packages/_shared/__tests__/env-disable-contract.test.ts`) catches this for every retrofitted package.

Cross-extension code calls must be **dynamic + probed** (`await import("pi-ext-<name>/...")` after `pi.getCommands()` confirms the sibling is loaded). Static value imports between sibling `pi-ext-*` packages are blocked by `scripts/check-cross-extension-imports.mjs`; type-only imports are fine. Full rationale: [`docs/extension-toggles.md`](docs/extension-toggles.md).

## Verification

```bash
npm run check   # lint + typecheck + test
pi -e ./packages/<name>
```

## What lives where

- Extension lifecycle, events, tool/command/shortcut/flag APIs → see `README.md` and the upstream [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).
- Per-package docs in `packages/<name>/README.md`.
