# Data Locations

Kimi Code CLI stores its runtime data centrally under the `~/.kimi-code/` directory in the user's home folder. This page describes where each type of data lives, what it is for, and how to customize or clean it up.

## Data root

The default data root is `~/.kimi-code/`. The `~` is resolved by Node.js's `os.homedir()`, so the actual path differs slightly across platforms: on macOS it is `/Users/<name>/.kimi-code`, on Linux `/home/<name>/.kimi-code`, and on Windows `C:\Users\<name>\.kimi-code`.

You can override it to any path with the `KIMI_CODE_HOME` environment variable:

```sh
export KIMI_CODE_HOME="$HOME/.config/kimi-code"
```

Once set, runtime data such as the config, sessions, logs, input history, update state, and OAuth credentials lands under that path. For the full reference on `KIMI_CODE_HOME` and other environment variables, see [Environment variables](./env-vars.md).

::: tip Exceptions
The **built-in tool cache** (such as the auto-downloaded ripgrep binary) does not follow `KIMI_CODE_HOME`. It uses `KIMI_CODE_CACHE_DIR`, falling back to a platform cache directory — `~/Library/Caches/kimi-code` on macOS, `$XDG_CACHE_HOME/kimi-code` (default `~/.cache/kimi-code`) on Linux, and `%LOCALAPPDATA%\kimi-code` on Windows.

User-level Agent Skills search directories live at `~/.kimi-code/skills` and `~/.agents/skills`; project-level Skills live under the working directory at `.kimi-code/skills` and `.agents/skills`. See [Agent Skills](../customization/skills.md) for details.
:::

## Directory layout

A typical layout under the data root looks like:

```
$KIMI_CODE_HOME  (default ~/.kimi-code)
├── config.toml             # User config
├── tui.toml                # Client preferences, including automatic updates
├── mcp.json                # User-level MCP server declarations (optional)
├── plugins/
│   ├── installed.json      # Installed plugin records and capability state
│   └── managed/            # Managed plugin copies installed from local paths or zip URLs
├── session_index.jsonl     # Session index
├── credentials/            # OAuth credential root (directory 0o700, files 0o600)
│   ├── <name>.json         # Hosted Kimi / Open Platform provider OAuth credentials
│   └── mcp/                # MCP server OAuth credentials
│       └── <key>-<suffix>.json
├── sessions/               # Session data
│   └── <workDirKey>/
│       └── <sessionId>/
│           ├── state.json
│           ├── upcoming-goals.json  # Upcoming `/goal next` queue
│           ├── logs/
│           │   └── kimi-code.log
│           ├── tasks/          # Background task persistence
│           │   ├── <task_id>.json
│           │   └── <task_id>/
│           │       └── output.log
│           ├── cron/            # Scheduled task persistence
│           │   └── <id>.json
│           └── agents/
│               ├── main/
│               │   ├── wire.jsonl
│               │   └── plans/  # Plan mode plan files
│               └── agent-0/
│                   └── wire.jsonl
├── bin/
│   └── rg                  # ripgrep cache (rg.exe on Windows)
├── logs/                   # Global diagnostic logs
│   └── kimi-code.log
├── updates/
│   ├── latest.json         # Update check status
│   ├── install.json        # Automatic update install state
│   └── install.lock        # Automatic update launch lock (transient)
└── user-history/
    └── <md5(workDir)>.jsonl
```

::: tip
The tree above shows a typical layout under the default data root (`~/.kimi-code/`). The paths for Agent Skills and the built-in tool cache have some special cases — see the "Exceptions" note above.
:::

## Config files

`config.toml` is Kimi Code CLI's main runtime config file, holding user-level settings such as providers, models, and loop control. See [Config files](./config-files.md) for details.

`tui.toml` stores client preferences for the `kimi` CLI, including terminal UI preferences and `[upgrade].auto_install`. Automatic updates are enabled by default; turn them off from `/settings` or by setting `auto_install = false`.

`mcp.json` holds user-level MCP server declarations and is merged with the project-local `.kimi-code/mcp.json` at load time. The fields are the same as the project-level file; see [MCP](../customization/mcp.md) for details.

`plugins/installed.json` records user/global plugin installs, whether each plugin is enabled, and capability state such as plugin MCP servers disabled or re-enabled from `/plugins` or via `/plugins mcp disable|enable`. Local path and zip URL installs are copied under `plugins/managed/<id>/`; the original source is retained only as display metadata. Project-local and repository-shared plugin install scopes are not supported yet. See [Plugins](../customization/plugins.md) for details.

OAuth credentials are stored as files under the `credentials/` subdirectory of the data root. The parent directory uses mode `0o700` and each credential file uses mode `0o600`, readable and writable only by the current user. There are two sub-locations:

- **Hosted Kimi / Open Platform provider OAuth credentials** live at `credentials/<name>.json`, for example `~/.kimi-code/credentials/managed:kimi-code.json`.
- **MCP server OAuth credentials** live under the `credentials/mcp/` subdirectory, with file names generated from the server key, for example `credentials/mcp/<key>-<suffix>.json`.

Writes follow a `tmp → fsync → rename` atomic flow: strictly atomic on POSIX, best-effort on Windows.

## Session data

Session-related data is grouped under `sessions/`, with a top-level `session_index.jsonl` maintaining a JSONL index: one record per line containing the three fields `sessionId`, `sessionDir`, and `workDir`. Entries are appended when a session is created. When the index is loaded, each entry is validated to ensure `sessionDir` still lives under `sessions/` and that its last path component equals `sessionId`, preventing external tampering from pointing entries to illegal paths.

Each session directory has a path like `sessions/<workDirKey>/<sessionId>/`, where `workDirKey` is a bucket name encoded from the working directory in the format `wd_<slug>_<first-12-chars-of-sha256>` (for example, `wd_myproject_a3f8c1d20e9b`), and `sessionId` is the session's unique identifier. The full path under `sessions/`, including each `<workDirKey>/` bucket, is created with mode `0o700` and accessible only by the current user.

The internal structure of a session directory includes:

- `state.json`: session title, `lastPrompt`, `createdAt`, `updatedAt`, `isCustomTitle`, `forkedFrom`, and metadata for each agent.
- `upcoming-goals.json`: the TUI-only queue created by `/goal next <objective>`. It is read only by the terminal UI and is not part of the agent conversation until a queued goal is promoted after the current goal completes.
- `agents/main/wire.jsonl`: the Wire event stream of the main agent, used for replay and resumption. `main` is the fixed id of the main agent.
- `agents/main/plans/`: plan files written by the main agent in Plan mode, named `<id>.md` by plan id.
- `agents/agent-0/`, `agents/agent-1/`, etc.: subagent instance directories, each with its own `wire.jsonl`. Subagent ids are generated by a per-session incrementing counter (`agent-` followed by an integer starting from 0).
- `logs/kimi-code.log`: the diagnostic log for this session. It only appears after a recorded diagnostic event; an ordinary conversation may not create this file.
- `tasks/`: background task persistence directory. Each task stores its metadata (status, pid, exit code, etc.) in `tasks/<task_id>.json`, with stdout and stderr written to `tasks/<task_id>/output.log`. Task ids use a `bash-` or `agent-` prefix followed by 8 random alphanumeric characters (for example, `bash-a1b2c3d4`).
- `cron/`: scheduled task persistence directory. Each task scheduled through `CronCreate` is mirrored to `cron/<id>.json`, where `<id>` is 8 lowercase hex characters. `kimi resume` rehydrates these tasks back into the in-memory scheduler. Tasks remain scoped to the resumed session id and do not bleed into new sessions. See [Scheduled tasks](../reference/tools.md#scheduled-tasks) for the tool surface.

`sessionId` is restricted to `[A-Za-z0-9._-]+` and cannot be `.` or `..`, preventing path injection. The session list is sorted by `updatedAt` in descending order, where `updatedAt` is the maximum mtime of the directory and its key files. See [Sessions](../guides/sessions.md) for details.

## Built-in tool cache

The first time Kimi Code CLI needs ripgrep, it downloads and caches it automatically. During the download, the archive is written to the system temporary directory and verified by SHA-256 before extraction; the binary is then installed directly to `bin/rg` under the data root (or `bin/rg.exe` on Windows) and marked `0o755` so it can be executed. Subsequent runs under the same data root reuse it with no further download. If `rg` is already on the system `PATH`, the system version takes precedence; deleting `bin/` triggers a redownload the next time it is needed.

## Logs and update state

The top-level `logs/kimi-code.log` is the global diagnostic log. It mainly records issues that do not belong to a single session, such as startup, login, and export failures. A single session's diagnostic log lives at `<sessionDir>/logs/kimi-code.log`.

When filing a bug report, prefer `kimi export` for the relevant session (see [The kimi command](../reference/kimi-command.md) for details). If a session log exists, it is included in the export by default. The global diagnostic log is also bundled by default; because it may contain events from other sessions or projects, use `--no-include-global-log` when you do not want to share it.

`updates/latest.json` records the latest version detected by the CLI. `updates/install.json` stores active background install state, retry state after failed background installs, and the one-shot success notice shown after a background update is applied. `updates/install.lock` is a transient atomic lock that prevents concurrent sessions from starting duplicate background installs. These files are maintained automatically by the CLI — there is usually no need to edit them by hand.

## Input history

Command input history from the terminal is saved per working directory. Each working directory corresponds to one file, at `user-history/<md5(workDir)>.jsonl`, where the file name is the MD5 hash of the working directory string (UTF-8 encoded). The file format is JSONL, with one history record per line.

Input history is used to browse and search previously entered prompts in the terminal interface.

## Cleaning up data

Deleting the data root directory (default `~/.kimi-code/`, or the path specified by `KIMI_CODE_HOME`) wipes all of Kimi Code CLI's runtime data, including config, sessions, logs, input history, and the built-in tool cache.

To clean up only part of the data:

| Goal | Action |
| --- | --- |
| Reset config | Delete `~/.kimi-code/config.toml` |
| Reset client preferences | Delete `~/.kimi-code/tui.toml` |
| Clear all sessions | Delete `~/.kimi-code/sessions/` and `~/.kimi-code/session_index.jsonl` |
| Clear diagnostic logs | Delete the `~/.kimi-code/logs/` directory |
| Clear input history | Delete the `~/.kimi-code/user-history/` directory |
| Reset update check state | Delete `~/.kimi-code/updates/latest.json` |
| Reset automatic update install state | Delete `~/.kimi-code/updates/install.json` |
| Clear a stale automatic update launch lock | Delete `~/.kimi-code/updates/install.lock` |
| Force a ripgrep redownload | Delete the `~/.kimi-code/bin/` directory |
| Clear hosted Kimi / Open Platform OAuth login state | Run `/logout` (clears only the current provider's OAuth), or delete the corresponding `~/.kimi-code/credentials/<name>.json` |
| Clear MCP server OAuth login state | Delete the `~/.kimi-code/credentials/mcp/` directory; `/logout` **does not** clear MCP OAuth credentials |
| Remove user-level MCP declarations | Delete `~/.kimi-code/mcp.json` |
| Clear plugin install records and managed plugin copies | Delete the `~/.kimi-code/plugins/` directory; original local plugin source directories are not deleted |
| Clear user-level Skills | Delete the `~/.kimi-code/skills/` directory |
