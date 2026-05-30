# pi-ext-derp

`/derp <text>` — fire-and-forget GitHub bug reporter that doesn't
interrupt the active session.

## What it does

You spot something broken in pi or the project. You don't want to stop
what you're doing. You type `/derp <free-form description>` and the
extension files a polished GitHub issue against this repo —
`vegardx/pi-extensions` — entirely inside the slash-command handler,
with no host turn fired.

```
/derp ghost text overlaps the input on iTerm when caffeinate is on
→ derp: polishing report for github.com/vegardx/pi-extensions…
→ derp: filed https://github.com/vegardx/pi-extensions/issues/42
```

This is closer to Claude Code's `/btw` than to `/pause`: the host
agent's current turn is undisturbed. Internally `derp`:

1. Gathers repo context (origin, branch, HEAD, `git status --short`),
   pi version, and a tail of recent session entries.
2. Runs the redactor over the captured context. **Fail-closed**: any
   secret-shaped match aborts the file and stashes the (redacted)
   draft to disk for manual review.
3. Spawns a one-shot, read-only RPC subagent on the **active session
   model** (`ctx.model`) to polish the report into a clean
   `{ title, body }` issue.
4. Re-runs the redactor over the polished output. Again fail-closed.
5. Shells out to `gh issue create -R vegardx/pi-extensions` so the
   issue always lands here, regardless of where you triggered the
   command from.

## Where issues go

**Always `vegardx/pi-extensions`**, regardless of cwd. The cwd's
`origin` is captured for context (rendered in the issue body's
Environment block) but never used as the file target.

This is intentional for v1: the user wanted a low-friction way to
report bugs in *this* set of extensions. A natural follow-up is
per-call routing (e.g. `/derp! pi-mono ...` or a `targetRepo` config)
to file harness bugs upstream against `badlogic/pi-mono` — see
"Future work" below.

## No-host-turn guarantee

The handler **never calls `pi.sendMessage`**. A unit test
(`__tests__/no-host-turn.test.ts`) walks every source file in the
package and fails the build if a `sendMessage(` call appears.

There is no confirmation dialog either; the redactor's fail-closed
behaviour is the only safety net. When the redactor doesn't fire,
filing is silent and instant. When it does fire, you get a
notification pointing at a local file you can review, edit, and
re-file by hand.

## Public-issue safety

Issues are public, so we redact aggressively. **Fail-closed**: any
match on either pass aborts the file and stashes to
`~/.pi/agent/derp/pending/<iso-timestamp>-<host>.md`.

| Detector | Catches |
|---|---|
| `secret-token` | GitHub PATs (`ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), Slack (`xoxb-`/etc), AWS access keys (`AKIA…`), `sk-…` (OpenAI/Anthropic-shape), JWTs |
| `auth-header` | `Authorization: Bearer …`, `x-api-key: …` |
| `private-key` | PEM blocks (`-----BEGIN … PRIVATE KEY-----`) |
| `env-secret` | `*KEY=`, `*TOKEN=`, `*SECRET=`, `*PASSWORD=`, `*PASS=`, `*API_KEY=` env-style assignments |
| `internal-host` | Hostnames under `.ghe.com`, `.internal.…`, `.intranet.…`, `.corp.…`, `.private.…` (allowlist: `github.com`, `gitlab.com`) |

When something fires you'll see:

```
derp: input contained secret-shaped content (secret-token, internal-host) — not filing.
Review at ~/.pi/agent/derp/pending/2026-05-10T….md;
if safe, run `gh issue create -R github.com/vegardx/pi-extensions --body-file <path>`.
```

The stashed file is the *redacted* draft (with `[REDACTED:<kind>]`
placeholders) — you can edit it locally, decide what's actually safe
to share, and file by hand.

The polish subagent is also explicitly told (in
`system-prompt.md`) to never include secrets or internal context. The
regex pass is the authoritative gate; the system-prompt instruction
is belt-and-braces.

## Loss-proof

Beyond redaction, every other failure path also stashes the polished
report to `~/.pi/agent/derp/pending/`:

| Reason | What you see | What's saved |
|---|---|---|
| Empty input | warning: needs something to derp on | nothing |
| Input redaction fired | warning + kinds | redacted draft |
| Output redaction fired | warning + kinds | redacted draft |
| No active session model | warning + raw template filed | issue created with deterministic body |
| Polish times out / returns bad JSON | warning + raw template filed | issue created with deterministic body |
| `gh` not installed / not authenticated | warning with recovery hint | redacted polished draft |
| `gh issue create` fails | warning with stderr snippet | redacted polished draft |

Recover by hand:

```
gh issue create -R github.com/vegardx/pi-extensions --body-file <pending-file>
```

## Crash reports

When `/implement` crashes mid-phase, the `modes` extension writes a
redacted JSON snapshot to `~/.pi/agent/modes/crash-reports/`. The
snapshot includes the error + stack, the active mode/branch/phase,
and the last few session entries.

The next `/derp` invocation in the same session picks up matching
crash reports automatically and attaches them to the issue body
under a `## Crash reports` heading. Reports are matched by session
id (filename + payload), so cross-session leakage is impossible.

The data is already redacted at write time; `/derp` re-scans it
defensively before filing so any redaction regression still trips
the fail-closed check.

## Configuration

Under `extensionConfig.derp` in `~/.pi/agent/settings.json` (or per
project):

| Key | Type | Default | Description |
|---|---|---|---|
| `labels` | `string[]` | `["bug"]` | Labels applied to the issue. Unknown labels trigger one retry without `--label`; the issue is still filed. |
| `polish.timeoutMs` | `number` | `30000` | Hard timeout for the polish subagent. On timeout, derp falls back to a deterministic template. |
| `polish.contextEntries` | `number` | `6` | How many tail entries from the current session to feed into the polish subagent. |
| `titlePrefix` | `string` | `"[derp] "` | Prefix prepended to the title. Set to `""` to disable. |

The polish step uses a **fast tier** model (`tier: "fast"` in
`resolveModel`) — pick the cheap/quick model in your
`backgroundModels.primary.fast` slot, or override via
`extensionConfig.derp.model`. Falls back to the active session
model when no fast tier is configured.

## Future work

- **Cross-repo routing.** A `targetRepo` config (or a `--target` flag)
  so harness bugs spotted while working on a feature branch can be
  routed straight to `badlogic/pi-mono` without leaving the current
  repo.
- **Attachments.** Bundle a screenshot path or a short clipboard
  buffer alongside the report.
- **Project-local templates.** Per-repo issue templates picked up
  automatically via `.github/ISSUE_TEMPLATE/`.
