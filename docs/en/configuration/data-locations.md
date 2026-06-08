# Data locations

Kimi Code CLI stores all runtime data — the config file, session history, login credentials, and diagnostic logs — under `~/.kimi-code/`. This page helps you understand where each type of data lives, what it is for, and how to clean up or relocate it when needed.

## Data root directory

The default data root is `~/.kimi-code/`. The actual path varies by platform:

- macOS: `/Users/<name>/.kimi-code`
- Linux: `/home/<name>/.kimi-code`
- Windows: `C:\Users\<name>\.kimi-code`

If you need to move the data directory elsewhere (for example, to isolate configs for different projects with independent environments), set `KIMI_CODE_HOME`:

```sh
export KIMI_CODE_HOME="$HOME/.config/kimi-code"
```

Once set, **all** data — config, sessions, logs, OAuth credentials, and more — lands under the new path. For the full reference on `KIMI_CODE_HOME`, see [Environment variables](./env-vars.md).

::: tip Two types of data are not affected by `KIMI_CODE_HOME`

**Built-in tool cache** (ripgrep binary) uses `KIMI_CODE_CACHE_DIR` instead. When that is unset, the platform cache directory is used: `~/Library/Caches/kimi-code` on macOS, `~/.cache/kimi-code` on Linux, and `%LOCALAPPDATA%\kimi-code` on Windows.

**Agent Skills** search paths are `~/.kimi-code/skills` and `~/.agents/skills` (user level), and `.kimi-code/skills` and `.agents/skills` under the working directory (project level). See [Agent Skills](../customization/skills.md).
:::

## Directory layout

```
$KIMI_CODE_HOME  (default: ~/.kimi-code)
├── config.toml             # User configuration
├── tui.toml                # Terminal UI preferences (including auto-update toggle)
├── mcp.json                # User-level MCP server declarations (optional)
├── plugins/
│   ├── installed.json      # Installed plugin records and enabled state
│   └── managed/            # Plugin copies installed from zip/local paths
├── session_index.jsonl     # Session index
├── credentials/            # OAuth credentials (dir 0700, files 0600)
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # Session data (see below)
│   └── <workDirKey>/<sessionId>/
├── bin/
│   └── rg                  # ripgrep cache (rg.exe on Windows)
├── logs/
│   └── kimi-code.log       # Global diagnostic log
├── updates/
│   ├── latest.json
│   ├── install.json
│   └── install.lock
└── user-history/
    └── <md5(workDir)>.jsonl
```

## File descriptions

Each top-level file under the data root serves a specific purpose; most are managed automatically by the CLI:

- **`config.toml`**: the main runtime configuration file, storing user-level settings such as providers, models, and loop control. See [Configuration files](./config-files.md).
- **`tui.toml`**: terminal UI client preferences, including `[upgrade].auto_install` (auto-update, on by default). You can disable it in `/settings` or by manually setting `auto_install = false`.
- **`mcp.json`**: user-level MCP server declarations, merged with the project-local `.kimi-code/mcp.json` on startup. See [MCP](../customization/mcp.md).
- **`plugins/installed.json`**: records installed plugins, each plugin's enabled state, and MCP server capability state changes made via `/plugins` or `/plugins mcp disable|enable`. Files installed from local paths or zip URLs are copied to `plugins/managed/<id>/`. See [Plugins](../customization/plugins.md).
- **`credentials/`**: OAuth credential directory, with permissions `0o700` (directory) / `0o600` (files), readable and writable only by the current user. Managed provider credentials are stored as `credentials/<name>.json`; MCP server credentials are stored under `credentials/mcp/`. Credentials are written using an atomic flow (tmp → fsync → rename) to prevent corruption.

## Session data

Each session's data is stored under `sessions/<workDirKey>/<sessionId>/`, and a top-level `session_index.jsonl` index is maintained (one record per line, each containing `sessionId`, `sessionDir`, and `workDir`). `workDirKey` is a bucket name derived from the working directory path, in the format `wd_<slug>_<first-12-chars-of-sha256>`.

Inside each session directory:

- **`state.json`**: session metadata including title, `lastPrompt`, creation/update timestamps, and `forkedFrom`.
- **`upcoming-goals.json`**: the TUI-only queue created by `/goal next <objective>`. It is not part of the agent conversation until a queued goal is promoted after the current goal completes.
- **`agents/main/wire.jsonl`**: the main Agent's complete communication record, used for session resumption and replay.
- **`agents/main/plans/`**: plan files written in Plan mode, named by plan id (`<id>.md`).
- **`agents/agent-0/` etc.**: sub-Agent instance directories, each containing their own `wire.jsonl`.
- **`logs/kimi-code.log`**: diagnostic log for this session; only present when a diagnostic event occurs.
- **`tasks/`**: background task persistence — `tasks/<task_id>.json` stores status/pid/exit code; `tasks/<task_id>/output.log` stores output.
- **`cron/`**: scheduled task persistence; reloaded into the scheduler when `kimi resume` runs. See [Scheduled tasks](../reference/tools.md#scheduled-tasks).

## Built-in tool cache

The first time the CLI needs ripgrep, it automatically downloads and caches it at `bin/rg` (`bin/rg.exe` on Windows); subsequent runs reuse the cached binary. If `rg` is already available on the system `PATH`, that version takes precedence. Deleting the `bin/` directory triggers a fresh download on the next use.

## Logs and update state

- **`logs/kimi-code.log`** (global): records startup, login, export, and other cross-session events.
- **`<sessionDir>/logs/kimi-code.log`** (session-level): records diagnostic events within a single session.

When reporting a bug, prefer exporting the relevant session with `kimi export` (see [kimi command](../reference/kimi-command.md)); the session log is included in the export by default. Add `--no-include-global-log` if you do not want to share the global log.

The three files under `updates/` (`latest.json`, `install.json`, `install.lock`) are maintained automatically by the auto-update mechanism and normally do not need manual editing.

## Input history

Terminal input history is saved separately per working directory, at `user-history/<md5(workDir)>.jsonl`. It is used to browse previously typed prompts in the terminal UI using the arrow keys.

## Clearing data

Deleting the data root directory (`~/.kimi-code/` or the path set by `KIMI_CODE_HOME`) removes all runtime data. To clear only part of the data:

| Goal | Action |
| --- | --- |
| Reset configuration | Delete `~/.kimi-code/config.toml` |
| Reset terminal UI preferences | Delete `~/.kimi-code/tui.toml` |
| Clear all sessions | Delete `~/.kimi-code/sessions/` and `session_index.jsonl` |
| Clear diagnostic logs | Delete `~/.kimi-code/logs/` |
| Clear input history | Delete `~/.kimi-code/user-history/` |
| Reset update state | Delete `~/.kimi-code/updates/latest.json` |
| Force re-download of ripgrep | Delete `~/.kimi-code/bin/` |
| Clear provider OAuth login state | Run `/logout`, or delete the corresponding `credentials/<name>.json` |
| Clear MCP server OAuth login state | Delete `credentials/mcp/` (`/logout` does not clear MCP credentials) |
| Remove user-level MCP declarations | Delete `~/.kimi-code/mcp.json` |
| Clear plugin install records | Delete `~/.kimi-code/plugins/` (local plugin source directories are not affected) |
| Clear user-level Skills | Delete `~/.kimi-code/skills/` |

## Next steps

- [Configuration files](./config-files.md) — full reference for `config.toml` fields
- [Environment variables](./env-vars.md) — detailed usage of `KIMI_CODE_HOME` and related path variables
