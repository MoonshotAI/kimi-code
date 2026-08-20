# Plugins

Plugins package reusable Kimi Code CLI capabilities into installable units — they can add [Agent Skills](./skills.md), custom [agents](./agents.md), automatically load a specified Skill at session start, contribute system-prompt instructions, and declare MCP servers to provide real tool capabilities. They are ideal for sharing workflows with a team, connecting to external services, or installing extensions from the [official plugins](#official-plugins).

## Installation and Management

Run `/plugins` in the TUI to open the plugin manager. It is a single panel with four tabs, switched with `Tab` / `Shift-Tab`:

- **Installed**: Manage installed plugins
- **Official**: Kimi-maintained marketplace plugins
- **Curated**: Third-party plugins from Kimi partners in the default marketplace
- **Custom**: Install from a URL

Common keys:

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | Switch between the Installed / Official / Curated / Custom tabs |
| `Space` | Enable or disable the selected installed plugin (Installed tab) |
| `D` | Remove the selected installed plugin (Installed tab) |
| `M` | Manage MCP servers for the selected plugin (Installed tab) |
| `R` | Reload `installed.json` and all manifests (Installed tab) |
| `Enter` | Installed tab: install the available update, or view details if up to date · Official/Curated tab: install or update · Custom tab: install |
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

## Official Plugins

Official plugins are plugins and built-in product capabilities maintained by Kimi. There are currently three:

- **[Kimi Datasource](#kimi-datasource)**: Query financial market data, macroeconomic indicators, corporate registration records, academic literature, and Chinese laws and regulations in natural language
- **[Kimi WebBridge](#kimi-webbridge)**: Let AI drive your own browser to get web tasks done
- **[Kimi Computer Use](#kimi-computer-use)**: Let AI operate your desktop apps (macOS and Windows)

### Installation and Upgrade

All official plugins share the same installation and upgrade flow:

1. Run `/plugins` and press `Tab` to select **Official**
2. Find the plugin you want and press `Enter` to install
3. After installation completes, run `/reload` or `/new` to activate it

::: info Note
Kimi WebBridge installs in two parts: after the steps above, you also need to [install the browser extension](#install-the-browser-extension) before it works.
:::

Official plugins do not update automatically — when an update is available, you'll be prompted the next time you use the old version. To upgrade, repeat the installation steps above.

### Kimi Datasource <Badge type="tip" text="v3.4.0" />

Kimi Datasource is the official Kimi Code data plugin, letting you query financial market data, macroeconomic indicators, corporate registration records, academic literature, and Chinese laws and regulations in natural language — no manual API calls or data accounts required.

You must first complete OAuth login with a Kimi Code account via `/login`; data queries consume your Kimi Code plan quota.

#### How to use

1. Describe your need in natural language, and Kimi Code will automatically invoke the data capabilities
2. Explicitly trigger the data query skill with `/skill:kimi-datasource`

#### What you can do

**Live market research**: Want to run a quantitative analysis on a stock? Pull three years of daily closing prices, MACD, and KDJ signals in a single query — no third-party data platforms needed.

**Cross-country macro comparison**: Studying supply-chain shifts across China, India, and Vietnam? Get complete GDP growth, trade volume, and demographic time-series from World Bank data spanning 50+ years, all in one go.

**Pre-contract risk check**: Need to vet a counterparty fast? Type the company name and instantly get business registration, equity structure, litigation disputes, and credit blacklist status — right when you need it.

**Literature review acceleration**: Tracing the research arc of RLHF? Get the most-cited papers, key authors, and core findings in seconds, so your literature review outline takes shape in half the time.

**On-the-spot legal lookup**: Stuck on which statute governs a residence-right contract dispute? Pinpoint the relevant Civil Code articles — full text, authority level, and validity — then pull a few comparable precedents to back them up, without digging through statute databases.

**Institutional-grade US equity research**: Writing a deep dive on a US stock? Pull the annual report, standardized financial metrics, top-50 holders, and consensus estimates in one go — no more juggling multiple data terminals.

#### Coverage

| Category | Scope |
|---|---|
| Stocks & financial markets | Well-known databases such as Wind, S&P Capital IQ, and SEC EDGAR, covering prices, technical indicators, financials and valuation, and consensus estimates across A-shares, HK, US, and other major markets, plus official filings for 8,000+ US-listed companies |
| Macroeconomics | Well-known databases such as the World Bank and IMF, covering 50+ years of time series for 189 countries: GDP, trade, population, exchange rates, CPI, balance of payments, GDP forecasts, and more |
| Corporate data | Business registration, equity chain, legal risk, and related-entity graph for mainland Chinese companies |
| Academic literature | Millions of papers across physics, mathematics, CS, quantitative finance, economics — including preprints |
| Legal | Chinese laws, regulations, and judicial cases — statute search and detail lookup across all authority levels, plus ordinary and authoritative case search |
| Chinese government statistics | Open data catalogs from the National Data Administration, plus NBS macro indicators (national, provincial, and major-city time series) |
| Chinese standards | National (GB), industry (HB), local (DB), and association (TT) standards lookup |
| International organizations | Official open datasets from WHO, FAO, UNSD, ECB, Eurostat, UNICEF, OECD, and FRED — global health, food and agriculture, finance, and macro time series |
| Financial news and data | Xinhua Finance announcements, news flashes, and policy updates; Caixin database with 600+ data APIs |
| Smart screening | Well-known databases such as Gildata, covering natural-language screening for stocks, funds, and fund managers, plus macro-industry data, research reports, announcements, and news |

#### Billing and limitations

- Data queries are billed per call and consume Kimi Code account credits
- The plugin provides read-only queries; no write or trading functionality is available
- Technical indicators and real-time prices are only available during active trading hours
- AI-generated output is for reference only and does not constitute investment or business advice

### Kimi WebBridge <Badge type="tip" text="v1.11.3" />

Kimi WebBridge lets AI drive your browser directly — not an emulator, not a crawler, but the browser you use every day, with your login sessions and cookies. AI can open pages, read content, click buttons, fill in forms, and take screenshots just like you do, taking repetitive web operations off your hands. See the [Kimi WebBridge site](https://www.kimi.com/features/webbridge) for a product overview.

#### Install the browser extension

After installing via `/plugins`, you also need the Kimi WebBridge extension in your browser before AI can drive it. There are two ways to install it:

**Option 1: Install from a store (recommended)**

Open the [Chrome Web Store](https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc) or [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg) page and click Add.

**Option 2: Install manually**

Use this when you can't reach the stores:

1. [Download the extension package](https://kimi-web-img.moonshot.cn/webbridge/latest/extension/kimi-webbridge-extension.zip) and unzip it
2. Type `chrome://extensions/` in the address bar to open the extensions page, then turn on **Developer mode** in the top-right corner

   ![Turn on Developer mode](../../media/webbridge-dev-mode.jpeg)

3. Click **Load unpacked** in the top-left corner and select the unzipped `kimi-webbridge-extension` folder

   ![Load the unpacked extension](../../media/webbridge-load-unpacked.jpeg)

4. Once installed, the Kimi WebBridge icon appears in the browser toolbar. Seeing the icon means the installation succeeded, and AI can start working on web pages for you.

   ![The Kimi WebBridge icon in the browser toolbar](../../media/webbridge-install-success.jpeg)

#### What you can do

- **Web automation**: Just say what you need — AI clicks through pages, fills in forms, reads content, and takes screenshots for you
- **Social trending research**: Automatically browse trending topics on X (Twitter), Weibo, and Xiaohongshu, open the top-liked posts one by one to screenshot and extract key viewpoints, then organize everything into a research library with topic suggestions
- **Job listing collection**: Filter positions on recruiting sites by keyword, city, and job type, and organize titles, links, companies, salaries, and application methods into a table
- **Competitive analysis**: Batch-question multiple AI products and collect their answers to build side-by-side comparison reports
- **Flight price comparison**: Query the same itinerary across multiple travel platforms, record airlines, departure/arrival times, and links sorted by price, and get recommended options

### Kimi Computer Use <Badge type="tip" text="v0.5.4" />

Kimi Computer Use lets AI operate your desktop apps directly, clicking, dragging, scrolling, and typing. The macOS version works silently in the background without taking over your mouse (a few popup actions may still bring an app to the foreground); see [the notes below](#notes-for-the-windows-version) for how the Windows version differs.

#### Authorization (macOS)

The first time you use Kimi Computer Use after installation, it shows an authorization window — just follow the prompts:

1. Click **Authorize** next to **Accessibility** and **Screen Recording**, and enable both permissions in System Settings — the former lets it perform clicks, typing, and scrolling; the latter lets it read screen content and locate UI elements
2. Turn on the **Kimi Code** switch under "Connect local agents", then restart Kimi Code for it to take effect

<div style="max-width: 380px; margin: 0 auto;">

![Kimi Computer Use authorization window](../../media/kimi-computer-use-auth.jpeg)

</div>

#### Notes for the Windows version

The Windows version (WinCU) installs differently from the macOS one: run `/plugins install https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip` in Kimi Code, then restart after installation. A few things to know before using it:

- **It may briefly take over your mouse and keyboard**: Unlike the macOS version, the Windows version cannot reliably inject input in the background; it may briefly activate the target window and use your real mouse and keyboard while performing actions
- **System requirements**: Windows 10 version 1903 (Build 18362) or later, or Windows 11, x64; a real interactive desktop session is required, and Windows Server needs Desktop Experience
- **No extra permissions needed**: Windows does not require the Accessibility and Screen Recording grants that macOS does
- **Matching privilege level**: If the target app runs as administrator, KimiCU must run at the same privilege level

#### What you can do

- **Organize and enter information**: Have AI gather scattered information into Notes, spreadsheets, or your note-taking app, instead of typing everything in by hand
- **Walk through site and app flows**: After changing a page, let AI click through the key flows and screenshot each step to confirm rendering and navigation work
- **Handle repetitive operations**: Repeatedly opening, copying, pasting, and checking can run silently in the background without taking over your mouse
- **Run fixed-step tasks**: For flows with clear steps, spell them out and AI follows along; for example, ask AI to open NetEase Cloud Music and play a specific song
- **Handle software that has no API**: Plenty of professional tools and internal systems have no CLI or API at all; what used to require your own clicking can now be handed to AI, like trimming the first three seconds off a clip in Final Cut Pro and exporting it

::: warning Note
Don't hand it anything involving money, accounts, or publishing, such as payments and transfers, deleting important files, changing passwords, or posting content. To judge whether a task is suitable, check three things: the result is verifiable, the action is reversible, and the risk of getting it wrong is low.
:::

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
  "systemPromptPath": "./SYSTEM.md",
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
| `agents` | One or more `./` paths; must be within the plugin root directory and point to directories containing [agent files](./agents.md#custom-agents). When omitted, the `agents/` directory under the plugin root (if present) is picked up automatically |
| `sessionStart.skill` | Loads the specified plugin Skill into the main Agent when a new or resumed session starts |
| `skillInstructions` | Additional instructions appended whenever a Skill from this plugin is loaded |
| `systemPrompt` | Inline instructions contributed to the agent's system prompt while the plugin is enabled |
| `systemPromptPath` | A `./` path to a UTF-8 text file containing system-prompt instructions; combined after `systemPrompt` when both are present |
| `mcpServers` | MCP server declarations; enabled by default, can be disabled from `/plugins` |
| `hooks` | Hook rules run on lifecycle events while the plugin is enabled; see [Hooks in Plugins](#hooks-in-plugins) |
| `commands` | One or more `./` paths pointing to a directory or `.md` file; registers the Markdown files within as slash commands. See [Plugin Slash Commands](#plugin-slash-commands) |

Unsupported runtime fields such as `tools`, `apps`, `inject`, and `configFile` appear as diagnostics and are ignored.

### System-prompt instructions

Use `systemPrompt` for a short inline instruction, or `systemPromptPath` to keep longer instructions in a file inside the plugin root. If both fields are present, the inline text appears first, followed by the file content. The file content is read when the plugin is installed or reloaded, so edits take effect only after `/plugins reload`. For example:

```json
{
  "name": "code-review",
  "systemPromptPath": "./SYSTEM.md"
}
```

System-prompt contributions take effect on both agent engines. The interactive TUI, `kimi -p`, and `kimi web` use the v2 engine by default; setting `KIMI_CODE_LEGACY_FLAG=1` routes the local CLI surfaces to the legacy engine.

Each field — the inline `systemPrompt` and the `systemPromptPath` file — is limited to 32 KB (UTF-8 bytes): oversized content is ignored and reported in the plugin diagnostics. Across all enabled plugins, one prompt build injects at most 64 KB of instructions; contributions beyond the budget are skipped with a warning, including a single plugin whose inline text and file together exceed that budget.

New sessions and newly created agents read the contributions from the plugins currently enabled. An in-flight request keeps its existing system prompt. `/plugins reload` refreshes the plugin skill list and requests prompt rebuilds for live agents; use it when you need the change to converge deliberately before the next turn. On the v2 engine, installing, enabling, disabling, or removing a plugin updates the catalog immediately and a later prompt rebuild — for example after compaction or a tool-policy change — may pick up the new sections. The legacy engine keeps each live session's plugin snapshot until `/plugins reload` or a new session. A resumed session starts from its persisted prompt, and later rebuilds follow the engine-specific behavior above. Toggling a plugin's MCP server does not change system-prompt sections.

The built-in agent prompt includes instructions from enabled plugins automatically. A custom `SYSTEM.md` or agent file owns its template, so include `${plugin_sections}` where plugin-contributed instructions should appear. If the custom template includes `${base_prompt}` and that effective default already contains the plugin block, do not add `${plugin_sections}` again. See [Custom agents and SYSTEM.md](./agents.md#overriding-the-main-agent-s-system-prompt-with-system-md) for the complete variable table.

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

## Plugin Agents

A plugin can ship custom agents: declare one or more `./` directories in the manifest's `agents` field (or simply place an `agents/` directory under the plugin root). The agent files inside use the same format as [custom agents](./agents.md#custom-agents) and, while the plugin is enabled, are discovered automatically and can be delegated to as sub-agents by the main Agent.

```text
my-plugin/
  kimi.plugin.json
  agents/
    reviewer.md
```

Plugin agents rank below every other file source: on a name collision, user-level, extra, project-level, and `--agent-file` agents all win over the plugin-provided one, and replacing a built-in agent still requires an explicit `override: true` in the frontmatter. After installing, enabling, disabling, or removing a plugin, the agent list refreshes in a new session (or on `/reload`); on the v2 engine the live session also refreshes after `/plugins reload`.

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
