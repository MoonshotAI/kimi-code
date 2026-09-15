---
name: sub-skill
description: Discover and reorganize the skill inventory into hierarchical sub-skill bundles. Use when the user asks to review, group, or consolidate skills into a parent bundle.
disable-model-invocation: true
has-sub-skill: true
---

# Sub-skill

Container skill for analyzing the local skill inventory and reorganizing it into hierarchical sub-skill bundles (`has-sub-skill: true` parents with children inside).

## When to use

- The user asks to review, reorganize, or consolidate skills.
- There are many loosely-related skills that might benefit from hierarchical grouping.
- The user wants to evaluate whether a new skill should be a sub-skill of an existing one.

## Sub-skills

- **`sub-skill.review`** — Analyze the current inventory and propose candidate sub-skill groupings.
- **`sub-skill.consolidate`** — Apply an approved grouping by moving skills into a parent bundle, with timestamped backups.

The usual flow is `sub-skill.review` first (read-only proposal), then `sub-skill.consolidate` after the user approves a plan. Never run consolidate without an explicit go-ahead from the user.
