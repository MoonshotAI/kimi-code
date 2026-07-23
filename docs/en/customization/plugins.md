# Plugins

Plugins package reusable Kimi Code CLI capabilities into installable units — they can add [Agent Skills](./skills.md), automatically load a specified Skill at session start, and declare MCP servers to provide real tool capabilities. They are ideal for sharing workflows with a team, connecting to external services, or installing extensions from the official marketplace.

## Installation and Management

Run `/plugins` in the TUI to open the plugin manager. It is a single panel with four tabs — **Installed** (manage what you have), **Official** (Kimi-maintained marketplace plugins), **Third-party** (marketplace plugins from other publishers), and **Custom** (install from a URL) — switched with `Tab` / `Shift-Tab`. Common keys:

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | Switch between the Installed / Official / Third-party / Custom tabs |
| `Space` | Enable or disable the selected installed plugin (Installed tab) |
| `D` | Remove the selected installed plugin (Installed tab) |
| `M` | Manage MCP servers for the selected plugin (Installed tab) |
| `R` | Reload `installed.json` and all manifests (Installed tab) |
| `Enter` | Installed tab: install the available update, or view details if up to date · Official/Third-party tab: install or update · Custom tab: install |
| `I` | View plugin details (Installed tab) |
| `Esc` | Go back or cancel |

You can also use slash commands directly:

| Command | Description |
| --- | --- |
| `/plugins` | Open the interactive plugin manager |
| `/plugins list` | List installed plugins |
| `/plugins install <path-or-url>` | Install from a local directory, zip URL, or GitHub repository URL |
| `/plugins marketplace [source]` | Browse the official marketplace, or pass a custom marketplace JSON path or URL |
| `/plugins info <id>` | View plugin details and diagnostics |
| `/plugins enable <id>` | Enable a plugin |
| `/plugins disable <id>` | Disable a plugin |
| `/plugins remove <id>` | Remove a plugin (requires confirmation) |
| `/plugins reload` | Reload `installed.json` and all plugin manifests |
| `/plugins mcp enable <id> <server>` | Enable an MCP server declared by a plugin |
| `/plugins mcp disable <id> <server>` | Disable an MCP server declared by a plugin |

The **Installed** tab lists your installed plugins and shows an update badge when a newer version is available in the marketplace. The **Official** and **Third-party** tabs list marketplace plugins by tier; the **Custom** tab installs from a URL. Marketplace catalogs load automatically when needed. Each install shows a trust badge: `kimi-official` (from an official address), `curated` (from a curated address), or `third-party` (everything else). Installing a third-party plugin (anything not from the official address, including Custom installs) first shows a confirmation prompt that defaults to cancelling, so it is only installed if you choose to trust the source.

### Installing from GitHub

Use `/plugins install <url>` to install directly from a GitHub repository. Four URL forms are supported:

- `https://github.com/<owner>/<repo>`: Install the latest release; falls back to the default branch if no release exists
- `https://github.com/<owner>/<repo>/tree/<ref>`: Install a specific branch, tag, or short commit SHA
- `https://github.com/<owner>/<repo>/releases/tag/<tag>`: Pin to a specific tag
- `https://github.com/<owner>/<repo>/commit/<sha>`: Pin to a specific commit

Network requests only go through `github.com` redirects and `codeload.github.com` downloads; `api.github.com` is not called.

### Notes

- Plugin changes apply after `/reload` or in new sessions. After installing, enabling/disabling, or removing a plugin, run `/reload` or `/new`; the current session will not update.
- Local installations are copied to `$KIMI_CODE_HOME/plugins/managed/<id>/`, and the CLI always runs from this managed copy. Editing the original source directory after installation has no effect; you must reinstall.
- Removing a plugin only deletes the installation record; the managed copy and original source files remain on disk.
- Plugins are currently installed per-user and apply to all projects; project-level installation scope is not yet supported.

### Custom marketplace JSON

Pass a custom marketplace JSON path or URL to `/plugins marketplace <source>`, or set [`KIMI_CODE_PLUGIN_MARKETPLACE_URL`](../configuration/env-vars.md) to override the default catalog. Each entry in the `plugins` array needs an `id` and a `source` (local path, zip URL, or GitHub URL):

```json
{
  "version": "2",
  "plugins": [
    {
      "id": "my-plugin",
      "displayName": "My Plugin",
      "source": "./my-plugin"
    }
  ]
}
```

## Kimi Datasource

Kimi Datasource is the official Kimi Code data plugin. It lets you query financial market data, macroeconomic indicators, corporate registration records, academic literature, and Chinese laws and regulations in natural language — with professional finance sources such as Wind, IMF, Gildata, SEC EDGAR, and S&P Capital IQ built in, no manual API calls or data account registration required.

### Installation

You must first complete OAuth login with a Kimi Code account via `/login`. The plugin relies on local credentials to access data services.

1. Run `/plugins` and select **Official**
2. Find **Kimi Datasource** and press `Enter` to install
3. After installation completes, run `/reload` or `/new` to activate the plugin

The current latest version is v3.3.0. The plugin does not update automatically — to upgrade to a newer version, repeat the installation steps above.

### How to use

Once installed, describe your need in natural language and Kimi Code will automatically invoke the data capabilities. You can also explicitly trigger the data query skill with `/skill:kimi-datasource`.

### What you can do

**Live market research**: Want to run a quantitative analysis on a stock? Pull three years of daily closing prices, MACD, and KDJ signals in a single query — no third-party data platforms needed.

**Cross-country macro comparison**: Studying supply-chain shifts across China, India, and Vietnam? Get complete GDP growth, trade volume, and demographic time-series from World Bank data spanning 50+ years, all in one go.

**Pre-contract risk check**: Need to vet a counterparty fast? Type the company name and instantly get business registration, equity structure, litigation disputes, and credit blacklist status — right when you need it.

**Literature review acceleration**: Tracing the research arc of RLHF? Get the most-cited papers, key authors, and core findings in seconds, so your literature review outline takes shape in half the time.

**On-the-spot legal lookup**: Stuck on which statute governs a residence-right contract dispute? Pinpoint the relevant Civil Code articles — full text, authority level, and validity — then pull a few comparable precedents to back them up, without digging through statute databases.

**Institutional-grade US equity research**: Writing a deep dive on a US stock? Pull the 10-K filing, standardized XBRL metrics, top-50 holders, and consensus estimates in one go — SEC filings and S&P data without juggling multiple data terminals.

### Coverage

| Category | Scope |
|---|---|
| Stock market data | A-shares, HK, US, and major global markets — real-time/historical prices, technical indicators, financial statements, stock screening |
| Macroeconomic data | World Bank data for 189 countries, 50+ years of time series (GDP, trade, population, climate, and more) |
| Corporate data | Business registration, equity chain, legal risk, and related-entity graph for mainland Chinese companies |
| Academic literature | Millions of papers across physics, mathematics, CS, quantitative finance, economics — including preprints |
| Legal | Chinese laws, regulations, and judicial cases — semantic/keyword search and detail lookup for statutes across all authority levels (constitution, laws, judicial interpretations, departmental rules), plus ordinary and authoritative case search |
| Financial terminal (Wind) | A-share, fund, bond, and index quotes with financial indicators, company announcements and research reports, and macroeconomic data |
| International macro (IMF) | Official IMF datasets (IFS, BOP, DOTS, WEO, and more): exchange rates, CPI, balance of payments, trade, and GDP forecasts |
| Smart screening (Gildata) | Natural-language stock / fund / fund-manager screening, plus macro-industry data, research reports, announcements, and news |
| US filings (SEC EDGAR) | 8,000+ US-listed companies — 10-K/10-Q statements, XBRL metrics, Form 4 insider trades, 13F institutional holdings, and 8-K material events (back to 2009) |
| US fundamentals (S&P Capital IQ) | Standardized financial statements, valuation ratios, consensus estimates, holders and executives, competitor relationships, corporate events, and call transcripts |

### Billing and limitations

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
| `hooks` | Hook rules run on lifecycle events while the plugin is enabled; see [Hooks in Plugins](#hooks-in-plugins) |
| `commands` | One or more `./` paths pointing to a directory or `.md` file; registers the Markdown files within as slash commands. See [Plugin Slash Commands](#plugin-slash-commands) |

Unsupported runtime fields such as `tools`, `apps`, `inject`, and `configFile` appear as diagnostics and are ignored.

## Plugin Slash Commands

Slash commands save a prompt you use often as a `/command`, so you can trigger it by typing the command instead of retyping the whole thing.

Here is a minimal end-to-end example. The plugin's directory structure:

```text
kimi-finance/
  kimi.plugin.json
  commands/
    report.md
```

In the manifest (`kimi.plugin.json`), the `commands` field points to where the command files live:

```json
{
  "name": "kimi-finance",
  "version": "1.0.0",
  "commands": "./commands/"
}
```

The command file `commands/report.md`. The block between the two `---` lines at the top is frontmatter (metadata describing the command); everything below is the prompt sent to the Agent:

```markdown
---
description: Pull and summarize a stock's latest financials
---

Pull the latest financials for $ARGUMENTS and summarize revenue, profit, and key risks.
```

After installing and enabling the plugin, type this in the chat:

```text
/kimi-finance:report TSLA
```

Kimi replaces `$ARGUMENTS` in the body with `TSLA`, then runs the prompt. The three details below cover each step.

### Declaring Commands (the `commands` field)

`commands` takes a single `./` path or an array of paths, each pointing to a directory or `.md` file inside the plugin root:

- Pointing at a **directory**: collects every `.md` file under it recursively; each becomes one command.
- Pointing at a **single `.md` file**: registers just that one.
- Pointing at a non-`.md` file or a missing path: appears as a diagnostic (shown in the `/plugins` panel) and is ignored.

### Writing a Command File

A command file has two parts: an optional **frontmatter** (the metadata between the two `---` lines at the top, where you set `name` and `description`) and the **body** (the prompt after the `---`). When a field is omitted, it falls back as follows:

- `name` (the command name): derived from the file's path relative to the declared `commands` path (without `.md`, using `/` separators), e.g. `commands/frontend/component.md` → `frontend/component`. A `name` set in the frontmatter takes precedence.
- `description` (shown in the command list): the first non-empty line of the body (truncated past 240 characters); if the body is empty too, `No description provided.` is shown.

### Running Commands and Passing Arguments

Commands are prefixed with the plugin id (their namespace) and registered as `<plugin>:<command>`, so the command above is actually `/kimi-finance:report` — this keeps same-named commands from different plugins from colliding.

Whatever you type after the command replaces `$ARGUMENTS` in the body (above, `TSLA` replaces `$ARGUMENTS`). If the body has no `$ARGUMENTS` but you pass arguments anyway, they are not dropped — they are appended to the end of the body as `ARGUMENTS: <what you typed>`.

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

## Hooks in Plugins

A plugin can declare hook rules in its manifest that run on lifecycle events while the plugin is enabled. Each entry uses the same fields as a [`[[hooks]]` rule in `config.toml`](./hooks.md#configuration) (`event`, `matcher`, `command`, `timeout`):

```json
{
  "hooks": [
    {
      "event": "PreToolUse",
      "matcher": "Bash",
      "command": "node ./hooks/check-bash.mjs",
      "timeout": 5
    }
  ]
}
```

Plugin hooks reuse the same mechanism as global hooks — see [Hooks](./hooks.md) for the event list, the stdin JSON payload, and how exit codes and return values affect the main flow. The differences are:

- A plugin's hooks are active only while the plugin is **enabled**; disabling the plugin stops its hooks.
- Each hook runs with its working directory set to the plugin root, so `command` can use `./` paths inside the plugin.
- The hook process receives two extra environment variables: `KIMI_CODE_HOME` and `KIMI_PLUGIN_ROOT` (the plugin root directory).

Installing a plugin never runs its hooks by itself — they only fire when their matching event occurs while the plugin is enabled.

## Security Model

Plugins have a limited loading scope. The following operations do not occur during installation or session startup:

- Command-type plugin tools and legacy tool runtimes are not executed
- All paths must remain within the plugin root directory after symbolic link resolution
- MCP servers of enabled plugins start after `/reload` or in new sessions and can be disabled at any time from `/plugins`
- Broken manifests or unsafe paths appear in `/plugins info <id>` diagnostics and do not affect other sessions

