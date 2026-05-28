# Memory

kimi-code has native cross-session memory: a small set of Markdown facts the agent can read at the start of every turn and curate via a builtin tool. Memory is complementary to `AGENTS.md` (human-authored project documentation) and Skills (reusable procedures) — it holds runtime-managed facts like user preferences and project conventions.

## Storage Layout

Memory is per-fact `.md` files under two scope roots:

| Scope | Root | Applies to |
|---|---|---|
| `user` | `~/.kimi-code/memory/` | All projects this user opens with kimi-code |
| `project` | `<project-root>/.kimi-code/memory/` | This repository only |

Each `.md` file is one fact. Filename is the slug (kebab-case, 1-64 chars). The body has YAML frontmatter followed by Markdown:

```markdown
---
name: project-build-cmd
description: Use pnpm not npm for installs and scripts.
type: project
---

This repository uses pnpm exclusively. Do not invoke npm or yarn.
```

Frontmatter keys:

- `name` — slug; must equal the filename without `.md`.
- `description` — single line, up to 240 chars. Shown in the rendered index.
- `type` — one of `user`, `feedback`, `project`, `reference`.

The body is plain Markdown, trimmed, capped at 4 KB.

`MEMORY.md` is a reserved filename: the loader skips it and the Memory tool refuses to write it.

## How the Agent Sees Memory

At the start of every turn, kimi-code re-renders a budgeted index of all facts and injects it into the agent's system prompt under a `# Memory` section. Project entries appear before User entries; project entries shadow user entries on slug collision. The index is capped at 8 KB — entries that do not fit are dropped from the rendered view (User first, then Project, both reverse-alpha). Dropped facts stay on disk and remain visible via the Memory tool's `list` operation.

The agent curates memory through the builtin `Memory` tool. Operations: `view`, `list`, `read`, `write`, `update`, `delete`. Scope is explicit on every mutation and on every read. Subagents inherit the same rendered index when they spawn; a subagent's write becomes visible to its parent on the parent's next turn (when the system prompt re-renders).

## Slash Commands

### `/memory`

Opens a full-screen TUI browser over your existing chat. Use it to audit and curate stored facts.

Keys:

- `Up` / `Down` — navigate the list
- `Enter` — toggle the detail pane (frontmatter + body)
- `d` — delete the focused fact (with confirmation)
- `s` — cycle the scope filter (`all` → `user` → `project` → `all`)
- `Esc` / `q` — close and return to the editor

The browser does not poll; memory only changes through explicit tool calls or `/memory delete`.

### `/remember <text>`

Asks the agent to persist `<text>` as a memory fact. Internally this spawns a short subagent task that picks an appropriate slug, description, type, and scope, then invokes the Memory tool's `write` operation. Routing through the agent (rather than writing directly) keeps the frontmatter LLM-derived and consistent with how the agent would persist a fact on its own.

## What Gets Remembered

Good candidates for memory:

- User preferences that survive across projects (tone, package manager, indent width)
- Project conventions worth keeping across sessions (test runner, formatter config, build commands)
- Recurring user corrections so the agent stops repeating the same mistake
- Architectural decisions the user wants honored going forward

Poor candidates:

- Turn-scoped context — keep it in the reply
- Long content — use a Skill or `AGENTS.md`
- Secrets, API keys, tokens, credentials — these are stored on disk in plaintext

## Gitignore

Project-scope memory under `<project-root>/.kimi-code/memory/` is tracked by git by default. This is intentional: a team can commit shared conventions ("use pnpm, not npm") into the repo and benefit from them on every checkout.

If a project's memory is personal or sensitive, add this to the project `.gitignore`:

```
.kimi-code/memory/
```

User-scope memory lives in `~/.kimi-code/memory/` and is naturally local — git never sees it.

## Plan Mode

Under plan mode, the Memory tool's `write`, `update`, and `delete` operations are blocked by the plan-mode permission policy. Read operations (`view`, `list`, `read`) still succeed. Call `ExitPlanMode` before asking the agent to remember something while in plan mode.

## Limits (v1)

- Rendered index: 8 KB hard cap (entries dropped beyond this)
- Per-fact body: 4 KB hard cap (writes rejected beyond this)
- No vector search — memory is keyed by slug + frontmatter, not semantic similarity
- No auto-write on session end — every fact is an explicit Memory tool call
- No encryption at rest — bodies are plaintext on disk
- No cross-machine sync — use git for project scope; user scope is per-machine

## Internals

Implementation lives at `packages/agent-core/src/memory/` (loader, file store, format, slug validation). The Memory builtin tool is at `packages/agent-core/src/tools/builtin/state/memory.ts`. System-prompt integration is in `packages/agent-core/src/profile/context.ts` and `packages/agent-core/src/profile/default/system.md`. The rendered `MEMORY.md` index is never persisted to disk — it is recomputed from the per-fact files on every turn.
