---
name: import-from-cc-codex
description: Import Claude Code and Codex instructions, skills, and MCP settings into Kimi Code.
disable-model-invocation: true
---

# Import from Claude Code and Codex

The user invoked `/import-from-cc-codex` (or `/skill:import-from-cc-codex`).
Help them migrate selected local Claude Code and Codex assets into Kimi Code.
This skill is intentionally conservative: it imports only instructions, skills,
and MCP server declarations from `.claude` / `.codex` surfaces, with a user
preview before any write.

## Non-negotiable rules

- Do **not** migrate `.agents` content. Kimi Code already supports `.agents`
  skills and AGENTS files by default.
- Do **not** migrate Claude custom commands (`.claude/commands/**`). They are
  out of scope for this importer.
- Do **not** migrate credentials, OAuth tokens, sessions, history, logs, hooks,
  plugins, plugin caches, output styles, or custom agents/subagents.
- Do **not** run or install anything from the source directories.
- Do **not** write anything until the user has chosen what to migrate, reviewed
  the final preview, and explicitly confirmed applying it.
- Only write under Kimi Code targets:
  - User-global: `$KIMI_CODE_HOME` if set, otherwise `~/.kimi-code`.
  - Project instructions/skills: `<project root>/.kimi-code`, where the project
    root is the nearest parent directory containing `.git`; if no `.git` exists,
    use the current working directory.
  - Project-local MCP: `<cwd>/.kimi-code/mcp.json`, because Kimi reads the
    current working directory's Kimi-specific MCP file, not every project-root
    `.kimi-code/mcp.json` from subdirectories.
- Preserve existing Kimi files. Never overwrite existing skills or replace an
  existing AGENTS.md / mcp.json wholesale.

## Conversation flow

### 1. Ask what to migrate first

Before reading source files, ask the user which categories to migrate. Use
`AskUserQuestion` when available; otherwise ask in plain text and stop. Offer a
multi-select choice:

- Instructions (`AGENTS.md` / `CLAUDE.md`)
- Skills
- MCP settings
- All of the above

If the user already gave a preference in the invocation arguments, present it as
the default/recommended choice, but still ask for confirmation of the categories.
If the user dismisses or refuses the question, stop.

### 2. Scan only the chosen categories

Resolve paths explicitly; `~` is the real OS home, and Kimi home follows
`$KIMI_CODE_HOME` before `~/.kimi-code`.

User-level sources:

- Claude instructions:
  - `~/.claude/AGENTS.md`
  - `~/.claude/CLAUDE.md`
- Claude skills:
  - `~/.claude/skills/`
- Claude MCP candidates:
  - `~/.claude.json` only when MCP is selected. Claude Code stores user-level
    MCP declarations there; do not read it for instruction/skill-only imports.
- Codex instructions:
  - `~/.codex/AGENTS.md`
  - `~/.codex/CLAUDE.md` if present
- Codex skills:
  - `~/.codex/skills/`
- Codex MCP candidates:
  - `~/.codex/config.toml`

Project-level sources, rooted at the project root:

- Claude instructions:
  - `<project root>/.claude/AGENTS.md`
  - `<project root>/.claude/CLAUDE.md`
- Claude skills:
  - `<project root>/.claude/skills/`
- Codex instructions:
  - `<project root>/.codex/AGENTS.md`
  - `<project root>/.codex/CLAUDE.md` if present
- Codex skills:
  - `<project root>/.codex/skills/`
- Codex MCP candidates:
  - `<project root>/.codex/config.toml`

Do not scan project-root `AGENTS.md`, project-root `CLAUDE.md`, `.agents/**`, or
project-root `.mcp.json` in this skill. `AGENTS.md` and `.agents/**` are already
Kimi-readable, and project-root `.mcp.json` is already read by Kimi as a
Claude-compatible MCP file.

### 3. Build an import plan

Create a plan with three sections: instructions, skills, and MCP. Include exact
source and target paths.

#### Instructions plan

Map user-level instruction sources to:

- `$KIMI_CODE_HOME/AGENTS.md`, or `~/.kimi-code/AGENTS.md` if the env var is not
  set.

Map project-level instruction sources to:

- `<project root>/.kimi-code/AGENTS.md`

Append imported instruction content as marked blocks. Do not duplicate a block
that already exists in the target file.

Use this marker shape:

```md
<!-- Imported from Claude Code: /absolute/source/path -->

<source content>

<!-- End imported from Claude Code: /absolute/source/path -->
```

For Codex, use `Imported from Codex` / `End imported from Codex`.

If a source file is empty, skip it and report it as skipped. If the target exists
and cannot be read as UTF-8 text, stop before writing and report the blocker.

#### Skills plan

Map user-level skill sources to:

- `$KIMI_CODE_HOME/skills/`, or `~/.kimi-code/skills/` if the env var is not set.

Map project-level skill sources to:

- `<project root>/.kimi-code/skills/`

Recognize these skill shapes under `.claude/skills/` or `.codex/skills/`:

- Directory bundle: `<skill-name>/SKILL.md`
- Flat markdown skill: `<skill-name>.md`

Copy the entire directory bundle or flat markdown file. Preserve supporting
files inside bundles. Do not copy hidden directories, `node_modules`, caches, or
plugin-managed folders.

Before planning a copy:

- Read a bundle's `SKILL.md` enough to verify that directory skills have
  frontmatter with non-empty `name` and `description`, because Kimi requires
  those fields for directory skills.
- If the target top-level entry already exists, skip it; do not overwrite.
- If two source entries would write the same target path, keep the first one in
  this order and report the later one as skipped:
  1. project Claude
  2. project Codex
  3. user Claude
  4. user Codex
- Warn when a source skill uses Claude/Codex-specific fields or syntax that Kimi
  may not interpret the same way, such as `allowed-tools`, `disallowed-tools`,
  `context: fork`, `agent`, `hooks`, `paths`, dynamic shell injection with
  ``!`command` ``, or `agents/openai.yaml`. Preserve the file; do not rewrite it
  unless the user explicitly asks.

Do not convert `.claude/commands/*.md`. Commands are out of scope.

#### MCP plan

Do not edit `mcp.json` directly in this import skill. Prepare MCP entries for
manual follow-up with `/mcp-config`; that built-in skill is user-invocable only,
so you must not try to call it through the `Skill` tool.

For the preview, collect MCP candidates and normalize them into Kimi's MCP shape
when possible:

```json
{
  "mcpServers": {
    "name": {
      "command": "...",
      "args": ["..."],
      "env": { "KEY": "VALUE" }
    }
  }
}
```

Claude user MCP:

- Read `~/.claude.json` only if MCP was selected.
- Look for a top-level `mcpServers` object.
- Keep stdio entries with `command`; keep HTTP entries with `url`.
- Preserve `args`, `env`, `cwd`, `enabled`, `enabledTools`, `disabledTools`,
  `startupTimeoutMs`, `toolTimeoutMs`, `headers`, and `bearerTokenEnvVar` when
  present and valid.
- Drop unsupported or malformed entries and report why.

Codex MCP:

- Read selected `config.toml` files only if MCP was selected.
- Look for `[mcp_servers.<name>]` tables.
- Map Codex fields to Kimi fields:
  - `command` -> `command`
  - `args` -> `args`
  - `env` -> `env`
  - `cwd` -> `cwd`
  - `url` -> `url`
  - `bearer_token_env_var` -> `bearerTokenEnvVar`
  - `enabled` -> `enabled`
  - `enabled_tools` -> `enabledTools`
  - `disabled_tools` -> `disabledTools`
  - `startup_timeout_sec` -> `startupTimeoutMs` in milliseconds
  - `tool_timeout_sec` -> `toolTimeoutMs` in milliseconds
  - `http_headers` -> `headers`
- Drop unsupported Codex-only fields and report them, especially `required`,
  `default_tools_approval_mode`, `tools.<tool>.approval_mode`,
  `env_vars`, `env_http_headers`, and `experimental_environment`.
- Do not import project-root `.mcp.json`; Kimi already reads it.

For each MCP candidate, choose the target scope in the preview:

- User-level source -> user-global MCP target (`$KIMI_CODE_HOME/mcp.json` or
  `~/.kimi-code/mcp.json`).
- Project-level source -> project-local Kimi MCP target (`<cwd>/.kimi-code/mcp.json`). If `<cwd>` is not the project root, call this out in the preview so the user understands when Kimi will load it.

Warn that stdio MCP entries spawn commands at session start, and the user should
only import MCP servers they trust. Warn if an MCP entry contains apparent
literal secrets in `env`, `headers`, or token-like fields; prefer env-var
references.

After the user confirms applying the final preview, do not write MCP config and
do not invoke `mcp-config` programmatically. Instead, finish the non-MCP writes
and show a copy-pasteable manual follow-up for the user, including:

- the `/mcp-config` command they should run,
- target scope and target path,
- the normalized JSON entry or entries to add,
- collision policy: keep existing Kimi entries on name conflict,
- the reminder that unrelated entries must be preserved.

Make it clear that MCP import is pending until the user manually runs
`/mcp-config` with the prepared entries.

### 4. Show the final preview and stop

After scanning, show a concise final preview grouped by target file/directory:

- Will append instruction blocks
- Will copy skill bundles/files
- Will leave these MCP entries pending for a manual `/mcp-config` follow-up
- Already present / skipped
- Warnings and blockers

Then ask for explicit confirmation before writing. Use a clear choice such as:

- Apply import
- Cancel

If there are blockers, do not offer apply; explain what must be fixed first.

### 5. Apply only after confirmation

When the user confirms:

- Create target directories with private permissions where possible.
- Append instruction blocks without duplicating existing imported source blocks.
- Copy skills without overwriting existing target entries.
- Do not write MCP entries. Show the prepared `/mcp-config` follow-up command
  and mark MCP import as pending user action.
- Report exactly what changed and what was skipped.
- Tell the user to start a new session (for example `/new`) or restart Kimi Code
  for newly imported skills, instructions, and MCP servers to be picked up.

## Output style

Be brief but precise. Use absolute paths in previews and summaries. Prefer a
small table or bullet list over long prose. If nothing is found for a selected
category, say so and do not treat it as an error.
