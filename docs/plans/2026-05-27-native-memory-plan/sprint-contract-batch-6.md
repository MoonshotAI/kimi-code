# Batch 6 Sprint Contract (final)

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch scope**: Wrap-up — finalize agent-facing tool description, add human-facing reference doc, emit the changeset entry. No new code surfaces.
  - Task 20 only
**Execution mode**: Single config task. Sole remaining batch — exempt from the ≥2-task batch-size rule.
**Revision**: 1

## Tasks

| ID (TaskList) | Plan ID | Subject | Type |
|---|---|---|---|
| 20 | 011 | Changeset + memory.md tool description + reference doc | config |

## Acceptance Criteria

Per `task-011-changeset.md`:

- [ ] **`packages/agent-core/src/tools/builtin/state/memory.md`** — finalized agent-facing tool description. Sections per design `architecture.md` §4:
  - When to use / when NOT to use.
  - Scope guidance: `user` for cross-project preferences; `project` for repo-specific facts. Project overrides User on slug collision. Explicit `scope` required on read/write/update/delete.
  - Operation reference: one-line example per `operation` (`view`, `list`, `read`, `write`, `update`, `delete`).
  - Hygiene: prefer `update` over `write` for refinement; delete superseded facts; keep `description` < 80 chars when possible.
  - Project memory may be committed to git — note `.gitignore` opt-out for personal content.
  - Subagent visibility timing: a subagent's write is visible to its parent only on the parent's next turn.
  - Plan-mode block: `write/update/delete` blocked under plan mode; reads still succeed.
  - Reserved filename `MEMORY.md` note.
- [ ] **`docs/reference/memory.md`** (new) — short human-facing reference. Topics: storage layout (`~/.kimi-code/memory/` vs `<project>/.kimi-code/memory/`); how `/memory` (TUI browser) and `/remember <text>` (agent-routed write) work; .gitignore guidance for project memory; index byte budget (8 KB) and per-fact body cap (4 KB); v1 limitations (no vector search, no auto-write on SessionEnd, no encryption at rest, no cross-machine sync).
- [ ] **`.changeset/<random-name>.md`** — `minor` bump for the affected packages (`@moonshot-ai/agent-core`, `@moonshot-ai/kimi-code-sdk`, `kimi-code`). Use the `gen-changesets` skill at `.agents/skills/gen-changesets/SKILL.md` if available; otherwise write the entry by hand following the existing `.changeset/` convention.
- [ ] **NEVER write `major`** — per repo `AGENTS.md:61`, default to `minor` for a new feature. If anything in the diff appears to be a breaking change, STOP and flag for confirmation rather than writing `major`.
- [ ] **Do NOT update root `AGENTS.md`** — per design `best-practices.md`, reserved for hot-path rules. The reference doc + tool description carry the new convention.
- [ ] Final smoke verification: `pnpm typecheck && pnpm test && pnpm lint && pnpm build` all exit 0.

## Quality Requirements

- TypeScript style does not apply (no source changes).
- Tool description (`memory.md`) is loaded by the `.md` loader pattern at `packages/agent-core/src/tools/builtin/state/memory.ts` — same convention as `todo-list.md`. Keep it concise; the agent reads this on every tool call.
- Reference doc (`docs/reference/memory.md`) is for humans — use markdown, link to relevant code (e.g., `packages/agent-core/src/memory/`), no emojis.
- Changeset summary line should be one sentence; description paragraph should match the design's user-facing pitch.
- No co-author / no agent identity in any text artifact.

## Verification Commands

```bash
cd /Users/FradSer/Developer/FradSer/kimi-code
pnpm typecheck
pnpm test
pnpm lint
pnpm build
ls .changeset/  # confirm new entry exists
cat .changeset/<new-entry>.md  # confirm minor bump, no major
```

All `pnpm` commands exit 0. The new changeset file exists and contains `minor` bumps for the three affected packages.

## Sign-off

Revision: 1
Written by: executing-plans main agent
Date: 2026-05-28
