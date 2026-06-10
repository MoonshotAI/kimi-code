---
name: sub-skill.consolidate
description: Apply an approved sub-skill grouping by moving user-specified skills into a parent bundle, with timestamped backups of every modified directory.
disable-model-invocation: true
---

# Consolidate sub-skills (`sub-skill.consolidate`)

Execute the reorganization by moving user-specified skills into a parent bundle, forming a sub-skill hierarchy.

## When to use

- The user has approved a grouping proposal (typically from `sub-skill.review`) and wants to apply it.
- Migrating standalone skills into a new or existing parent bundle.

## Process

1. **Confirm the plan.** Restate which skills will move and where, and ask the user to confirm **before** making any file changes.
2. **Back up every original skill directory.** Before moving anything, create a timestamped backup of each skill directory that will be modified.
   - For a skill at `<root>/<skill-name>/SKILL.md`, back up the entire `<skill-name>` directory:
     ```bash
     cp -r <skill-name> "<skill-name>.$(date +%Y%m%d-%H%M%S).bak"
     ```
   - Keep all backups; never overwrite an existing backup file.
3. **Create or update the parent bundle.**
   - If the parent does not exist, create `<parent-name>/SKILL.md` with `has-sub-skill: true` in the frontmatter.
   - If the parent already exists, ensure its frontmatter includes `has-sub-skill: true`.
4. **Move child skills into the parent.** Move each child skill's entire directory under the parent bundle.
   - Example: `web-search/` → `web-research/web-search/`
5. **Verify the result.** List the new directory structure and confirm each moved skill still has a valid `SKILL.md` with required frontmatter (`name` and `description`).
6. **Report the change.** Summarize what was moved, the new structure, and where backups are located.

## Don'ts

- **Never move skills without backing up first.**
- **Never overwrite an existing backup** — always use a fresh timestamped suffix.
- **Don't drop frontmatter or payload files** during the move; the entire directory must be preserved.
- **Don't create deeply nested hierarchies** (3+ levels) unless the user explicitly requests it.
