# pi-ext-subagent

Host of the generic **`delegate`** tool. Other extensions contribute
named specialist targets; this extension owns the single tool surface,
the concurrency gate, and answer capping. It registers no targets of
its own and is inert until a provider registers one — which is why it
is the only extension besides `startup` that defaults to **enabled**.

## How it fits together

```
agent ── delegate({to, message, params?, async?, timeoutMs?})
            │
            ▼
   delegate tool (this package)
            │  looks `to` up in the shared registry
            ▼
   _shared/delegate-registry  ◀── registerDelegateTarget(...)
            │                        ▲           ▲
            ▼                        │           │
   target.execute(...)            modes      review
                                (researcher,  (reviewer)
                                 explorer)
```

- **Providers** call `registerDelegateTarget({name, description,
  paramsSchema?, isAvailable?, execute})` from
  `@vegardx/pi-extensions-shared/delegate-registry.js` at factory time.
- **TS-side consumers** (e.g. commit's review offer) probe
  `getDelegateTarget(name)` instead of probing commands or
  dynamic-importing sibling packages.
- **The agent** calls one tool for every specialist. Unknown or
  currently-unavailable targets return an error listing what *is*
  available.

## Tool parameters

| Param | Meaning |
|---|---|
| `to` | Target name (`"researcher"`, `"explorer"`, `"reviewer"`, …). |
| `message` | The question/task, natural language. |
| `params` | Optional target-specific structured parameters. |
| `async` | `true` → return a job id immediately; the capped answer is delivered as a follow-up message when the job finishes. |
| `timeoutMs` | Hard cap for the delegated work; targets derive stage budgets from it. |

Blocking calls and async jobs share one FIFO, abort-aware counting
semaphore, so a burst of parallel calls cannot fork-bomb subprocesses.

## Config

| Key (`extensionConfig.subagent.…`) | Default | Doc |
|---|---|---|
| `delegate.maxAnswerChars` | `6000` | Hard cap on a delegated answer before it crosses back into the caller's context. |
| `delegate.maxConcurrent` | `10` | Cap on concurrent delegate executions (blocking + async combined). |

## Subagent isolation

`PI_SUBAGENT=1` children disable every wrapped extension by default —
including this one — so delegated specialists can't recursively
delegate. `PI_EXT_SUBAGENT=off` disables the tool entirely.
