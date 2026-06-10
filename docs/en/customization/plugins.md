# Plugins

Plugins package reusable Kimi Code CLI capabilities into installable units — they can add [Agent Skills](./skills.md), automatically load a specified Skill at session start, and declare MCP servers to provide real tool capabilities. They are ideal for sharing workflows with a team, connecting to external services, or installing extensions from the official marketplace.

Kimi Code CLI applies a conservative loading strategy for plugins: installing a plugin does not execute any Python, Node.js, shell, hook, or command scripts it contains.

## Installation and Management

Run `/plugins` in the TUI to open the plugin manager, where you can perform all routine operations. Common keys:

| Key | Action |
| --- | --- |
| `Enter` or `→` | Open the selected item, or install a marketplace plugin |
| `Space` | Enable or disable an installed plugin; install or update a marketplace plugin |
| `M` | Manage MCP servers for the selected plugin |
| `←` or `Esc` | Go back to the previous level |

In the marketplace list, an installed plugin with a newer version available shows `update <local> → <latest>`, an up-to-date one shows `installed · v<version>`, and an uninstalled one shows `install v<version>`. Select an updatable entry and press `Enter` to update.

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

The plugin manager shows the installation source and a trust badge for each install: `kimi-official` (from an official address), `curated` (from a curated address), or `third-party` (everything else).

### Installing from GitHub

Use `/plugins install <url>` to install directly from a GitHub repository. Four URL forms are supported:

- `https://github.com/<owner>/<repo>`: Install the latest release; falls back to the default branch if no release exists
- `https://github.com/<owner>/<repo>/tree/<ref>`: Install a specific branch, tag, or short commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`: Pin to a specific tag
- `https://github.com/<owner>/<repo>/commit/<sha>`: Pin to a specific commit

Network requests only go through `github.com` redirects and `codeload.github.com` downloads; `api.github.com` is not called.

### Notes

- Plugin changes only take effect for new sessions. After installing, enabling/disabling, or removing a plugin, run `/reload` to reload plugins or `/new` to start a new session; the current session will not update.
- Local installations are copied to `$KIMI_CODE_HOME/plugins/managed/<id>/`, and the CLI always runs from this managed copy. Editing the original source directory after installation has no effect; you must reinstall.
- Removing a plugin only deletes the installation record; the managed copy and original source files remain on disk.
- Plugins are currently installed per-user and apply to all projects; project-level installation scope is not yet supported.

## Kimi Datasource

Kimi Datasource is the official Kimi Code data plugin. It lets you query financial market data, macroeconomic indicators, corporate registration records, and academic literature in natural language — no manual API calls or data account registration required.

### Installation

You must first complete OAuth login with a Kimi Code account via `/login`. The plugin relies on local credentials to access data services.

1. Run `/plugins` and select **Marketplace**
2. Find **Kimi Datasource** and press `Space` to install
3. After installation completes, run `/reload` to activate the plugin

### How to Use

Once installed, describe your need in natural language and Kimi Code will automatically invoke the data capabilities. You can also explicitly trigger the data query skill with `/skill:kimi-datasource`.

### What You Can Do

**Live market research**: Want to run a quantitative analysis on a stock? Pull three years of daily closing prices, MACD, and KDJ signals in a single query — no third-party data platforms needed.

**Cross-country macro comparison**: Studying supply-chain shifts across China, India, and Vietnam? Get complete GDP growth, trade volume, and demographic time-series from World Bank data spanning 50+ years, all in one go.

**Pre-contract risk check**: Need to vet a counterparty fast? Type the company name and instantly get business registration, equity structure, litigation disputes, and credit blacklist status — right when you need it.

**Literature review acceleration**: Tracing the research arc of RLHF? Get the most-cited papers, key authors, and core findings in seconds, so your literature review outline takes shape in half the time.

### Coverage

| Category | Scope |
|---|---|
| Stock market data | A-shares, HK, US, and major global markets — real-time/historical prices, technical indicators, financial statements, stock screening |
| Macroeconomic data | World Bank data for 189 countries, 50+ years of time series (GDP, trade, population, climate, and more) |
| Corporate data | Business registration, equity chain, legal risk, and related-entity graph for mainland Chinese companies |
| Academic literature | Millions of papers across physics, mathematics, CS, quantitative finance, economics — including preprints |

### Notes

- Data queries are billed per call and consume Kimi Code account credits
- The plugin provides read-only queries; no write or trading functionality is available
- Technical indicators and real-time prices are only available during active trading hours
- AI-generated output is for reference only and does not constitute investment or business advice

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

Plugin MCP servers only start in new sessions. To enable or disable a server:

```sh
/plugins mcp disable kimi-finance finance
/new

/plugins mcp enable kimi-finance finance
/new
```

## Security Model

Plugins have a limited loading scope. The following operations do not occur during installation or session startup:

- Command-type plugin tools, hooks, and legacy tool runtimes are not executed
- All paths must remain within the plugin root directory after symbolic link resolution
- MCP servers of enabled plugins only start in new sessions and can be disabled at any time from `/plugins`
- Broken manifests or unsafe paths appear in `/plugins info <id>` diagnostics and do not affect other sessions

## Next steps

- [Agent Skills](./skills.md) — File format and frontmatter field reference for Skills
- [MCP](./mcp.md) — Full schema and permission configuration for plugin MCP servers
