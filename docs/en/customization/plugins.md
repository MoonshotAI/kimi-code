# Plugins

Plugins package reusable Kimi Code CLI behavior around a `plugin.json` manifest. A plugin can contribute skills, add plugin-specific instructions to those skills, declare a session-start skill, and declare MCP servers that the user can enable explicitly. Multi-harness repositories can put the same Kimi manifest under `.kimi-plugin/plugin.json` instead of occupying the repository root.

Kimi Code CLI plugins are data bundles, not arbitrary command runtimes. Installing a plugin does not execute plugin-provided Python, Node.js, Shell, or hook scripts. If a workflow needs external tools or live data, prefer skills that guide the agent to use existing Kimi Code tools, or declare an MCP server and enable it explicitly.

## Installing and managing plugins

Use `/plugins` inside the TUI:

```sh
/plugins
/plugins install /absolute/path/to/plugin
/plugins install ./relative-plugin
/plugins install https://example.com/plugin.zip
/plugins info <id>
/plugins enable <id>
/plugins disable <id>
/plugins remove <id>
/plugins reload
/plugins mcp enable <id> <server>
/plugins mcp disable <id> <server>
```

Local directories are registered in `installed.json`; they are not copied. Zip URLs are downloaded, extracted, and stored under Kimi Code CLI's managed plugin directory. Removing a plugin only removes the install record; it does not delete the original local source directory.

Plugin changes apply to new sessions. After installing, enabling, disabling, removing, reloading, or enabling a plugin MCP server, start a fresh session with `/new` for the change to affect the available skills, `sessionStart.skill`, and MCP servers. Existing sessions keep the snapshot they started with.

`/plugins reload` re-reads `installed.json` and each plugin manifest so that `/plugins` and `/plugins info <id>` show the latest install state and diagnostics. It is not a hot reload for the current session's skills or MCP connections.

## Manifest format

Kimi Code CLI treats a root `plugin.json` as the primary plugin manifest:

```text
<plugin_root>/plugin.json
```

If `plugin.json` is absent, Kimi Code CLI reads the Kimi-scoped manifest:

```text
<plugin_root>/.kimi-plugin/plugin.json
```

Kimi Code CLI does not read `.codex-plugin/plugin.json`. If both `plugin.json` and `.kimi-plugin/plugin.json` exist, the root `plugin.json` wins and the `.kimi-plugin` manifest is shown as shadowed in `/plugins info`.

A typical plugin manifest looks like this:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kimi Code CLI",
  "keywords": ["finance", "mcp"],
  "skills": "./skills/",
  "sessionStart": {
    "skill": "using-finance"
  },
  "skillInstructions": "Prefer finance MCP tools for live market data. Do not invent live prices.",
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  },
  "interface": {
    "displayName": "Kimi Finance",
    "shortDescription": "Market data and financial analysis workflows"
  }
}
```

Supported fields:

| Field | Description |
| --- | --- |
| `name` | Required plugin id source. Must match `[a-z0-9][a-z0-9_-]{0,63}`. |
| `version`, `description`, `keywords`, `author`, `homepage`, `license` | Display metadata. |
| `skills` | One path or an array of paths. Each path must start with `./` and stay inside the plugin root after symlinks are resolved. |
| root `SKILL.md` | If `skills` is omitted and the plugin root contains `SKILL.md`, the root is treated as a single skill root. |
| `sessionStart.skill` | Declaratively injects the named skill into the main agent at the start of a new or resumed session. |
| `skillInstructions` | Extra instructions prepended whenever a skill from this plugin is loaded. |
| `mcpServers` | MCP server declarations. They are displayed after install, but each server stays disabled until the user enables it. |
| `interface` | Display fields for `/plugins info`, such as `displayName`, `shortDescription`, `longDescription`, `developerName`, `capabilities`, `websiteURL`, and `defaultPrompt`. |

Unsupported legacy fields such as `tools`, `configFile`, `config_file`, `inject`, `bootstrap`, `hooks`, and `apps` are reported as diagnostics and ignored.

## Skills and session start

Plugin skills use the same `SKILL.md` format as ordinary [Agent Skills](./skills.md). The common layout is:

```text
my-plugin/
  plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` is a declarative session-start rule: it loads a skill into the main agent's context once at the start of a session. It does not execute code. Use it when the plugin needs to establish workflow rules before the first user task, such as mapping another tool harness's terminology to Kimi Code CLI tools.

`skillInstructions` stays next to the skill content whenever the skill is loaded, whether the skill was loaded by `sessionStart.skill`, by `/skill:<name>`, or by the model's automatic skill invocation.

## MCP servers in plugins

Plugin MCP servers reuse the same server schema as [MCP](./mcp.md). They can be stdio servers:

```json
{
  "mcpServers": {
    "finance": {
      "command": "uvx",
      "args": ["kimi-finance-mcp"]
    }
  }
}
```

Or HTTP servers:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

For stdio servers, `command` may be a command found on `PATH`, or a `./` path inside the plugin root. If `cwd` is set, it must also start with `./` and stay inside the plugin root. Plugin MCP servers inherit the current process environment; values written under `env` are literal overrides, not `${VAR}` interpolation.

Installing a plugin never starts its MCP servers. Enable a server explicitly:

```sh
/plugins mcp enable kimi-finance finance
/new
```

The enabled state is stored in `$KIMI_CODE_HOME/plugins/installed.json`. Once a new session starts, enabled plugin MCP servers go through the normal MCP lifecycle, status events, tool naming, and permission approval flow.

## Security model

Plugins are loaded conservatively:

- Only `plugin.json`, `.kimi-plugin/plugin.json`, and Markdown skill files are read during install and session startup.
- Plugin-provided scripts, commands, hooks, and legacy tool runtimes are not executed by the plugin loader.
- Plugin paths must stay inside the plugin root after symlinks are resolved.
- MCP servers declared by a plugin are opt-in and only start in a new session after `/plugins mcp enable`.
- Bad manifests or unsafe paths produce diagnostics shown by `/plugins info <id>` and do not crash unrelated sessions.
