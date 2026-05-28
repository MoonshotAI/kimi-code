Use this tool to read and curate durable cross-session memory. Memory is a set of small Markdown facts, each in its own file under `<scope>/.kimi-code/memory/`. A rendered index of those facts is already injected into your system prompt under the `# Memory` section.

**When to use:**
- Persisting a user preference that should apply in future sessions (e.g. "use pnpm not npm")
- Recording a project convention worth remembering across sessions (e.g. "Biome with 2-space indent")
- Capturing recurring user corrections so you stop making the same mistake
- Logging an architectural decision the user wants you to honor going forward

**When NOT to use:**
- Turn-scoped context — keep it in your reply, do not write a fact
- Long content — use a Skill or `AGENTS.md`; per-fact bodies are capped at 4 KB
- Secrets, API keys, tokens, credentials — these end up on disk in plaintext

**Scopes (explicit, never inferred):**
- `user` — preferences that follow the user across all projects (`~/.kimi-code/memory/`)
- `project` — facts specific to this repository (`<project-root>/.kimi-code/memory/`)
- Project entries override User entries on slug collision in the rendered index. The user-scope fact stays on disk and is still addressable via `read` / `list scope="user"`.
- `scope` is required on `read`, `write`, `update`, `delete`. `view` takes no params. `list` accepts an optional `scope` filter.

**Operations:**
```
view                                                       # rendered index, same as in your system prompt
list scope="project"                                       # full untruncated listing (use when the index was budget-truncated)
read  scope="project" name="build-commands"                # full body + frontmatter
write scope="project" record={name,description,type} body  # create a new fact (fails if the slug exists)
update scope="project" name="..." record={...}? body?      # partial frontmatter merge + body replace
delete scope="project" name="..."                          # remove the fact
```

**Hygiene:**
- Prefer `update` over `write` when refining an existing fact. A near-duplicate slug is harder to reconcile than an in-place edit.
- Delete superseded facts. Outdated memory is worse than missing memory.
- Keep `description` under 80 chars where possible. Descriptions are what fit in the 8 KB rendered index; long ones get truncated out first.
- One fact per concept. Do not concatenate unrelated preferences into a single body.

**Project memory may be committed to git.** `<project-root>/.kimi-code/memory/` is tracked by default. If a project fact is personal or sensitive, advise the user to add `.kimi-code/memory/` to their project `.gitignore`.

**Subagent visibility lags one turn.** A subagent's `write` is visible to its parent only on the parent's NEXT turn — the system prompt is re-rendered between turns, not mid-turn. Do not assume intra-turn coherence between a subagent's write and your own read.

**Plan mode blocks writes.** Under plan mode, `write` / `update` / `delete` are refused; call `ExitPlanMode` first. `view` / `list` / `read` still succeed.

**Reserved filename.** `MEMORY.md` in any scope directory is skipped by the loader and refused by `write`. Do not use the slug `memory`.

Slugs are lowercase kebab-case, 1-64 chars, no leading or trailing hyphen. Per-fact bodies are capped at 4 KB. The rendered index is capped at 8 KB — entries that do not fit are dropped from the index but remain on disk and visible via `list`.
