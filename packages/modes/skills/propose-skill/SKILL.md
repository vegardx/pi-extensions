---
name: propose-skill
description: Analyze the current session (and optionally past sessions) for repeated patterns and propose project-local skills. Use when the user wants to automate a recurring workflow, says "this should be a skill", or after a diagnose/implement session that revealed a repeated pattern.
---

# Propose Skill

Analyze workflows and propose project-local skills (`.pi/skills/`) that
encode repeated patterns so future sessions handle them automatically.

## When to propose a skill

A good skill candidate has ALL of these:

1. **Repeated** — the pattern appears across multiple sessions or tasks
2. **Mechanical** — the steps are predictable given a trigger condition
3. **Error-prone** — humans (or agents) often forget a step or get the order wrong
4. **Self-contained** — the workflow can be described without project-wide context

Bad candidates: one-off procedures, things that change every time, patterns
that require human judgment at every step.

## Process

### 1. Identify the pattern

Look for repeated workflows in:

- The current session (repeated tool call sequences, similar edit patterns)
- The diagnose session that just completed (prevention workflow)
- User's description of what they do repeatedly

### 2. Draft the skill

A skill file is a markdown document with YAML frontmatter:

```markdown
---
name: short-kebab-name
description: One sentence describing when to invoke this skill.
---

# Skill Title

Instructions the agent follows when this skill is invoked.
```

Key principles:

- **Trigger-focused description** — the `description` field tells the agent
  WHEN to load this skill. Be specific about trigger conditions.
- **Imperative instructions** — tell the agent what to DO, not what to know.
- **Exit conditions** — clearly state when the skill is "done."
- **Escape hatches** — say when to bail out and ask the user.

### 3. Present to the user

Show the proposed skill content. Ask:

- Does this capture the pattern correctly?
- Should the trigger conditions be broader or narrower?
- Is anything missing from the steps?
- Should this be project-local (`.pi/skills/`) or global (`~/.pi/agent/skills/`)?

### 4. Write the file

Save to the agreed location. Default to project-local unless the user
says it's cross-project.

```
.pi/skills/<name>/SKILL.md
```

### 5. Suggest related improvements

After creating the skill, consider:

- Should any AGENTS.md guidelines reference this skill?
- Are there other patterns in this session that could be skills?
- Would a `-FORMAT.md` template help standardize the skill's output?
