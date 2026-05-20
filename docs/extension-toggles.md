# Extension toggles

Every extension in this repo is **off by default**. You enable the ones you want, and the rest stay dark. A fresh install does nothing until you opt in, which keeps half-finished experiments out of the way and makes every loaded extension a deliberate choice.

**One exception**: `startup` defaults to **on**. It owns the `/extensions` picker and the session-start summary toast — if it were off too, a fresh install would have no way to discover or re-enable anything without hand-editing `settings.json`. You can still set `extensionConfig.startup.enabled = false` to silence it; the default just changes what "unset" means for that one package.

## The single rule

```jsonc
{
  "extensionConfig": {
    "modes":  { "enabled": true },
    "review": { "enabled": true },
    "commit": { "enabled": true }
  }
}
```

Anything not listed (or listed with `"enabled": false`) won't load — except `startup`, which loads regardless unless you explicitly set it to `false`. The wrapper records the reason on each declaration (`disabled-by-config`, `disabled-by-env`, `disabled-by-missing-deps`) so `/extensions` can show you what's installed but dormant.

## Three ways to flip an extension

| Scope | File | When to use |
|---|---|---|
| **Project** | `<repo>/.pi/settings.json` | Per-repo opt-ins — e.g. enable `derp` only in repos where you actually crash. |
| **Global** | `~/.pi/agent/settings.json` | Your daily driver set — the extensions you always want, everywhere. |
| **Session / bisect** | `PI_EXT_<NAME>=on\|off pi …` | One-shot debug runs. Bypasses both files. |

The env-var name is the package name uppercased with `-` → `_`: `prompt-suggestion` → `PI_EXT_PROMPT_SUGGESTION`. Accepted values: `on/off`, `true/false`, `1/0`, `yes/no` (anything else falls through to settings).

**Precedence: env > project > global > default.** The default is `false` for every extension except `startup` (where it's `true`). Project beats global so a repo can override your usual set.

## The `/extensions` picker

Run `/extensions` in an interactive session. Two scope tabs (`Project` / `Global`), one row per declared extension, three values per scope (`● on`, `○ off`, `—` unset). Keys:

- `←/→` or `p/g` — switch scope
- `↑↓` — move cursor
- `space`/`enter` — cycle the value at the active scope (`unset → on → off → unset`)
- `r` — reset (clear the key at the active scope)
- `q`/`Esc` — close

Writes happen immediately on each toggle. The picker shows `dependsOn` / `integratesWith` and the resolved effective state (which scope won and why) for the selected extension.

The headless fallback (no UI — piped or CI) prints the static text report instead.

## First-time setup

Drop this in `~/.pi/agent/settings.json` to enable the extensions I run daily:

```jsonc
{
  "extensionConfig": {
    "caffeinate":         { "enabled": true },
    "commit":             { "enabled": true },
    "editor":             { "enabled": true },
    "modes":              { "enabled": true },
    "prompt-suggestion":  { "enabled": true },
    "review":             { "enabled": true },
    "wrap-up":            { "enabled": true }
  }
}
```

`startup` isn't in the list because it's already on by default (see the exception above). Add `derp`, `idea`, `triage`, `exa`, or `webfetch` as you want them — they're all optional and degrade cleanly when disabled.

## Two semantic levels

The wrapper toggle says *whether the extension loads at all*. Inside an enabled extension, individual features can have their own knobs:

| Knob | Meaning |
|---|---|
| `extensionConfig.modes.enabled` | Wrapper-level — load `modes` or don't. |
| `extensionConfig.modes.scrutinize.enable` | Behaviour — within loaded `modes`, run scrutiny passes or skip them. |

Behaviour knobs are read with `getExtensionConfigBoolean(settings, EXT_ID, "<feature>.enable", <default>)` inside an already-enabled factory. They sit under the same `extensionConfig.<name>.*` namespace; no special prefix needed.

If a behaviour knob defaults to `true`, document the default in the extension's README. If it defaults to `false` (opt-in feature within an opt-in extension), document why.

## Cross-extension calls

Static `import` statements from one `pi-ext-*` package to another's runtime code are **forbidden** — they bypass the wrapper and run the sibling's module-level code regardless of whether the user enabled it.

```ts
// ✗ forbidden — runs review's module body unconditionally
import { runFindingsTriage } from "pi-ext-review/triage";

// ✓ allowed — types vanish at runtime
import type { Finding } from "pi-ext-review/findings";

// ✓ allowed — gated on the user's actual config
if (pi.getCommands().some((c) => c.name === "review")) {
  const { runFindingsTriage } = await import("pi-ext-review/triage");
  await runFindingsTriage(/* ... */);
}
```

`scripts/check-cross-extension-imports.mjs` (run as part of `npm run check`) enforces this. Type-only imports stay allowed because they vanish at runtime and don't bring the sibling's code along.

## Declaring dependencies

Extensions can declare two kinds of dependencies in their `defineExtension({ ... })` options:

- **`dependsOn: ["foo"]`** — strict. If `foo` is missing or disabled, the dependent extension refuses to load and emits an error notify. Reserve this for genuine hard requirements.
- **`integratesWith: ["foo"]`** — soft. If `foo` is unavailable, this extension still loads; an info notify fires once at session start naming the missing integration.

Today nothing in this repo declares `dependsOn`. The four real edges (`modes ↔ commit/review`, `commit ↔ review`, `derp → modes`) are all `integratesWith` — they degrade silently when the dep is absent.

## Implementation pointers

- Wrapper: [`packages/_shared/define-extension.ts`](../packages/_shared/define-extension.ts)
- Settings reader/writer: [`packages/_shared/extension-settings.ts`](../packages/_shared/extension-settings.ts), [`packages/_shared/settings-writer.ts`](../packages/_shared/settings-writer.ts)
- Picker: [`packages/startup/extensions-dialog/`](../packages/startup/extensions-dialog/)
- Lint: [`scripts/check-cross-extension-imports.mjs`](../scripts/check-cross-extension-imports.mjs)
