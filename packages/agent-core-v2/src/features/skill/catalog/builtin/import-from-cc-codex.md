---
name: import-from-cc-codex
description: Import Claude Code and Codex instructions, skills, and MCP settings into Kimi Code.
disable-model-invocation: true
---

# Import from Claude Code and Codex

The user invoked `/import-from-cc-codex` (or `/skill:import-from-cc-codex`).
Help them migrate selected local Claude Code and Codex assets into Kimi Code.
This skill is intentionally conservative: it imports only instructions, skills,
and MCP server declarations, with a user preview before any write.

## Non-negotiable rules

- Do **not** migrate `.agents` content (`~/.agents/**`, `<project>/.agents/**`).
  Kimi Code already reads `~/.agents/skills`, `~/.agents/AGENTS.md`, and
  `<project root>/.agents/skills`; Codex now stores its own skills and plugins
  there too.
- Do **not** migrate Claude custom commands (`.claude/commands/**`), custom
  agents/subagents (`.claude/agents/**`, `.codex/agents/**`), hooks, plugins
  (`.claude-plugin/**`, `.agents/plugins/**`, `$CODEX_HOME/plugins/**`), output
  styles, permissions/settings, auto-memory, or Codex `requirements.toml` /
  profile overlays (`$CODEX_HOME/<profile>.config.toml`).
- Do **not** migrate credentials, OAuth tokens, sessions, history, or logs.
- Do **not** run or install anything from the source directories.
- Do **not** write anything until the user has chosen what to migrate, reviewed
  the final preview, and explicitly confirmed applying it.
- Only write under Kimi Code targets:
  - User-global: `$KIMI_CODE_HOME` if set, otherwise `~/.kimi-code`.
  - Project instructions: `<dir>/.kimi-code/AGENTS.md`, where `<dir>` is the
    project root or one of the directories between the project root and the
    current working directory. The project root is the nearest parent
    directory containing `.git`; if no `.git` exists, use the current working
    directory.
  - Project skills: `<project root>/.kimi-code/skills/`.
  - Project-local MCP: `<cwd>/.kimi-code/mcp.json`, because Kimi reads the
    current working directory's Kimi-specific MCP file, not every project-root
    `.kimi-code/mcp.json` from subdirectories.
- Preserve existing Kimi files. Never overwrite existing skills or replace an
  existing AGENTS.md / mcp.json wholesale.

## Source locations

Resolve paths explicitly; `~` is the real OS home.

- Claude Code config dir: `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`.
  Call it `<claude home>` below. Claude's user config file is
  `<claude home>/.claude.json` when `CLAUDE_CONFIG_DIR` is set, otherwise
  `~/.claude.json`.
- Codex home: `$CODEX_HOME` if set, otherwise `~/.codex`. Call it
  `<codex home>` below.
- Kimi home: `$KIMI_CODE_HOME` if set, otherwise `~/.kimi-code`.

Check the environment variables with Bash before scanning; do not assume the
defaults.

## Conversation flow

### 1. Ask what to migrate first

Before reading source files, ask the user which categories to migrate. Use
`AskUserQuestion` when available; otherwise ask in plain text and stop. Offer a
multi-select choice:

- Instructions (`CLAUDE.md`, Claude rules, Codex `AGENTS.override.md`)
- Skills
- MCP settings
- All of the above

If the user already gave a preference in the invocation arguments, present it as
the default/recommended choice, but still ask for confirmation of the categories.
If the user dismisses or refuses the question, stop.

### 2. Scan only the chosen categories

User-level sources:

- Claude instructions:
  - `<claude home>/CLAUDE.md`
  - `<claude home>/rules/*.md` (recursive)
- Claude skills:
  - `<claude home>/skills/`
- Claude MCP candidates:
  - `<claude home>/.claude.json` (or `~/.claude.json`) only when MCP is
    selected. Claude Code stores user-level and project-local MCP declarations
    there; do not read it for instruction/skill-only imports.
- Codex instructions:
  - `<codex home>/AGENTS.override.md` if present and non-empty, otherwise
    `<codex home>/AGENTS.md`. Codex reads only the first one that qualifies.
- Codex skills:
  - `<codex home>/skills/`, skipping the `.system` directory (Codex-bundled
    system skills).
- Codex MCP candidates:
  - `<codex home>/config.toml`

Project-level sources. Walk every directory from the project root down to the
current working directory (inclusive); both Claude Code and Codex load
instructions from each level.

- Claude instructions, per directory `<dir>`:
  - `<dir>/CLAUDE.md`
  - `<dir>/.claude/CLAUDE.md`
  - `<dir>/CLAUDE.local.md` (private, usually gitignored)
  - `<dir>/.claude/rules/*.md` (recursive)
- Claude skills, per directory `<dir>`:
  - `<dir>/.claude/skills/`
- Codex skills, per directory `<dir>`:
  - `<dir>/.codex/skills/` (still supported by Codex project config layers)
- Codex instructions, per directory `<dir>`. Codex takes the first file that
  exists in this order and ignores the rest for that directory:
  - `<dir>/AGENTS.override.md`
  - `<dir>/AGENTS.md` (Kimi-readable; never imported, but its presence means
    the fallback names below are inactive in `<dir>`)
  - any filename listed under `project_doc_fallback_filenames` in a Codex
    `config.toml`, only when neither file above exists in `<dir>` and the
    name is not already covered by another source in this list
- Codex MCP candidates, per directory `<dir>`:
  - `<dir>/.codex/config.toml` (Codex applies these layers only when the
    project is trusted; import them regardless, the user chose them)

Do not scan `AGENTS.md` / `agents.md`, `.agents/**`, or project-root
`.mcp.json` in this skill: Kimi already reads plain `AGENTS.md` files,
`<project root>/.agents/skills`, `~/.agents/skills`, `~/.agents/AGENTS.md`,
and the project-root `.mcp.json`. `.claude/AGENTS.md`, `.codex/AGENTS.md`,
and `.codex/CLAUDE.md` are not standalone instruction entrypoints; do not
scan them independently. Follow them when a supported instruction source
resolves to them through a symlink or an `@path` import.

Claude Code also reads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/`, and
`CLAUDE.local.md` from every directory above the project root, up to the
filesystem root (its `.claude/skills/` walk stops at the git root). Do not
import those; if any exist, list them under warnings as "outside the project,
not imported" so the user can decide.

### 3. Build an import plan

Create a plan with three sections: instructions, skills, and MCP. Include exact
source and target paths.

#### Instructions plan

Map user-level instruction sources to:

- `$KIMI_CODE_HOME/AGENTS.md`, or `~/.kimi-code/AGENTS.md` if the env var is not
  set.

Map project-level instruction sources found in `<dir>` to:

- `<dir>/.kimi-code/AGENTS.md`

Kimi reads `.kimi-code/AGENTS.md` at each level from the project root to the
current working directory, so the imported file keeps the directory scope it
had in Claude Code or Codex.

Plan all selected instruction sources, including symlinks and `@AGENTS.md`
imports. Check content duplication after applying the import, as described
below; a matching filename or source content alone is not proof of coverage.

When importing an `AGENTS.override.md`, warn that Codex used it *instead of*
the `AGENTS.md` in the same directory, while Kimi will read both; ask the user
to check the two for conflicting instructions.

Claude rules (`rules/*.md`) may carry a `paths:` frontmatter list of globs that
scopes the rule to matching files. Kimi has no path-scoped rules:

- If the rule has no `paths`, import its body (without the frontmatter) into
  the target for the directory that owns the `rules/` folder.
- If its frontmatter contains `paths`, skip it and report the source path and
  globs. Explain that a directory-level AGENTS.md cannot preserve file-pattern
  conditions, and that the rule needs manual adaptation. This also applies to
  user-level rules and empty `paths` lists; do not automatically broaden or
  narrow their scope.

Claude Code expands `@path` import lines (`@./docs/style.md`, `@~/notes.md`)
inside `CLAUDE.md` files, ignoring `@` inside fenced code blocks, inline code
spans, and HTML comments. Kimi does not expand imports at all. For each
imported block that contains such lines, inline the referenced file's content
in place of the line when the file exists, is a text file, and lives inside
the project root or the user's home; otherwise leave the line unchanged and
warn that Kimi will not expand it. Follow imports at most 5 levels deep, and
never follow a path outside those boundaries.
Resolve relative imports from the file containing the import, including
`@AGENTS.md` and `@./AGENTS.md`.

Warn when a `CLAUDE.local.md` is imported: `.kimi-code/AGENTS.md` is not
private by convention, so the user may want to gitignore `.kimi-code/`.

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

Map project-level skill sources (from any `<dir>/.claude/skills/` or
`<dir>/.codex/skills/`) to:

- `<project root>/.kimi-code/skills/`

Both Claude Code and Codex load only directory bundles: `<skill-name>/SKILL.md`
(the directory may be a symlink). A loose `<name>.md` file under a skills
directory is ignored by both tools, so do not import it; report it as skipped.

Copy the entire directory bundle. Preserve supporting files inside bundles. Do
not copy hidden directories, `node_modules`, or caches. Skip these entries and
report them:

- `<claude home>/skills/synced/` (the claude.ai account-sync root; its
  contents are a read-only cache).
- `<codex home>/skills/.system/`.

A bundle that contains `.claude-plugin/plugin.json` is a plugin-managed skill.
Claude Code loads it unless that plugin is disabled under `enabledPlugins` in
its settings. Import it like any other bundle (the hidden `.claude-plugin/`
directory is not copied), but warn that it is plugin-managed and may have been
disabled in Claude Code.

Before planning a copy:

- Read a bundle's `SKILL.md` enough to verify that it has frontmatter with
  non-empty `name` and `description`, because Kimi requires those fields for
  directory skills. Claude Code falls back to the directory name when `name` is
  missing; Kimi does not.
- If the target top-level entry already exists, skip it; do not overwrite.
- If two source entries would write the same target path, keep the first one in
  this order and report the later one as skipped:
  1. project Claude (closest directory to the current working directory first)
  2. project Codex (closest directory to the current working directory first)
  3. user Claude
  4. user Codex
- Warn when a `SKILL.md` uses fields or syntax that Kimi does not interpret
  the same way. Preserve the file; do not rewrite it unless the user
  explicitly asks.
  - Kimi honors `name`, `description`, `when_to_use` (or `when-to-use`),
    `disable-model-invocation`, and `arguments` (a list or a space-separated
    string of argument names). Argument placeholders use the same syntax as
    in Claude Code (the dollar-prefixed `ARGUMENTS` placeholder, its `[N]`
    indexed form, positional `$N`, and declared argument names), so they need
    no warning. Kimi's skill-directory and session-ID placeholders are named
    `KIMI_SKILL_DIR` and `KIMI_SESSION_ID`, written in the same dollar-brace
    form as Claude's `${CLAUDE_SKILL_DIR}`.
  - Claude-only: `allowed-tools`, `disallowed-tools`, `context: fork`, `agent`,
    `background`, `model`, `effort`, `hooks`, `paths`, `user-invocable`,
    `argument-hint`, `${CLAUDE_SKILL_DIR}` (suggest Kimi's `KIMI_SKILL_DIR`
    placeholder), `${CLAUDE_SESSION_ID}` (suggest Kimi's `KIMI_SESSION_ID`
    placeholder), `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_EFFORT}`, and dynamic
    shell injection with ``!`command` ``.
  - Codex-only: `agents/openai.yaml` metadata inside the bundle.
- If the user would rather not copy, mention once that Kimi can also read the
  source directory in place through `extra_skill_dirs` in `config.toml`; do
  not configure it from this skill.

Do not convert `.claude/commands/*.md`. Commands are out of scope.

#### MCP plan

Do not edit `mcp.json` directly in this import skill. Prepare MCP entries for
manual follow-up with `/mcp-config`; that built-in skill is user-invocable only,
so you must not try to call it through the `Skill` tool.

For the preview, collect MCP candidates and normalize them into Kimi's MCP shape
when possible. Kimi infers the transport from `command` (stdio) vs `url`
(http); write `"transport": "sse"` only for SSE servers:

```json
{
  "mcpServers": {
    "name": {
      "command": "...",
      "args": ["..."],
      "env": { "KEY": "VALUE" },
      "cwd": "...",
      "enabled": true,
      "deferred": false,
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 60000,
      "enabledTools": ["..."],
      "disabledTools": ["..."]
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "X-Header": "value" },
      "bearerTokenEnvVar": "EXAMPLE_TOKEN",
      "auth": "oauth"
    }
  }
}
```

Kimi's stdio servers inherit the parent process environment and then apply
`env` on top, so pass-through declarations (Codex `env_vars`, Claude
`"KEY": "${KEY}"`) need no Kimi equivalent; drop them and note that the
variable is inherited.

Kimi does not expand `${VAR}` or `${VAR:-default}` placeholders in `mcp.json`.
Apply these rules to placeholders found in Claude entries:

- An `Authorization: Bearer ${VAR}` header becomes `bearerTokenEnvVar: "VAR"`.
- `"KEY": "${KEY}"` in `env` is dropped (inherited, see above).
- Any other placeholder in `command`, `args`, `env`, `url`, or `headers` blocks
  that entry: list the variable names and tell the user to substitute real
  values by hand. Never substitute a secret's current value into the preview.

Claude Code MCP (user file `.claude.json`):

- Read it only if MCP was selected.
- Top-level `mcpServers` holds user-scope servers.
- `projects["<absolute path>"].mcpServers` holds local-scope servers for one
  project. Claude keys this by the git repository root when the project is a
  repository, otherwise by the directory it was launched from; look up the
  project root first, then the current working directory (compare resolved
  paths).
- Read `disabledMcpServers` from that project's object before normalizing
  candidates. Skip any Claude user-scope or local-scope candidate whose name
  is listed there, and report it as "disabled in the source project; not
  imported". This is a project-specific choice, so do not turn it into a
  user-global `enabled: false` entry or silently re-enable the server.
- Entry shape: optional `type` (`stdio` default, `sse`, `http`,
  `streamable-http`), `command`, `args`, `env`, `url`, `headers`, `timeout`
  (milliseconds per tool call), `alwaysLoad`, `tools`, `role`,
  `request_timeout_ms`, `headersHelper`.
- Map Claude fields to Kimi fields:
  - `type: stdio` or absent with `command` -> stdio entry
  - `type: http` / `streamable-http` -> http entry
  - `type: sse` -> `transport: "sse"`
  - `command`, `args`, `env`, `url`, `headers` -> same names
  - `timeout` -> `toolTimeoutMs`
  - `alwaysLoad: true` -> `deferred: false`
- Drop entries with `type` `ws`, `sdk`, `claudeai-proxy`, `sse-ide`, or
  `ws-ide` and report them; Kimi has no such transports.
- Drop `tools` (per-tool permission policy), `role`, `request_timeout_ms`, and
  `headersHelper`, and report them.
- Do not import project-root `.mcp.json`; Kimi already reads it. Warn,
  however, when `.claude/settings.json` or `.claude/settings.local.json`
  lists one of its servers under `disabledMcpjsonServers`: Claude rejected
  that server, while Kimi will start every `.mcp.json` server. Suggest a
  complete server entry with `"enabled": false` in
  `<cwd>/.kimi-code/mcp.json`; an entry containing only `enabled` is invalid.

Codex MCP (`config.toml`):

- Read selected `config.toml` files only if MCP was selected.
- Look for `[mcp_servers.<name>]` tables.
- Map Codex fields to Kimi fields:
  - `command` -> `command`
  - `args` -> `args`
  - `env` -> `env`
  - `cwd` -> `cwd`
  - `url` -> `url`
  - `bearer_token_env_var` -> `bearerTokenEnvVar`
  - `http_headers` -> `headers`
  - `auth = "oauth"` -> `auth: "oauth"` (also Codex's default; omit when absent)
  - `enabled` -> `enabled`
  - `enabled_tools` -> `enabledTools`
  - `disabled_tools` -> `disabledTools`
  - `startup_timeout_sec` (may be fractional) -> `startupTimeoutMs`
  - `startup_timeout_ms` -> `startupTimeoutMs`
  - `tool_timeout_sec` -> `toolTimeoutMs`
- Drop the entry and report it when `environment_id` is set to anything other
  than `local` (the server runs in a Codex remote environment) or when `auth`
  is `chatgpt` or `ema_auth` (OpenAI-specific sign-in flows).
- Never copy a literal `bearer_token` (current Codex rejects it too); tell the
  user to move it into an environment variable and use `bearerTokenEnvVar`.
- Drop unsupported Codex-only fields and report them: `required`,
  `startup_readiness`, `supports_parallel_tool_calls`,
  `tool_input_schema_max_bytes`, `omit_tools_from`,
  `default_tools_approval_mode`, `tools.<tool>.approval_mode`,
  `tools.<tool>.output_token_limit`, `env_http_headers`,
  `http_headers_helper`, `scopes`, `oauth.*`, `oauth_resource`, and the
  legacy `name`.
- Every timeout must end up as an integer between 1 and 2147483647
  milliseconds.

For each MCP candidate, choose the target scope in the preview:

- User-level source -> user-global MCP target (`$KIMI_CODE_HOME/mcp.json` or
  `~/.kimi-code/mcp.json`).
- Project-level source (Claude local scope, `<dir>/.codex/config.toml`) ->
  project-local Kimi MCP target (`<cwd>/.kimi-code/mcp.json`). If `<cwd>` is
  not the project root, call this out in the preview so the user understands
  when Kimi will load it.

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
- Will copy skill bundles
- Will leave these MCP entries pending for a manual `/mcp-config` follow-up
- Already present / skipped, including path-scoped rules and disabled MCP
  candidates with their reasons
- Newly appended instruction blocks will be checked for duplication after
  import; only proven duplicates added by this import may be removed
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

### 6. Check instruction duplication after import

Before the final report, read back the instruction targets and check each
newly appended block against content Kimi actually loads in the same or a
broader scope:

- User-global instructions: `<kimi home>/AGENTS.md` and the first readable,
  non-empty `~/.agents/AGENTS.md` or `~/.agents/agents.md`.
- Project instructions: those global files, plus each directory from the
  project root to the target's owning directory. At each level Kimi reads
  `.kimi-code/AGENTS.md` and the first readable, non-empty `AGENTS.md` or
  `agents.md`.

Compare trimmed, expanded block bodies with retained instruction content or
other retained block bodies. Remove only a block appended by this import
whose content is exactly duplicated by another retained copy in the same or
a broader scope. Preserve all pre-existing content and keep at least one
covering copy. A project file cannot cover a global block, and a descendant
file cannot cover an ancestor's block. An AGENTS.md beside a source in
`.claude` or `.codex` is not automatically loaded by Kimi.

If content is merely similar, conflicts, or its loading scope is uncertain,
keep the new block and report the uncertainty. Re-read targets after cleanup
to verify that each imported instruction remains covered, and report every
removed block with the path of the retained copy.

Report exactly what changed, what was skipped and why, and the duplication
check results. Tell the user to start a new session (for example `/new`) or
restart Kimi Code for newly imported skills and instructions to be picked up;
MCP import remains pending the manual `/mcp-config` follow-up.

## Output style

Be brief but precise. Use absolute paths in previews and summaries. Prefer a
small table or bullet list over long prose. If nothing is found for a selected
category, say so and do not treat it as an error.
