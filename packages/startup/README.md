# pi-ext-startup

First-party "what did pi just load?" extension for this monorepo.

## What it does

On `session_start` (and on `/reload`), the extension surveys the
running pi instance and prints a short summary toast:

```
pi-ext-startup: 7 extensions · 3 model overrides · /loaded for details
```

Run `/loaded` to dump the full breakdown:

- **Loaded extensions** — every extension that registered a command or
  tool with pi, grouped by source path. For each, the commands it
  exposes (e.g. `/develop`, `/review`) and the tool names it
  registered (e.g. `greet`).
- **Active session model** — `provider/id` of the model pi is currently
  routing turns through (`ctx.model`).
- **Background-model tiers** — `backgroundModels.primary.{fast,normal,heavy}`
  and `backgroundModels.secondary.{fast,normal,heavy}` from merged
  global + project `settings.json` (only the keys this monorepo uses;
  see `packages/_shared/extension-settings.ts`).
- **Per-extension overrides** — `extensionConfig.<name>.model` entries.

## Test

```bash
pi -e ./packages/startup
```

Inside pi:

- The `session_start` toast shows the count summary.
- `/loaded` prints the full report as a sequence of info notifications.

## How it discovers extensions

Via `pi.getCommands()` and `pi.getAllTools()`, deduped by
`sourceInfo.path`. Builtin tools (`sourceInfo.source === "builtin"`)
and SDK-injected tools (`"sdk"`) are filtered out. Prompt-template and
skill commands are excluded (`source !== "extension"`).

**Caveat:** an extension that registers neither a command nor a tool
— e.g. one whose only side effect is a `setStatus` from `session_start`
— won't appear in the list. pi doesn't expose a registry of "all
loaded extensions" to other extensions; commands and tools are the
only public provenance signals. Every extension in this monorepo
registers at least one of those, so the limitation doesn't bite here,
but be aware of it if you copy this extension into another repo.

## Layout

- `index.ts` — factory: `summarize(pi, ctx)` (pure-ish, returns a
  structured summary), `renderLines(summary)` (pure, summary →
  string[]), and the `session_start` + `/loaded` wiring.
- `__tests__/grouping.test.ts` — covers the pure helpers: command/tool
  grouping by source path, builtin/sdk filtering, and the
  settings-summary rendering for empty / partial / fully-configured
  inputs.
