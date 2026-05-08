---
name: improve
description: Find architectural friction and propose deepening opportunities — refactors that turn shallow modules into deep ones. Use when the user wants to improve architecture, find refactoring opportunities, reduce coupling, or make a codebase more testable and navigable.
---

<!-- Adapted from mattpocock/skills (MIT) — https://github.com/mattpocock/skills -->

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** —
refactors that turn shallow modules into deep ones.

## Key concepts

- **Module** — anything with an interface and an implementation (function, class, package).
- **Interface** — everything a caller must know: types, invariants, error modes, ordering.
- **Depth** — leverage at the interface. **Deep** = lots of behavior behind a small interface. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behavior can be altered without editing in place.
- **Deletion test** — imagine deleting the module. If complexity vanishes, it was pass-through. If complexity reappears across N callers, it was earning its keep.

## Process

### 1. Explore

Read project documentation (AGENTS.md, CONTEXT.md, ADRs) first to understand
the domain model and any existing architectural decisions.

Then explore the codebase organically. Look for friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have functions been extracted just for testability, but real bugs hide in how they're called?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested or hard to test through their current interface?

Apply the **deletion test** to suspects: would deleting it concentrate complexity, or just move it?

### 2. Present candidates

Show a numbered list of deepening opportunities. For each:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture causes friction
- **Opportunity** — what would change (plain English)
- **Benefits** — in terms of locality, leverage, and testability

Do NOT propose interfaces yet. Ask: "Which of these would you like to explore?"

### 3. Design conversation

Once the user picks a candidate, walk the design tree:

- Constraints and dependencies
- Shape of the deepened module
- What sits behind the seam
- What tests survive vs. need rewriting
- Whether new terms need defining (→ update CONTEXT.md)

### 4. Output

When a candidate is accepted, produce:

- A concrete refactoring plan (suitable for plan_step)
- Updated documentation if domain terms changed
- Optional: ADR if the decision is hard to reverse and would surprise a future reader

### 5. When NOT to refactor

- The code is about to be deleted
- The "refactor" is really a feature change in disguise
- An existing ADR explicitly chose this structure for good reasons
- The benefit is purely aesthetic with no testability or locality gain
