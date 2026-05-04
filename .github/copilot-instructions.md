# Copilot instructions — pi-ext-dev

Monorepo of [pi.dev](https://pi.dev) extensions. npm workspaces, one
extension per package under `packages/*`. Extensions are TypeScript
modules loaded at runtime via jiti — **there is no build step**.

Primary source of conventions: `CLAUDE.md` at the repo root. The seven
review-lane prompts in `packages/review/prompts/*.md` describe in
detail what reviewers flag and — just as importantly — what they do
not flag. When in doubt, read those.

## Conventions

- **Formatting**: Biome defaults — tabs (width 2), 80-col line length,
  double quotes. `biome.json` is the authority. Don't override
  `indentStyle` / `indentWidth`; the tab default is intentional
  (accessibility).
- **Linting**: Biome recommended with `noExplicitAny` off — `any` in
  extension event payloads is deliberate. Do not flag `any`.
- **TypeScript**: strict, ES2022 target, Node16 module resolution, no
  emit. Imports of local `.ts` files use `.js` extensions (NodeNext
  convention).
- **Tests**: vitest with `globals: true`. Do not import `describe`,
  `it`, or `expect` — they're globals. Tests live in
  `packages/<name>/__tests__/*.test.ts`.
- **pi host deps** (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`,
  `@mariozechner/pi-tui`, `@sinclair/typebox`): root devDependencies
  for type resolution, declared per-package as
  `peerDependencies: "*"`. **Never** add them as `dependencies` — pi
  provides them host-side at runtime.
- **Adding an extension**: `make new-ext NAME=foo` scaffolds the right
  `package.json` (per-package `pi` manifest + peerDeps) and a minimal
  `index.ts`.
- **Verification before PR**: `make check` (lint + typecheck + test).
- **Commits**: conventional-commit style, scope = extension name, e.g.
  `feat(nitpick): add reviewer subagent`. Subject ≤ 72 chars.

## Per-package layout

```
packages/<name>/
├── __tests__/          vitest tests (no vitest imports; globals: true)
├── index.ts            default export receiving ExtensionAPI
├── package.json        per-package pi manifest + peerDeps
└── README.md
```

Helpers live alongside `index.ts` as sibling `.ts` files. Shared
tooling (biome, tsconfig, vitest) is at the repo root.

## What to flag in PR review

Focused on what this repo actually cares about:

- **Bugs** — off-by-one, null / undefined dereferences, race
  conditions, wrong early returns, broken error handling, resource
  leaks. Use `grep` to check reuse: flag reimplementations of
  something that already exists.
- **Scope discipline** — feature creep, unrelated refactors or
  formatting sweeps bundled in, over-engineering beyond the stated
  task. Small task with a large diff is a smell.
- **Security** — injection (command, path traversal, SQL, XSS), auth
  flaws, secret exposure (hardcoded creds, secrets in logs or error
  messages), unsafe `eval` / deserialization, crypto misuse.
  Dependency CVEs and lock-file hygiene are a separate lane.
- **Structural concerns** — new coupling across module boundaries the
  codebase otherwise respects, circular dependencies, business logic
  landing in the wrong layer, public-API shape changes without a
  migration path.
- **Simplification** — dead branches, one-shot helpers clearer inlined
  (verify callers via `grep` first), redundant abstractions, unused
  imports / variables / parameters, defensive checks the type system
  already covers.
- **Docs drift** — public APIs / CLI flags / commands changed without
  README or JSDoc updates, inline comments that now contradict the
  code, example code in README that no longer runs, `TODO` / `FIXME`
  the PR actually resolved but didn't remove.
- **Dependencies** — deprecated or unmaintained packages, known CVEs
  in pinned versions, lock-file inconsistencies, supply-chain
  lookalikes. Don't flag "you could use a newer version" without a
  concrete reason.

## What NOT to flag

- **Formatting / style** — Biome owns that. Don't flag tabs vs spaces,
  brace placement, quote style, or line length unless Biome itself
  would complain.
- **`any` usage** — intentionally allowed repo-wide. Extension event
  payloads are loose by design.
- **Missing `describe` / `it` / `expect` imports in tests** — globals.
- **Speculative suggestions** like "consider adding X" without a
  concrete reason. Simplification means removing, not adding.
- **Adding comments for intent** unless a specific comment would
  resolve concrete confusion introduced by the change.

## Severity

- **CRITICAL** — exploitable security issue, data-corrupting bug, or
  layering violation that blocks future work.
- **IMPORTANT** — logic error on an edge case, missing tests for new
  branches, clear `CLAUDE.md` violation, feature creep that should be
  split out.
- **NOTE** — minor inconsistency, simplification opportunity, or
  defence-in-depth observation.

## When you need more context

- `CLAUDE.md` — repo conventions in full.
- `packages/review/prompts/*.md` — the seven reviewer lanes with
  detailed "flag / don't flag" lists the local `/review` extension
  uses. If a reviewer prompt exists for your concern, follow its
  rubric.
- `packages/<name>/README.md` — per-extension behaviour and knobs.
