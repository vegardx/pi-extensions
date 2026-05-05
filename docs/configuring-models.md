# Configuring models

Several extensions in this monorepo call an LLM on a side task:

- `prompt-suggestion` predicts the next message after every turn.
- `session-title` names the session for your terminal tab / tmux window.
- `verify` fans out parallel read-only subagents to check whether each
  step of a plan is actually done.

None of them hard-code a provider/model id. Each one declares a **tier**
(`fast` / `normal` / `heavy`) and a **set** (`primary` / `secondary`),
and the user decides what each tier means for them, once, in
`settings.json`.

This document is the single place that covers:

- [The `settings.json` keys](#the-settingsjson-keys)
- [The resolution chain](#the-resolution-chain)
- [Per-extension tier and set assignments](#per-extension-tier-and-set-assignments)
- [Common configurations](#common-configurations)
- [Provider and gateway notes](#provider-and-gateway-notes)
- [Troubleshooting](#troubleshooting)

For the shared code that implements all of this, see
[`packages/_shared/model-resolver.ts`](../packages/_shared/model-resolver.ts).

## The `settings.json` keys

Two top-level keys this monorepo's extensions read from pi's
`settings.json` (either `~/.pi/agent/settings.json` global or
`.pi/settings.json` project-local — project overrides global):

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast":   "provider/id",
      "normal": "provider/id",
      "heavy":  "provider/id"
    },
    "secondary": {
      "fast":   "provider/id",
      "normal": "provider/id",
      "heavy":  "provider/id"
    }
  },
  "extensionConfig": {
    "<extension-name>": { "model": "provider/id" }
  }
}
```

- **`backgroundModels.<set>.<tier>`** — maps each (set, tier) pair to a
  `provider/id` string. Most extensions read from `primary`. Consumers
  that want a different model family for cross-checking (today: only
  `verify`, in PR C of this branch's plan) read from `secondary`.
- **`primary` / `secondary` are peers, not fallbacks.** A user
  configures one or both. When a `secondary` consumer asks for a tier
  that isn't set under `secondary`, the resolver falls back to
  `primary.<tier>` so the consumer still works without forcing the
  user to fully configure both sets.
- **`extensionConfig.<name>.model`** — per-extension override. Wins
  over the (set, tier) lookup. Use it when one extension should run on
  something different than your general tier choice (e.g. `verify`
  on a gateway, but the rest on direct Anthropic).

Any other keys in `settings.json` belong to pi and are ignored by
these extensions. The converse is also true: pi doesn't know about
`backgroundModels` or `extensionConfig`, so they don't interfere with
pi's own settings.

## The resolution chain

At `session_start` (or whenever the extension needs a model), the
shared resolver walks this list top-to-bottom, picking the first
candidate that resolves in the registry **and** has usable auth:

1. **Extension-specific explicit override** — a CLI flag, in-session
   command value, or legacy env var that the extension passes in as
   `opts.explicit`. (Examples: `--suggest-model=...`,
   `$PI_SESSION_AUTO_TITLE_MODEL`.)
2. **`settings.json` → `extensionConfig.<name>.model`** — the
   persistent per-extension escape hatch.
3. **`settings.json` → `backgroundModels.<set>.<tier>`** — the user's
   "what does fast/normal/heavy mean for me" configuration under
   the requested set (`primary` by default; `secondary` for
   cross-checking consumers).
4. **`settings.json` → `backgroundModels.primary.<tier>`** — fallback
   when the requested set is `secondary` and the tier isn't configured
   under it. Lets users who only configure `primary` still get
   sensible behavior from `secondary` consumers.
5. **`ctx.model`** — the active session model. Always has auth by
   definition, but may be more expensive than necessary for
   background calls.
6. **Nothing usable** → the extension disables its side task for the
   session with a single `notify()`.

Some extensions (today, only `session-title`) ask the resolver to
treat `{ ok: true, apiKey: undefined }` results as unusable via
`requireApiKey: true` — see the
[resolver source](../packages/_shared/model-resolver.ts) for details.
Other consumers accept headers-only auth because they hand the model
spec off to something that does its own auth (the subagent RPC
clients in `/review` and `/verify`, prompt-suggestion's `Predictor`).

## Per-extension tier and set assignments

| Extension | Set | Tier | Why | Override knob |
|---|---|---|---|---|
| `prompt-suggestion` | `primary` | `fast` | Ghost text runs on every `agent_end`. 40-token output, no reasoning. | `/suggest` picker (persistent), `--suggest-model` (session), `extensionConfig.prompt-suggestion.model` |
| `session-title` auto-title | `primary` | `fast` | Runs once per session. 2–5 word output. | `$PI_SESSION_AUTO_TITLE_MODEL` (legacy), `extensionConfig.session-title.model` |
| `verify` | `secondary` | `normal` | Per-step plan verifier. Reads `secondary` so its verdicts are independent of whatever model produced the work being verified. Falls back to `primary.normal` when `secondary.normal` isn't set. | `extensionConfig.verify.model` |

Extensions that don't take a background model and use `ctx.model`
directly: `commit`, `develop`, `review`, `example`, `gh`.

## Common configurations

### One Anthropic key, three tiers

The simplest setup: one provider, one config, done. Assuming you have
`ANTHROPIC_API_KEY` set.

```jsonc
// ~/.pi/agent/settings.json
{
  "backgroundModels": {
    "primary": {
      "fast":   "anthropic/claude-haiku-4-5-20251001",
      "normal": "anthropic/claude-sonnet-4-5-20250929",
      "heavy":  "anthropic/claude-opus-4-5-20250929"
    }
  }
}
```

Ghost text runs on haiku, auto-title runs on haiku. Nothing touches
opus unless an extension declares `heavy`.

### Cross-checking with primary + secondary

Configure two model families. Most extensions use `primary`; consumers
that want a second opinion (today: `verify` in PR C) use `secondary`.
Set both for proper cross-model checking; set only `primary` and
`secondary` consumers fall back to it.

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast":   "anthropic/claude-haiku-4-5-20251001",
      "normal": "anthropic/claude-sonnet-4-5-20250929",
      "heavy":  "anthropic/claude-opus-4-5-20250929"
    },
    "secondary": {
      "fast":   "openai/gpt-4o-mini",
      "normal": "openai/gpt-4o",
      "heavy":  "openai/o1"
    }
  }
}
```

### Mixed providers (no cross-checking)

Use OpenAI for background tasks, keep Anthropic for the main session
model (set via pi's `defaultProvider` / `defaultModel`):

```jsonc
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5-20250929",
  "backgroundModels": {
    "primary": {
      "fast":   "openai/gpt-4o-mini",
      "normal": "openai/gpt-4o-mini"
    }
  }
}
```

With `heavy` unset and `ctx.model` being `claude-sonnet`, a future
`heavy`-tier extension would land on sonnet.

### Gateway (Vercel / OpenRouter / corporate proxy)

If you use pi through a gateway, register the provider however the
gateway expects, then point tiers at `<gateway-provider>/<model-id>`.

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast":   "openrouter/anthropic/claude-haiku-4.5",
      "normal": "openrouter/anthropic/claude-sonnet-4.5"
    }
  }
}
```

Note the model id can contain slashes (`anthropic/claude-haiku-4.5`);
the resolver splits only on the **first** slash, so the provider is
`openrouter` and the model id is `anthropic/claude-haiku-4.5`.

### Nitpick on one provider, suggestions on another

Mix per-extension with the tier defaults:

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast":   "anthropic/claude-haiku-4-5-20251001",
      "normal": "anthropic/claude-sonnet-4-5-20250929"
    }
  },
  "extensionConfig": {
    "verify": { "model": "openrouter/anthropic/claude-sonnet-4.5" }
  }
}
```

`verify` reaches for openrouter, prompt-suggestion and session-title
stay on direct Anthropic.

### Local model (Ollama, LM Studio, etc.)

Extensions work with any pi-registered provider. If you register a
`local-openai` provider pointing at `http://localhost:1234/v1`, you
can target it like any other:

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast":   "local-openai/qwen3-coder",
      "normal": "local-openai/qwen3-coder"
    }
  }
}
```

Local models cost nothing per call but tend to be slower and less
capable. Good fit for `fast`-tier extensions (short outputs); for
`normal`-tier consumers like `verify`, only viable if the local
model is sharp enough to read diffs and produce structured JSON.

### Minimal — configure only what you care about

Everything is optional. An empty `settings.json` works: every
extension falls through to `ctx.model`. If that's a sonnet-class
model you're OK with running ghost text on, you don't need any of
this.

If you find that behavior too expensive but don't want to think about
tiers, just set `backgroundModels.primary.fast`:

```jsonc
{
  "backgroundModels": {
    "primary": {
      "fast": "anthropic/claude-haiku-4-5-20251001"
    }
  }
}
```

Covers both prompt-suggestion and session-title (the only `fast`-tier
consumers). `verify` (`normal`-tier, `secondary` set) falls through
to `ctx.model` until you configure `secondary.normal` or
`primary.normal`.

## Provider and gateway notes

pi discovers providers from its own `models.json` and custom provider
registrations. This monorepo doesn't care which provider you use —
it only cares that `modelRegistry.find(provider, id)` resolves to
something and that `getApiKeyAndHeaders(model)` produces usable auth.

- **Direct providers** (Anthropic, OpenAI, Google): set the provider's
  standard env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`) and the model will auth.
- **OAuth / gateways**: use whatever provider id the gateway registers
  under. See pi's
  [`custom-provider.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md)
  for how to register one.
- **Headers-only auth**: works for most extensions, but `session-title`
  auto-title requires `apiKey` because it passes it directly to
  `completeSimple()`. If your provider auths via headers alone, expect
  auto-title to skip silently and the git-branch / cwd fallback to
  stay in place.

## Troubleshooting

### An extension silently isn't doing its thing

Every extension's disable path goes through one `notify()` at
`session_start`. If you didn't see it, your model probably resolved —
the issue is elsewhere. If you did see it, the message names the
extension and the specific config keys it looked for.

Quick checks:

- `/suggest-status` dumps prompt-suggestion's current resolved model,
  auth status, gate reasons, and the last few predict attempts.
- `/verify` (when run) reports the resolved model in its TUI report
  header.
- session-title auto-title runs at most once per session and writes
  its status to the session's auto-title state; re-run with `/retitle`
  to force a fresh attempt.

### The resolved model isn't what you expected

The resolution chain is deterministic and documented above. Walk it
top-to-bottom against your current state:

1. Did you pass an explicit override (CLI flag / in-session command
   / env var)?
2. Does `extensionConfig.<name>.model` exist in your project or global
   settings? Project wins.
3. Does `backgroundModels.<set>.<tier>` exist for the set the
   extension uses?
4. If the extension uses `secondary` and that tier is unset, does
   `backgroundModels.primary.<tier>` exist?
5. What's `ctx.model` currently?

If a higher-priority candidate isn't in the registry or has no auth,
the resolver skips it and continues. That's why a typo'd
`extensionConfig.verify.model` can produce "huh, it's using my
session model, not the thing I configured" — verify's override
didn't resolve, so step 3 won.

### Settings changes aren't being picked up

Extensions read `settings.json` at `session_start`. Edit the file and
restart pi; the new values apply on the next session.

### Old flat `backgroundModels.<tier>` config doesn't work

It used to. The schema changed to nest tiers under `primary` /
`secondary`. Move your existing settings under `primary`:

```diff
 {
   "backgroundModels": {
-    "fast":   "anthropic/claude-haiku-4-5-20251001",
-    "normal": "anthropic/claude-sonnet-4-5-20250929",
-    "heavy":  "anthropic/claude-opus-4-5-20250929"
+    "primary": {
+      "fast":   "anthropic/claude-haiku-4-5-20251001",
+      "normal": "anthropic/claude-sonnet-4-5-20250929",
+      "heavy":  "anthropic/claude-opus-4-5-20250929"
+    }
   }
 }
```

### `PI_SESSION_AUTO_TITLE_MODELS` seems to be ignored

Because it is — the comma-separated shortlist env var was removed. Pick
a single model and put it in `PI_SESSION_AUTO_TITLE_MODEL` or
`settings.json`.

## Why tiers instead of a single "background model"

Three consumers with different needs:

- Ghost text on every turn wants *fast*.
- Continuous subagent review wants *reasoning-capable*.
- Auto-title once per session doesn't care, but grouping with ghost
  text under `fast` is the obvious default.

A single `backgroundModel` would force users to compromise between
"cheap enough for ghost text" and "capable enough for verification."
Three tiers give three knobs, priced and picked independently. Users
who don't care set one (`primary.fast`); users who care set three.

Tier labels are intent, not implementation. If "heavy" means
`claude-opus-4-5` to you and `gemini-2.5-pro` to someone else, that's
fine — the extensions just ask the resolver for a (set, tier) and use
whatever comes back.

## Why two sets (primary / secondary)

A second model family is useful for cross-checking. Run a verifier on
your primary stack, and run it again on the secondary stack — if both
agree, high confidence; if they disagree, that's a signal worth
investigating.

Most users will configure only `primary`. The `secondary` set exists
for users who want cross-model checking and have credentials for a
second provider. Consumers that read `secondary` (today: just
`verify`) fall back to `primary` cleanly when `secondary` isn't
configured, so the schema isn't a tax on users who don't care.
