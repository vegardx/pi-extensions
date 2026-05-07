# pi-ext-startup

First-party "what did pi just load?" extension for this monorepo.

## What it does

On `session_start` (and on `/reload`), the extension surveys the
running pi instance and prints a one-shot info notification with
the full breakdown — a one-line headline followed by the same
report `/extensions` produces on demand:

```
pi-ext-startup: 7 extensions · /extensions for details

Active model: anthropic/claude-…
Background models:
  primary:   fast=…, normal=…, heavy=…
  secondary: (not configured)

Context files (3 · 1.4k tokens):
  global   ~/.pi/agent/AGENTS.md  (320 tok · 45 lines)
  parent   ~/src/github.com/vegardx/AGENTS.md  (180 tok · 22 lines)
  project  ~/src/github.com/vegardx/pi-extensions/AGENTS.md  (940 tok · 120 lines)

extension-name:
  key: value
  …
```

The report is emitted as a single multi-line `ctx.ui.notify(…, "info")`
call on purpose: pi's interactive `info` notifications replace the
previous one in place, so a per-line loop would collapse to whichever
line happened to be last. One multi-line notify renders as a single
Text block.

Run `/extensions` to print the same breakdown again on demand:

- **Active session model** — `provider/id` of the model pi is
  currently routing turns through (`ctx.model`).
- **Background-model tiers** — `backgroundModels.primary.{fast,normal,heavy}`
  and `backgroundModels.secondary.{fast,normal,heavy}` from merged
  global + project `settings.json`.
- **Context files** — every `AGENTS.md` or `CLAUDE.md` that pi would
  load for the current session, in the order they are assembled into
  the context (global first, project last). Each entry shows:
  - scope label: `global` (`~/.pi/agent/`), `parent` (ancestor
    directories), or `project` (the cwd file);
  - home-relative display path;
  - rough token estimate (`ceil(charCount / 4)`) and line count.
  Shows `(none found)` when no context files exist on disk.
- **Declared extensions** — every extension that called
  `declareExtension(...)` from its factory. For each:
  - source path, registered commands (e.g. `/develop`, `/review`),
    and registered tool names;
  - declared config keys under `extensionConfig.<name>.<key>` with
    each key's *effective* value, the *source* layer it came from
    (`project` / `global` / `default`), the literal default or
    fallback chain, and a short doc line;
  - which `backgroundModels` tier+set the extension consumes
    (e.g. `verify` → `primary.fast`) and the resolved value with
    its source.
- **Unrecognized extensions** — anything in pi's command/tool registry
  whose `sourceInfo.path` doesn't match any `declareExtension` entry
  (typically third-party extensions or skill-only packages that
  registered tools indirectly).

The headline's "M overrides" count is the number of declared keys
across all extensions whose effective value came from a settings
layer rather than the schema default. Background-tier values count as
overrides for the consuming extension only via the `background model`
line in the per-extension dump (they don't add to "M overrides" — that
counter focuses on per-extension `extensionConfig` knobs).

## Test

```bash
pi -e ./packages/startup
```

Inside pi:

- The `session_start` notification shows the full breakdown
  (headline + per-extension report) as a single multi-line block.
- `/extensions` prints the same breakdown again on demand.

## How it discovers extensions

Each extension in this monorepo calls `declareExtension({ ... })`
from its factory's `default export` function. The shared module
`@vegardx/pi-extensions-shared/extension-metadata.js` keeps an
in-process `Map` of declarations — pi loads each `index.ts` once,
the `_shared` module is cached by Node, and by the time
`session_start` fires every factory has registered itself. `startup`
reads that registry as the source of truth and joins it against
`pi.getCommands()` / `pi.getAllTools()` (for commands/tools) and
`readRelevantSettingsLayered(ctx.cwd)` (for effective config values).

**Caveat:** skill-only packages have no factory and so cannot
self-declare. In this repo `pi-ext-gh` is skill-only — it ships a
`skills/` directory and no `index.ts`, so it never appears under
"declared extensions". Skills themselves are filtered out of the
command list (they aren't extensions), so they don't bleed into
"unrecognized" either; they're just invisible to `/extensions`.

## Adding a new extension to the report

Inside the new extension's `index.ts`:

```ts
import { fileURLToPath } from "node:url";
import { declareExtension } from "@vegardx/pi-extensions-shared/extension-metadata.js";

export default function (pi: ExtensionAPI) {
  declareExtension({
    name: "my-extension",
    path: fileURLToPath(import.meta.url),
    doc: "One-line description.",
    configSchema: [
      {
        key: "model",
        type: "string",
        fallbackChain:
          "extensionConfig.my-extension.model → backgroundModels.primary.fast → ctx.model",
        doc: "provider/id override for whatever model this thing uses.",
      },
      {
        key: "maxItems",
        type: "number",
        default: 10,
        doc: "Cap on something or other.",
      },
    ],
    backgroundModelUse: { tier: "fast", set: "primary" }, // optional
  });

  // … pi.registerCommand / pi.registerFlag / etc.
}
```

`name` is the short, stable identity used both as the key under
`extensionConfig.<name>` in `settings.json` and as the join key for
`/extensions`. `path` lines up with the `sourceInfo.path` pi attaches
to commands and tools.

Re-declaring the same `name` overwrites the previous entry (last
write wins), which is convenient for tests but should not happen
otherwise — each extension declares itself exactly once per process.

## Layout

- `index.ts` — factory: `summarize(pi, ctx)` (joins the metadata
  registry, command/tool grouping, layered settings, and discovered
  context files into a structured summary), `renderHeadline(summary)` /
  `renderLines(summary)` (pure, summary → string / string[]), and the
  `session_start` + `/extensions` wiring (one multi-line `notify` per
  emit).
- `__tests__/grouping.test.ts` — covers the pure helpers:
  `groupBySource`, `resolveBackgroundTier`, `buildDeclaredView`,
  `countOverrides`, `renderHeadline`, `renderLines`, and a smoke test
  that the factory self-declares as `"startup"`.
- `__tests__/context-files.test.ts` — covers `discoverContextFiles`
  (global file, AGENTS.md vs CLAUDE.md preference, scope assignment,
  root→cwd ordering, token and line counts, at-most-one-per-dir,
  `~` display path) and the `renderLines` context-files section
  (none-found fallback, count/token header, `k` suffix, per-file
  lines, ordering after background models).
