---
name: mcp-config
description: Configure MCP servers and handle MCP OAuth login.
---

# Interactive MCP server configuration

The user invoked this skill through `/mcp-config` or `/skill:mcp-config`.
Either they want to log into an MCP server that asked for OAuth, or they
want to edit the `mcp.json` that lists MCP servers. The work is small and
local — handle it on this turn yourself, no agents or planning todos.

Pick the flow from the user's message and your tool list:

- An `mcp__<server>__authenticate` tool is in your list, the user says
  "log in" / "auth" / "sign in", they invoke `/mcp-config login
  <server>`, or they quote a `needs-auth` status → **Login**.
- Add / edit / remove / list of an `mcp.json` entry → **Config edit**.
- Bare `/mcp-config` with no `authenticate` tool in your list →
  **Config edit**. If there were a pending login, the authenticate tool
  would be in your list.

## Login

Each MCP server in `needs-auth` exposes one `mcp__<server>__authenticate`
tool. Call it for the server the user means — its own description owns
the OAuth UX (printing the URL, blocking on the callback, reconnecting on
success). Surface its output verbatim, including the authorization URL
unchanged; the URL contains state and PKCE parameters that break if
edited.

If the user named a server that has no authenticate tool, say so in one
sentence and stop — do **not** fall into config edit. They're trying to
log in to a server that isn't currently waiting for login; quietly
rewriting `mcp.json` would be the wrong fix. If multiple authenticate
tools exist and the user didn't name one, ask which.

## Config edit

Config lives in three files; on key collision, later entries in this
precedence order override earlier ones:

- User-global: `~/.kimi-code/mcp.json` (or `$KIMI_CODE_HOME/mcp.json` if
  set). Use for servers you want everywhere.
- Project-root: `<project root>/.mcp.json`, where project root is found
  by walking up from `<cwd>` to the nearest `.git`. Use for
  Claude-compatible, repo-shared, or cross-agent servers.
- Project-local: `<cwd>/.kimi-code/mcp.json`. Use for Kimi-specific
  overrides in the current working directory.

Mention once that project-root and project-local stdio entries spawn
commands at session start, so they should only live in trusted repos.

All three files wrap their entries the same way:

```json
{ "mcpServers": { "<name>": { /* entry */ } } }
```

A minimal stdio entry needs `command` (+ optional `args`, `env`, `cwd`).
For project-root `.mcp.json`, stdio entries run from the project root by
default; relative `cwd` values are resolved against the directory that
contains `.mcp.json`.
A minimal http entry needs `url`; add `bearerTokenEnvVar: "ENV_NAME"` for
servers that authenticate with a static bearer token from the
environment. Servers that use OAuth take no token field — the login flow
above handles them. `transport` is inferred from `command` vs `url`, so
omit it. For less common fields (`enabled`, `startupTimeoutMs`,
`toolTimeoutMs`, `enabledTools`, `disabledTools`, `headers`) the source of
truth is `McpServerStdioConfigSchema` / `McpServerHttpConfigSchema` in
`packages/agent-core/src/config/schema.ts`.

If the user only wants to **see** what's configured, read all three files,
show a merged view with enough source-path context to inspect or remove a
server from the file that actually declared it, and stop — no scope
prompt, no write.

For changes, the flow is:

1. **Pick a scope.** Infer it from the user's words when you can
   (global / everywhere / all projects → user-global; root / repo /
   shared / cross-agent / Claude / `.mcp.json` → project-root; cwd /
   current directory / Kimi-specific / `.kimi-code` → project-local). When
   the request is genuinely scope-less, use one `AskUserQuestion` to ask
   user-global vs project-root vs project-local, defaulting to
   user-global. Use plain text for every other question — `AskUserQuestion`
   is a poor fit for free-form input. If the user dismisses the scope
   question, stop; you can't safely guess where they wanted the change.
2. **Read and announce.** Read the target file (a missing or empty file
   is fine; you'll create `{ "mcpServers": {} }`). If JSON parsing fails,
   surface the error verbatim and stop — silently overwriting a broken
   file could destroy work. Then show the user the target path, what's
   currently in it, and the entry you're about to write or delete. This
   is for transparency, not a confirmation gate — the Edit/Write
   permission prompt is the real gate, and your message is what gives
   the user context when that prompt appears. In yolo / afk modes there
   is no prompt, which is those modes' explicit contract.
3. **Write and tell them how to reload MCP servers.** Preserve unrelated
   entries and the `mcpServers` wrapper. MCP servers load at session
   start, so tell the user to start a new session (for example `/new`) or
   restart `kimi-code` for the change to take effect.

## Secrets

Don't store secrets (tokens, keys, passwords) as literals in
`mcp.json` — it's a plain config file on disk. http servers should use
`bearerTokenEnvVar` to reference an env var instead; if a stdio entry
must inline one in `env`, warn the user before writing.
