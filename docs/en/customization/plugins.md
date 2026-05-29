# Plugins

Plugins package reusable Kimi Code CLI capabilities into installable units. A plugin can add [Agent Skills](./skills.md), load a skill at session start, and declare MCP servers for real tool access.

Use plugins when you need to share workflows, connect to external services, or install extensions from the official marketplace. Kimi Code CLI loads plugins conservatively: installing a plugin does not run Python, Node.js, shell, hook, or command scripts bundled with it.

## Installing and managing plugins

Run `/plugins` in the TUI to open the plugin manager. From there you can install plugins, browse the official marketplace, inspect plugin details, enable or disable plugins, remove them, reload install records, and manage MCP servers.

Useful keys:

| Key | Action |
| --- | --- |
| `Enter` or `→` | Open the selected item, or install the selected marketplace plugin. |
| `Space` | Enable or disable an installed plugin; install or update a marketplace plugin. |
| `M` | Manage MCP servers for the selected plugin. |
| `←` or `Esc` | Go back. |

Most users only need the interactive manager. You can also use these slash commands directly:

| Command | Description |
| --- | --- |
| `/plugins` | Open the interactive plugin manager. |
| `/plugins list` | List installed plugins. |
| `/plugins install <path-or-url>` | Install from a local directory (relative paths and `~/` supported), a zip URL, or a GitHub repository URL. |
| `/plugins marketplace [source]` | Browse the official marketplace; optionally pass a marketplace JSON path or URL. |
| `/plugins info <id>` | Show plugin details and diagnostics; opens the manager when `<id>` is omitted. |
| `/plugins <id>` | Show details for a plugin; same as `/plugins info <id>`. |
| `/plugins enable <id>` | Enable a plugin; opens the manager when `<id>` is omitted. |
| `/plugins disable <id>` | Disable a plugin; opens the manager when `<id>` is omitted. |
| `/plugins remove <id>` | Remove a plugin; requires confirmation. |
| `/plugins reload` | Reload `installed.json` and each plugin manifest. |
| `/plugins mcp enable <id> <server>` | Enable an MCP server declared by a plugin. |
| `/plugins mcp disable <id> <server>` | Disable an MCP server declared by a plugin. |

For general slash command behavior, see [Slash commands](../reference/slash-commands.md).

GitHub URLs accept four forms. The bare URL `https://github.com/<owner>/<repo>` installs the repository's latest GitHub release; if the repo has no release, the default branch is installed instead. `https://github.com/<owner>/<repo>/tree/<ref>` installs a specific branch, tag, or short commit SHA. `https://github.com/<owner>/<repo>/releases/tag/<tag>` and `https://github.com/<owner>/<repo>/commit/<sha>` pin to an explicit tag or commit. Network calls go to `github.com` redirects and `codeload.github.com` archive downloads only; `api.github.com` is not used.

The plugin manager shows each install's source and a trust badge. `kimi-official` marks plugins installed from the Kimi marketplace at the `official` tier; `curated` marks marketplace plugins at the `curated` tier; `third-party` marks anything else, including any plugin you installed directly with `/plugins install <url>` or from a local directory. A re-install replaces the badge to reflect the new source.

Kimi Code CLI currently installs plugins per user. Records are stored under `$KIMI_CODE_HOME/plugins/` and apply across all projects. Project-local, repository-shared, admin-managed, and `--scope` installs are not supported yet.

Plugin changes apply to new sessions only. After installing, enabling, disabling, removing, or reloading a plugin, or changing an MCP server toggle, start a fresh session with `/new`. The current session is not updated; new skills, session-start behavior, and MCP servers load only in new sessions.

Local installs are copied into `$KIMI_CODE_HOME/plugins/managed/<id>/`, and Kimi Code CLI always runs from that managed copy. Editing the original source directory after install has no effect until you reinstall — `/plugins reload` re-reads install records and manifests, not the original source. Removing a plugin deletes only its install record; the managed copy and the original source files are left on disk.

## Plugin manifest

A plugin is a directory or zip file with a manifest at one of these paths:

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

When both files exist, `kimi.plugin.json` takes precedence. Kimi Code CLI does not read root `plugin.json` or `.codex-plugin/plugin.json`.

Example:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "description": "Finance data and analysis workflows for Kimi Code CLI",
  "skills": "./skills/",
  "sessionStart": {
    "skill": "using-finance"
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
| `name` | Required plugin id. Must match `[a-z0-9][a-z0-9_-]{0,63}`. |
| `version`, `description`, `keywords`, `author`, `homepage`, `license` | Display metadata. |
| `interface` | Fields shown in `/plugins`, such as `displayName`, `shortDescription`, `longDescription`, `developerName`, and `websiteURL`. |
| `skills` | One or more `./` paths inside the plugin root. If omitted, a root `SKILL.md` is treated as a single skill root. |
| `sessionStart.skill` | Loads the named plugin skill into the main agent at the start of a new or resumed session. |
| `skillInstructions` | Extra instructions included whenever a skill from this plugin is loaded. |
| `mcpServers` | MCP server declarations. Enabled by default; can be disabled from `/plugins`. |

Unsupported runtime fields such as `tools`, `commands`, `hooks`, `apps`, `inject`, `configFile`, `config_file`, and `bootstrap` are reported as diagnostics and ignored.

## Skills and session start

Plugin skills use the same `SKILL.md` format as ordinary [Agent Skills](./skills.md). A common layout:

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` loads one plugin skill into the main agent at session startup. It is useful for setup instructions, workflow rules, or mapping terminology from another tool to Kimi Code CLI. It injects text only and does not execute code.

`skillInstructions` is included with every skill from the plugin, whether the skill is loaded by `sessionStart.skill`, by `/skill:<name>`, or by automatic skill invocation.

## MCP servers in plugins

Use `mcpServers` when a plugin needs real tool access, such as reading data from an external service or running a local helper process. Plugin MCP servers use the same schema as [MCP](./mcp.md).

Stdio server:

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

HTTP server:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

For stdio servers, `command` may be a command on `PATH` or a `./` path inside the plugin root. If `cwd` is set, it must also start with `./` and stay inside the plugin root; other values are rejected and the server is omitted. Plugin MCP servers inherit the current process environment; values under `env` are literal overrides.

Plugin MCP servers start only in new sessions. To disable or re-enable one, run `/plugins`, select the plugin, and press `M`. Shortcut commands are also available:

```sh
/plugins mcp disable kimi-finance finance
/new

/plugins mcp enable kimi-finance finance
/new
```

## Security model

Plugins expose a limited loading surface:

- Install and session startup read only plugin manifests and Markdown skill files.
- All paths must stay inside the plugin root after symlinks are resolved.
- Command-backed plugin tools, hooks, and legacy tool runtimes are not executed by the plugin loader.
- MCP servers declared by enabled plugins start only in new sessions and can be disabled from `/plugins`.
- Bad manifests or unsafe paths produce diagnostics in `/plugins info <id>` without crashing unrelated sessions.
