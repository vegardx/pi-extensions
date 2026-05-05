# pi-ext-startup

First-party "what did pi just load?" extension for this monorepo.

## What it does

On `session_start` (and on `/reload`), the extension surveys the
running pi instance and prints a short summary toast:

```
pi-ext-startup: 7 extensions · 3 overrides · /extensions for details
```

Run `/extensions` to dump the full breakdown:

- **Active session model** — `provider/id` of the model pi is
  currently routing turns through (`ctx.model`).
- **Background-model tiers** — `backgroundModels.primary.{fast,normal,heavy}`
  and `backgroundModels.secondary.{fast,normal,heavy}` from merged
  global + project `settings.json`.
- **Declared extensions** — every extension that called
  `declareExtension(...)` from its factory. For each:
  - source path, registered commands (e.g. `/develop`, `/review`),
    and registered tool names;
  - declared config keys under `extensionConfig.<name>.<key>` with
    each key's *effective* value, the *source* layer it came from
    (`project` / `global` / `default`), the literal default or
    fallback chain, and a short doc line;
  - which `backgroundModels` tier+set the extension consumes
    (e.g. `verify` → `secondary.normal`) and the resolved value with
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

- The `session_start` toast shows the count summary.
- `/extensions` prints the full report as a sequence of info
  notifications.

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
  registry, command/tool grouping, and layered settings into a
  structured summary), `renderLines(summary)` (pure, summary →
  string[]), and the `session_start` + `/extensions` wiring.
- `__tests__/grouping.test.ts` — covers the pure helpers:
  `groupBySource` (command/tool dedup + builtin/sdk filtering),
  `resolveBackgroundTier` (set/tier lookup with secondary→primary
  fallback), `buildDeclaredView` (joining declarations against
  loaded paths and resolving config + tier), `countOverrides`,
  `renderHeadline`, `renderLines`, and a smoke test that the factory
  self-declares as `"startup"`.
