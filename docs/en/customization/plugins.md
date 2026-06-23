# Plugins

Plugins package reusable Kimi Code CLI capabilities into installable units — they can add [Agent Skills](./skills.md), automatically load a specified Skill at session start, and declare MCP servers to provide real tool capabilities. They are ideal for sharing workflows with a team, connecting to external services, or installing extensions from the official marketplace.

Kimi Code CLI applies a conservative loading strategy for plugins: installing a plugin does not execute any Python, Node.js, shell, hook, or command scripts it contains.

## Installation and Management

Run `/plugins` in the TUI to open the plugin manager. It is a single panel with four tabs — **Installed** (manage what you have), **Official** (Kimi-maintained marketplace plugins), **Third-party** (marketplace plugins from other publishers), and **Custom** (install from a URL) — switched with `Tab` / `Shift-Tab`. Common keys:

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | Switch between the Installed / Official / Third-party / Custom tabs |
| `Space` | Enable or disable the selected installed plugin (Installed tab) |
| `D` | Remove the selected installed plugin (Installed tab) |
| `M` | Manage MCP servers for the selected plugin (Installed tab) |
| `R` | Reload `installed.json` and all manifests (Installed tab) |
| `Enter` | Installed tab: view plugin details · Official/Third-party tab: install or update · Custom tab: install |
| `Esc` | Go back or cancel |

You can also use slash commands directly:

| Command | Description |
| --- | --- |
| `/plugins` | Open the interactive plugin manager |
| `/plugins list` | List installed plugins |
| `/plugins install <path-or-url>` | Install from a local directory, zip URL, or GitHub repository URL |
| `/plugins marketplace [source]` | Browse the official marketplace; optionally pass a path or URL to a marketplace JSON |
| `/plugins info <id>` | View plugin details and diagnostics |
| `/plugins enable <id>` | Enable a plugin |
| `/plugins disable <id>` | Disable a plugin |
| `/plugins remove <id>` | Remove a plugin (requires confirmation) |
| `/plugins reload` | Reload `installed.json` and all plugin manifests |
| `/plugins mcp enable <id> <server>` | Enable an MCP server declared by a plugin |
| `/plugins mcp disable <id> <server>` | Disable an MCP server declared by a plugin |

**GitHub URL supports four forms:**

- `https://github.com/<owner>/<repo>`: Install the latest release; falls back to the default branch if no release exists
- `https://github.com/<owner>/<repo>/tree/<ref>`: Install a specific branch, tag, or short commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`: Pin to a specific tag
- `https://github.com/<owner>/<repo>/commit/<sha>`: Pin to a specific commit

Network requests only go through `github.com` redirects and `codeload.github.com` downloads; `api.github.com` is not called.

The plugin manager shows each install's source and a trust badge. `kimi-official` marks plugin zips downloaded from `https://code.kimi.com/kimi-code/plugins/official/`; `curated` marks plugin zips downloaded from `https://code.kimi.com/kimi-code/plugins/curated/`. `third-party` marks anything else, including GitHub installs, local directories, custom marketplace sources, and other URLs. Marketplace `tier` is listing metadata; the installed trust badge still comes from the actual downloaded source.

The **Official** and **Third-party** tabs list the marketplace catalog by tier — **Official** holds Kimi-maintained plugins and **Third-party** holds plugins from other publishers. Installed entries are listed first. Both tabs load lazily — opening `/plugins` is instant and works offline; only switching to either tab fetches the catalog, and a fetch failure is shown inline on the tab instead of closing the panel. The **Custom** tab installs a plugin straight from a GitHub URL (or zip URL / local path), without it being a marketplace listing. `/plugins marketplace` opens directly on the Official tab.

By default, marketplace items are plugins: Kimi Code installs their `source` and tracks the install in `installed.json`.

For custom marketplace JSON, omit `type` or set `"type": "plugin"`, and provide a `source`. `source` may be a local path, a zip URL, or a GitHub repository URL. New CLIs accept `"type": "managed"` and the legacy `"type": "guide"` as aliases for `"plugin"`.

The marketplace JSON has a single `plugins` array. Do not split the same marketplace into separate old and new arrays. Old CLIs read the same list and ignore fields they do not understand.

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "type": "plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

The marketplace JSON is a versioned contract. Keep existing field meanings stable, add optional fields when possible, and decide how each change behaves across CLI versions:

| Case | Rule |
| --- | --- |
| New CLI with old marketplace JSON | Works: missing `type` defaults to `plugin`, `"managed"` is accepted as a legacy alias, and legacy `url` / `downloadUrl` fields are still accepted as source aliases. |
| Old CLI with new plugin items | Works from the same `plugins` array when the item provides `source` and the source uses a manifest path the old CLI already supports; old CLIs ignore fields they do not understand. |
| Legacy `"type": "guide"` items | Treated as a normal plugin install; any `installSkill` / `removeSkill` fields are ignored. |
| Existing installed records | Keep working; the `installed.json` and managed plugin directory contract is unchanged. |
| New entry types or install behavior | Keep a single `plugins` array where possible. Use `version`, parser defaults, field aliases, and clear rejection rules; only add a separate artifact or publishing gate when one array cannot stay compatible. |

If you operate a custom marketplace, apply the same rule to your own marketplace URL. Before changing fields or entry types, decide whether old CLIs should keep installing the same `plugins` list, ignore the new fields, or reject it with a clear error.

**A few notes:**

- Plugin changes apply after `/reload` or in new sessions. This includes newly installed or enabled Skills, same-name Skill updates, disabled or removed Skills, MCP servers, and `sessionStart.skill` changes.
- Local installations are copied to `$KIMI_CODE_HOME/plugins/managed/<id>/`, and the CLI always runs from this managed copy. Editing the original source directory after installation has no effect; you must reinstall.
- Removing a plugin only deletes the installation record; the managed copy and original source files remain on disk.
- Plugins are currently installed per-user and apply to all projects; project-level installation scope is not yet supported.

## Plugin Manifest

A plugin is a directory or zip file containing a manifest. The manifest can be placed at either of the following locations:

```text
<plugin_root>/kimi.plugin.json
<plugin_root>/.kimi-plugin/plugin.json
```

When both files exist, `kimi.plugin.json` takes precedence.

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
| `name` | Required; serves as the plugin id. Must match `[a-z0-9][a-z0-9_-]{0,63}` |
| `version`, `description`, `keywords`, `author`, `homepage`, `license` | Display metadata |
| `interface` | Fields shown in `/plugins`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `websiteURL` |
| `skills` | One or more `./` paths; must be within the plugin root directory. When omitted, the `SKILL.md` in the root directory is treated as a single Skill root |
| `sessionStart.skill` | Loads the specified plugin Skill into the main Agent when a new or resumed session starts |
| `skillInstructions` | Additional instructions appended whenever a Skill from this plugin is loaded |
| `mcpServers` | MCP server declarations; enabled by default, can be disabled from `/plugins` |

Unsupported runtime fields such as `tools`, `commands`, `hooks`, `apps`, `inject`, and `configFile` appear as diagnostics and are ignored.

## Skills and Session Start

Plugin Skills use the same `SKILL.md` format as ordinary [Agent Skills](./skills.md). A typical directory structure:

```text
my-plugin/
  kimi.plugin.json
  skills/
    using-my-plugin/
      SKILL.md
    another-workflow/
      SKILL.md
```

`sessionStart.skill` loads a plugin Skill into the main Agent at session start, making it suitable for initialization instructions, workflow rules, or mapping terminology from other tools to Kimi Code CLI. It only injects text; it does not execute code.

Regardless of how a Skill is loaded (`sessionStart.skill`, `/skill:<name>`, or automatic model invocation), `skillInstructions` appears alongside that plugin's Skill.

## MCP Servers in Plugins

When a plugin needs real tool capabilities, it can declare `mcpServers` in its manifest, reusing the [MCP](./mcp.md) schema.

Stdio server (local command):

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

HTTP server (remote service):

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

For stdio servers, `command` can be a command on `PATH` or a path starting with `./` within the plugin root directory. `cwd` likewise must start with `./` and be within the plugin root directory; otherwise the server is ignored.

Plugin MCP servers start after `/reload` or in new sessions. To enable or disable a server:

```sh
/plugins mcp disable kimi-finance finance
/reload

/plugins mcp enable kimi-finance finance
/reload
```

## Official Plugins

The Kimi Code CLI official marketplace hosts reviewed official plugins. Currently available:

**[Kimi Datasource](./datasource.md)** — Query financial market data, macroeconomic indicators, corporate registration records, and academic literature in natural language.

Installation:

1. Run `/plugins` and select **Official**
2. Find **Kimi Datasource** and press `Enter` to install
3. Run `/reload` or `/new` after installation

For data capabilities and usage examples, see the [Official Plugins documentation](./datasource.md).

## Security Model

Plugins have a limited loading scope. The following operations do not occur during installation or session startup:

- Command-type plugin tools, hooks, and legacy tool runtimes are not executed
- All paths must remain within the plugin root directory after symbolic link resolution
- MCP servers of enabled plugins start after `/reload` or in new sessions and can be disabled at any time from `/plugins`
- Broken manifests or unsafe paths appear in `/plugins info <id>` diagnostics and do not affect other sessions

## Next steps

- [Kimi Datasource](./datasource.md) — Official data plugin: installation and usage for financial market data, corporate records, and academic literature
- [Agent Skills](./skills.md) — File format and frontmatter field reference for Skills
- [MCP](./mcp.md) — Full schema and permission configuration for plugin MCP servers
