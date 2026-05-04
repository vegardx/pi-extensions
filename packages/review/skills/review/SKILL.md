---
name: review
description: Multi-agent code review. Fan out seven specialist reviewers (architect, code-reviewer, scope-analyst, security-analyst, code-simplifier, doc-reviewer, dependency-checker) over a diff or the whole codebase, then walk every finding with the user and hand accepted fixes to the main agent. Use before committing, opening a PR, or cutting a release. Invoked by the /review extension command; can also be used standalone via /skill:review.
---

# Review

Run seven specialist reviewers in parallel, collect their findings, dedupe,
and walk the user through each one. Accepted fixes are batched and handed
to the main agent to apply.

This skill can be invoked two ways:

- **With the extension** — `/review` (or `--staged`, `--branch`, `--all`,
  `<path>`). The extension handles fan-out, dedupe, and the walk-through
  UI. You only see this skill's content if the extension is unavailable,
  or if the user explicitly runs `/skill:review`.
- **Standalone** — `/skill:review [scope]`. You drive the whole workflow
  yourself using the main agent's capabilities, without parallel subagent
  RPC. Slower but functional.

## Scopes

- No arguments → working tree (unstaged + staged)
- `--staged` → index only
- `--branch` → current branch vs. default branch
- `--all` → entire codebase, no diff
- `<path> [path …]` → diff of specified paths

All seven reviewers run in parallel on every scope. Each one handles
the two scope modes identically: in diff scope it reviews only the
changed lines and returns `[]` if nothing in its lane appears; in
`--all` scope it sweeps the full tree for concerns in its lane. So on
a code-only diff, dependency-checker returns empty immediately; on a
dependency-only diff, the other six do the same.

## Workflow

1. Determine scope (see above). If you're standalone, derive the diff
   yourself:
   ```bash
   git diff HEAD                    # working tree
   git diff --cached                # staged
   git diff <default>...HEAD        # branch
   git diff HEAD -- <path>          # file path
   git ls-files                     # --all
   ```
2. For each reviewer role, produce findings. The extension launches seven
   parallel `pi --mode rpc` subagents with role-specific system prompts.
   Standalone, do each role sequentially in a single reasoning pass:
   - architect, code-reviewer, scope-analyst, security-analyst,
     code-simplifier, doc-reviewer, dependency-checker
3. Each role emits a JSON array of findings:
   ```json
   [
     {
       "severity": "CRITICAL" | "IMPORTANT" | "NOTE",
       "file": "path/relative/to/root.ts",
       "line": 42,
       "title": "short summary",
       "description": "why",
       "suggestedAction": "concrete fix"
     }
   ]
   ```
4. Dedupe: collapse findings with the same `file:line:title.lower()` and
   track which reviewers flagged each. Consensus (2+ reviewers) counts as
   higher confidence. Promote severity to the highest seen.
5. Present the summary: scope, counts per severity, consensus-first
   ordering within each tier.
6. Walk findings: CRITICAL → IMPORTANT → NOTE. For each, offer Accept /
   Skip / Explain. NOTEs can be presented as a read-only batch first with
   an opt-in "walk NOTEs too" step.
7. Hand accepted fixes to the agent in a single batch. Do not commit
   during review — group into logical commits at the end.

## Role responsibilities

Each role is also available as a standalone skill — invoke
`/skill:<role>` when you want one lens without the full fan-out:

- **architect** (`/skill:architect`) — coupling, module boundaries,
  layering, data flow.
- **code-reviewer** (`/skill:code-reviewer`) — bugs, logic, reuse,
  test coverage, CLAUDE.md compliance.
- **scope-analyst** (`/skill:scope-analyst`) — feature creep, unrelated
  changes, over-engineering.
- **security-analyst** (`/skill:security-analyst`) — OWASP Top 10,
  injection, auth, secrets, crypto misuse in the project's own code.
- **code-simplifier** (`/skill:code-simplifier`) — redundancy, dead
  code, idiomatic replacements, unused exports.
- **doc-reviewer** (`/skill:doc-reviewer`) — stale comments, missing
  API docs, outdated examples, CHANGELOG gaps.
- **dependency-checker** (`/skill:dependency-checker`) — known CVEs,
  deprecated packages, lock file hygiene, supply-chain red flags in
  third-party packages.

The per-role skills are hidden from the default skill advertisement
(`disable-model-invocation: true`) so they don't bloat every session's
system prompt. They're still invocable any time via `/skill:<role>`.
When any of them runs as part of `/review`, the scope is pre-formatted;
when invoked standalone, the skill asks the user for scope first.

## Severity rubric

- **CRITICAL** — must fix: bugs, security vulnerabilities, data-loss
  risks, known-exploited CVEs.
- **IMPORTANT** — should fix: quality issues, missing validation,
  complexity, reuse opportunities, deprecated dependencies.
- **NOTE** — informational: scope observations, minor simplification
  suggestions, stale CHANGELOG entries.

## Output format (standalone mode)

If running without the extension, present the summary first, then walk
findings one at a time:

```markdown
## Review Report

**Scope**: <label>
**Files**: N changed, +A / -D

| Severity | Count |
|----------|-------|
| CRITICAL | n     |
| IMPORTANT | n    |
| NOTE     | n     |

## [1/T] CRITICAL — <title>
**Location**: `file:line`
**Flagged by**: <reviewers>
<description>
**Suggested action**: <action>
**Confidence**: high — recommending Accept (2 reviewers agree, concrete fix)

> Accept (Recommended) / Skip / Explain?
```

*Use `##` (not `###`) for finding headings — pi-tui's terminal markdown
strips `#` and `##` hashes but keeps `###`+ visible. Matching the
extension's output keeps the standalone-mode rendering consistent.*

Mark one option as `(Recommended)` when the finding is high-confidence:

- **Recommend Accept** when severity is CRITICAL *or* 2+ reviewers flagged
  the same issue, **and** a concrete `suggestedAction` exists.
- **Recommend Explain** when the finding is high-confidence (same triggers)
  but no concrete fix is available — the user needs more context before
  deciding.
- **Never recommend Skip**: dismissing a real issue confidently is worse
  than leaving the user neutral.
- **No recommendation** for low-confidence findings (single-reviewer
  IMPORTANT/NOTE without consensus).

Also include a short `**Confidence**: high — recommending X (reasons)`
line in the finding card so the user can see *why* before picking.

Wait for the user to reply after each finding. Do not apply fixes during
the walk; collect decisions, then apply as a single batch at the end.

## When NOT to use

- Trivial single-line fixes — the ceremony isn't worth it.
- Files you're mid-edit on — finish first.
- When you want just one lens (security, docs) — call the relevant
  single reviewer directly instead.
