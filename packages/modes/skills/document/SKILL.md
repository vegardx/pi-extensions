---
name: document
description: Create or update project documentation (CONTEXT.md, DESIGN.md) when domain terms are resolved, architecture decisions are made, or the project needs its knowledge captured. Use when the user says "document this", "add to context", "create a CONTEXT.md", or after a grilling/improve session that resolved terminology.
---

# Document

Maintain structured project documentation that gives agents (and humans)
the context they need to work effectively.

## Documentation taxonomy

| File | Purpose | When to create |
|------|---------|----------------|
| `AGENTS.md` | Instructions for AI agents | Already exists in most projects |
| `CONTEXT.md` | Domain model, bounded contexts, ubiquitous language | When the first domain term is resolved |
| `DESIGN.md` | Architecture patterns, constraints, key decisions | When the first structural decision is made |
| `docs/adr/NNNN-*.md` | Individual Architecture Decision Records | When a decision is hard to reverse and surprising |

## CONTEXT.md format

A domain glossary — the ubiquitous language of the project.

```markdown
# Context

## Domain

Brief description of what this project/module does.

## Glossary

### Term
Definition. Be precise — distinguish from similar concepts.
Note any constraints or invariants.

### Another Term
Definition.
```

Rules:
- Only include terms meaningful to domain experts (not implementation details)
- Each term has exactly one definition — no synonyms
- If two things seem like the same term, they're probably different. Split them.
- Update inline as terms are resolved during conversation — don't batch

## DESIGN.md format

Architecture patterns and constraints that inform implementation decisions.

```markdown
# Design

## Principles
- Principle 1: explanation
- Principle 2: explanation

## Patterns
### Pattern Name
Where it's used, why, and the constraints it imposes.

## Constraints
Things we cannot or chose not to do, with reasons.
```

## ADR format

```markdown
# NNNN — Title

**Status:** accepted | superseded by NNNN | deprecated
**Date:** YYYY-MM-DD

## Context
What forces are at play.

## Decision
What we chose to do.

## Consequences
What follows from this decision (both positive and negative).
```

Only create an ADR when ALL three are true:
1. Hard to reverse
2. Surprising without context
3. Result of a real trade-off

## Process

### When to update documentation

- **During planning:** if a term is ambiguous, resolve it and add to CONTEXT.md
- **After /improve:** if architectural decisions were made, add to DESIGN.md or create an ADR
- **After /diagnose:** if the bug revealed a missing constraint, add to DESIGN.md
- **On conflict:** if code contradicts documentation, surface the contradiction and ask which is right

### Creating files

Create lazily — only when you have something to write. Check if the file
exists first. If it does, update it. If not, create with the format above.

Default locations:
- `CONTEXT.md` — project root (or per-module if the project is large)
- `DESIGN.md` — project root
- `docs/adr/` — standard ADR directory
