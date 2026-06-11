# pi-ext-caffeinate

macOS keep-awake helper for the unattended runs that other extensions
in this monorepo do — `modes` auto-verify + auto-review loops,
the review pipeline's lens fan-out, etc.

## What it does

Provides a **caller-driven, refcounted** keep-awake API. Other
extensions hold the lock while they work; this extension owns the
single `caffeinate(8)` subprocess, the footer indicator, and the
`/caffeinate` slash command.

```
┌─────────────────────────────────────────────────────────────┐
│ ...                                                         │
│                                              caffeinate: …  │ ← footer pill
└─────────────────────────────────────────────────────────────┘
```

- **`caffeinate: unsupported (mac only)`** — host isn't macOS;
  `acquireKeepAwake` is a hard no-op everywhere.
- **`caffeinate: disabled`** — opt-in flag isn't set in settings.json.
  No subprocess will spawn; `acquireKeepAwake` returns a no-op handle.
- **`caffeinate: inactive`** — opted in, no consumer is currently
  holding the lock.
- **`caffeinate: active (develop, review)`** — one or more consumers
  are holding; `caffeinate -i -m -w <pi-pid>` is running.

## Opt in

It's **off by default**. Two ways to flip it on:

1. **Slash command** — inside pi, run `/caffeinate on` (writes
   `extensionConfig.caffeinate.enabled = true` to project
   `.pi/settings.json`, creating the file if needed). `/caffeinate off`
   flips it back. Live holders are unaffected by either; only future
   `acquireKeepAwake` calls see the new value.
2. **Edit settings.json by hand** — add to `~/.pi/agent/settings.json`
   or `./.pi/settings.json`:

```jsonc
{
  "extensionConfig": {
    "caffeinate": {
      "enabled": true
    }
  }
}
```

The flag is read on every `acquireKeepAwake` call. While disabled the
helper never spawns `caffeinate` and the footer reads "disabled".

### Custom flags

Default argv is `["-i", "-m"]` (idle sleep + disk-idle), with
`-w <pi-pid>` auto-appended so the kernel reaps the child if pi
crashes. Override via:

```jsonc
{
  "extensionConfig": {
    "caffeinate": {
      "enabled": true,
      "flags": ["-i", "-d", "-m"]
    }
  }
}
```

See `man caffeinate` for the full list. Common picks:

- `-i` prevent idle sleep (recommended; default).
- `-m` prevent disk idle (recommended; default).
- `-d` keep the **display** awake — only set this if you actually
  want your screen on while pi runs unattended.
- `-s` prevent system sleep on AC only.
- `-u` "user is active"; usually combined with `-t <seconds>`.

Don't add `-w` yourself; the helper appends it automatically with
pi's PID. The flags array is read on each acquire, so changes take
effect on the next 0→1 transition.

## Test

```bash
pi -e ./packages/caffeinate
```

Inside pi:

- The footer should read `caffeinate: disabled` until you opt in.
- After `/caffeinate on` (or hand-editing settings.json + `/reload`),
  it should read `caffeinate: inactive`.
- `/caffeinate` (or `/caffeinate status`) prints a multi-line status
  report.
- `/caffeinate on` / `/caffeinate off` toggle the opt-in by writing
  to project `.pi/settings.json`.
- `/caffeinate test` acquires the lock for 10 seconds — watch the
  pill flip to `caffeinate: active (caffeinate-test)` and back.
- In another terminal, `pgrep -fl caffeinate` while the test hold is
  live should show `caffeinate -i -m -w <pid>` parented to the pi
  process.

## How other extensions consume it

```ts
import { acquireKeepAwake } from "@vegardx/pi-extensions-shared/caffeinate.js";

// inside your command/handler
const lock = acquireKeepAwake("my-ext", ctx);
try {
  await doLongRunningWork(...);
} finally {
  lock.release(); // idempotent; ok to call again
}
```

- `reason` is what shows up in the footer pill — keep it short and
  match your extension's name when possible.
- `acquireKeepAwake` is a no-op on non-darwin, and a no-op when the
  user hasn't opted in. Consumers don't need to special-case either
  path.
- `release()` is idempotent. If your code path branches, just call
  it in `finally` once.
- The first acquire spawns `caffeinate`; subsequent acquires bump a
  refcount and reuse the child. Last release kills it.

## Architecture

- **Shared module** — `packages/_shared/caffeinate.ts` (exported as
  `@vegardx/pi-extensions-shared/caffeinate.js`). Holds the refcount
  and the single `ChildProcess` reference. Pure logic + a small
  test seam (`__setSpawnerForTests`, `__setPlatformForTests`,
  `__resetForTests`).
- **This extension** — `packages/caffeinate/index.ts`. Self-declares
  the schema, subscribes to state changes via `subscribeKeepAwake`,
  paints the footer pill via `ctx.ui.setStatus`, and registers
  `/caffeinate` (with `status` / `on` / `off` / `test` subcommands).
  It deliberately does **not** auto-acquire on `before_agent_start` /
  `agent_end` — the design is caller-driven so each consumer can
  pick the exact window where the laptop should stay awake. The
  extension is purely the user-facing surface (toggle, footer,
  status); consumers (`modes`, `/review`) decide when to hold.

The subprocess lifetime is anchored two ways:
1. `caffeinate -w <pi-pid>` — kernel-side; if pi dies for any reason
   the OS reaps the child.
2. `process.on("exit", …)` — best-effort SIGTERM in the normal exit
   path. Belt-and-braces alongside (1).

`session_shutdown` does **not** force-release outstanding holders.
The session-replacement flows (`/new`, `/resume`, `/fork`) re-import
each extension into a fresh module space, but Node's module cache
keeps the shared module — and any live holder tokens — across the
boundary. That's by design: a long-running consumer that survives
session replacement (rare, but possible via `pi.sendUserMessage`
across boundaries) keeps the laptop awake until it actually finishes.

## Layout

- `index.ts` — factory: schema declaration, footer subscriber wiring,
  `/caffeinate` command, and pure renderers (`renderStatusLine`,
  `renderStatusReport`) that the test suite pins.
- `__tests__/render.test.ts` — covers every branch of the status-line
  formatter.

The refcount + spawn behavior is covered by
`packages/_shared/__tests__/caffeinate.test.ts`.
