---
name: gen-docs
description: Update Kimi Code CLI user documentation after meaningful code changes that affect product behavior or user experience.
---

# Gen Docs

## Overview

Update affected user documentation in both `docs/en/` and `docs/zh/` in the same change.

Use this skill to update the corresponding documentation whenever the codebase has changes that affect product behavior or user experience.

Read `docs/AGENTS.md` for the locale rules and terminology. Use the [writing guide](references/writing-guide.md) for page structure, examples, and the review checklist.

For the CLI documentation changelog or the desktop update dialog, follow [sync-changelog](../sync-changelog/SKILL.md).

## Workflow

1. **Inspect changes**

   - `git log main..HEAD --oneline` — commits on the current branch
   - `git diff main...HEAD --stat` — committed changes since the branch diverged
   - `git status --short`, `git diff`, and `git diff --cached` — new files and local changes awaiting commit
   - `ls .changeset/*.md` (excluding `README.md`) — pending changeset entries

2. **Understand user-facing impact**

   For each change, read the actual implementation when needed; **do not infer behavior from commit messages or PR titles alone**. Skip:

   - Internal refactors with no externally visible behavior change
   - Tests, CI, type-only changes
   - Tooling / build-system changes that do not change how users invoke the CLI

   If after the scan you conclude there is no user-facing impact, say so and stop.

3. **Update user docs**

   Following the rules in `docs/AGENTS.md`, edit the affected pages in whichever locale you are working in, then sync the mirror. Match terminology with the term table in `docs/AGENTS.md` and the existing wording in surrounding pages.

   Cover all relevant sections:

   - Guides (getting-started, use cases, interaction, sessions, web, print, IDE integration, other agents — keep `skills/use-kimi-code/SKILL.md` and `packages/kap-server/docs/kap.md` aligned when local server bootstrap or core KAP capabilities change)
   - Customization (skills, agents, MCP, hooks, plugins, etc.)
   - Configuration (config files, env vars, providers, data locations)
   - Reference (CLI subcommands, slash commands, keyboard shortcuts)

4. **Sync and review the affected pages**

   Use [translate-docs](../translate-docs/SKILL.md) for the affected page pairs. Check each mirror against the implementation and follow the [writing guide’s review checklist](references/writing-guide.md#检查清单).

## Rules and conventions

- **Terminology**: Use the term table in `docs/AGENTS.md` exactly. Do not invent new translations or use synonyms.
- **Scope discipline**: Only update sections affected by the recent changes. Do not opportunistically rewrite unrelated docs.
- **Public examples**: Never write real internal endpoints, key names, account names, or service names into docs. Use neutral placeholders such as `https://api.example.com/v1`, `https://registry.example.com/v1/models/api.json`, `example.test`, and `YOUR_API_KEY`.
- **Breaking changes**: In each affected guide or reference page, explain the previous behavior, who is affected, and how to migrate. Include the same guidance in both locales.

## Common mistakes

- Describing what code changed instead of what the user can now do (or can no longer do).
- Adding a new section heading per feature instead of weaving the change into existing prose.
- Updating only one locale and leaving its mirror stale.
- Editing only the mirror to fix wording that should be corrected in the locale you changed first.
- Inventing new terminology that drifts from the `docs/AGENTS.md` term table.
- Using real internal values in examples instead of neutral `example` placeholders.
