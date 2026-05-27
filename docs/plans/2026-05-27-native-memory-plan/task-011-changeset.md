# Task 011 — Changeset entry + memory.md tool description + reference doc

**Subject**: Author the final agent-facing tool description, add a reference doc, and emit the `minor` changeset entry.
**Type**: config
**Depends-on**: ["002-impl", "003-impl", "004-impl", "005-impl", "006-impl", "007-impl", "008-impl", "009-impl", "010-impl"]

## Why this task exists

The earlier impl tasks created a placeholder `memory.md` and added telemetry / TUI surfaces without finalizing user-facing documentation. This task closes the loop: a comprehensive agent-facing tool description, a short reference doc for human users, and the changeset that releases the feature.

No direct BDD scenario maps to this task — it is shipping wrap-up.

## Files

- **Author**: `packages/agent-core/src/tools/builtin/state/memory.md` — final tool description. Sections per design `architecture.md` §4:
  - When to use / when NOT to use
  - Scope guidance (`user` vs `project`; project overrides user; explicit scope required on read/write/update/delete)
  - Operation reference (one-line example per operation)
  - Hygiene rules (prefer `update` over `write`; delete superseded facts; keep `description` < 80 chars when possible)
  - Project-memory-in-git note + `.gitignore` opt-out suggestion
  - Subagent visibility timing note (write visible to parent on next turn)
  - Plan-mode block note
  - Reserved filename note (`MEMORY.md`)
- **Create**: `docs/reference/memory.md` — short human-facing reference. Topics: storage layout; how `/memory` and `/remember` work; how to gitignore project memory; how the index byte budget works; v1 limitations.
- **Create**: `.changeset/<random-name>.md` — `minor` bump for the affected packages:
  ```markdown
  ---
  "@moonshot-ai/agent-core": minor
  "@moonshot-ai/kimi-code-sdk": minor
  "kimi-code": minor
  ---

  feat: native cross-session memory with /memory and /remember slash commands

  Adds a file-backed Markdown memory subsystem to kimi-code. Per-fact .md
  bodies live under `~/.kimi-code/memory/` (user scope) and
  `<project-root>/.kimi-code/memory/` (project scope). A rendered MEMORY.md
  index is injected into the system prompt (≤ 8 KB). The new Memory builtin
  tool exposes view/list/read/write/update/delete operations. The new
  /memory slash command opens a full-screen TUI browser; /remember <text>
  asks the agent to persist a fact via the Memory tool.
  ```
- **Author**: AGENTS.md update — **skip** (per design `best-practices.md`: do not update the root `AGENTS.md`; reference docs live under `docs/`).

## Implementation guidance

- Run the `gen-changesets` skill per repo `AGENTS.md:60` — its output replaces the hand-written changeset stub above with the canonical generated entry.
- **Do not write `major`** — per repo `AGENTS.md:61`, default to `minor` for a new feature.
- Final pre-PR run: `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.

## Verification

- `pnpm test` passes the full suite.
- `pnpm typecheck` and `pnpm lint` pass.
- `pnpm build` succeeds.
- A new changeset file exists under `.changeset/` with `minor` bumps for the three affected packages.
- Manual TUI verification: `pnpm dev:cli`, `/remember test fact`, exit, restart, observe the agent recall the fact without prompting.
