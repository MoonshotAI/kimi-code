# `kimi` Command

`kimi` is the main command for Kimi Code CLI, used to start an interactive session in the terminal. Running it without any arguments opens a new session in the current working directory; combined with different flags, you can resume a previous session, skip approvals, start in Plan mode, or load Skills from a custom directory.

```sh
kimi [options]
kimi <subcommand> [options]
```

## Main Command Options

All flags are optional — run `kimi` directly to enter an interactive session:

| Option | Short | Description |
| --- | --- | --- |
| `--version` | `-V` | Print the version number and exit |
| `--help` | `-h` | Show help information and exit |
| `--session [id]` | `-S` | Resume a session. With an ID, opens that session directly; without an ID, enters an interactive selector |
| `--continue` | `-C` | Continue the most recent session in the current working directory, without specifying an ID manually |
| `--model <model>` | `-m` | Specify a model alias for this launch. When omitted, new sessions use `default_model` from the config file |
| `--prompt <prompt>` | `-p` | Run a single prompt non-interactively and stream the Assistant output to stdout. This mode does not open the TUI |
| `--output-format <format>` | | Set the non-interactive output format; supports `text` and `stream-json`. Can only be used with `--prompt`; defaults to `text` |
| `--yolo` | `-y` | Auto-approve regular tool calls, skipping approval requests |
| `--auto` | | Start with auto permission mode; tool approvals are handled automatically and the Agent will not ask the user questions |
| `--plan` | | Start a new session in Plan mode — the AI will prioritize read-only tools for exploration and planning |
| `--skills-dir <dir>` | | Load Skills from the specified directory, replacing the automatically discovered user and project directories. Can be repeated |

`-r` / `--resume` is a hidden alias for `--session`; `--yes` and `--auto-approve` are hidden aliases for `--yolo` and are not shown in help output.

::: warning
`--yolo` skips human approval for regular tool calls, including file writes and shell command execution. Use it only in trusted working directories. Plan mode exit approval is not bypassed by `--yolo`; `Bash` inside Plan mode is handled under the regular allow rules.
:::

### Flag Conflict Rules

The following combinations are rejected at startup:

- `--continue` and `--session` are mutually exclusive — both mean "resume a previous session"
- `--yolo` and `--auto` are mutually exclusive — the two permission modes cannot be combined
- `--prompt` cannot be used with `--yolo`, `--auto`, or `--plan` — non-interactive mode uses `auto` permission by default
- `--output-format` can only be used together with `--prompt`

When resuming a session, you can override its saved permission or plan mode by adding `--auto`, `--yolo`, or `--plan`. For example, `kimi --continue --auto` resumes the latest session and switches it to auto permission mode.

## Common Usage

Start a new session directly:

```sh
kimi
```

Pick up where you left off (automatically finds the most recent session in the current directory):

```sh
kimi --continue
```

Choose from the session history list, or specify a known ID directly:

```sh
kimi --session
kimi --session 01HZ...XYZ
```

Skip approval prompts — suitable for batch tasks that are known to be safe:

```sh
kimi --yolo
```

Let the Agent handle everything autonomously, without asking the user questions:

```sh
kimi --auto
```

Read the code and produce an implementation plan before making any file changes:

```sh
kimi --plan
```

### Custom Skills Directories

There are two ways to specify Skills directories, with different semantics:

- **`--skills-dir <dir>`** (CLI flag): **Replaces** the automatically discovered user and project directories for this launch only. Can be repeated to stack multiple directories:

  ```sh
  kimi --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`extra_skill_dirs`** (`config.toml`): **Adds** directories on top of the automatically discovered ones, taking effect permanently. Suitable for configuring team-shared Skills. See [Agent Skills](../customization/skills.md).

## Non-Interactive Execution

When running a single prompt in a script or CI environment, use `-p`:

```sh
kimi -p "Summarize the current repository status"
```

Output uses a transcript style: thinking content and Assistant text are both prefixed with `• `, and wrapped lines are indented by two spaces. Assistant text goes to stdout; thinking, tool progress, and "resuming session" notices go to stderr. In `-p` mode, no human approval is requested — regular tool calls are handled under the `auto` permission policy, while static deny rules remain in effect.

Temporarily switch the model:

```sh
kimi -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

When you need to parse output programmatically, use the `stream-json` format — each line on stdout is a JSON object:

```sh
kimi -p "List changed files" --output-format stream-json
```

In `stream-json` mode, regular replies produce an Assistant message; when the model calls a tool, an Assistant message with `tool_calls` is emitted first, followed by the corresponding Tool message, then subsequent Assistant messages. Thinking content is not written to JSONL; tool progress and "resuming session" notices are still written to stderr.

## Subcommands

`kimi` provides the following subcommands: `login` (non-interactive login), `acp` (ACP IDE mode), `server` (run and manage the local REST/WebSocket/web service), `web` (alias for `kimi server run --open`), `doctor` (validate configuration files), `export` (export a session), `migrate` (migrate legacy data), `upgrade` (check for updates), and `provider` (manage providers).

### `kimi login`

Log in to Kimi Code OAuth via the RFC 8628 device-code flow, without entering the TUI. The command issues a device authorization request, prints the verification URL and user code to stderr, then polls until the browser-side authorization is complete. The generated token is written to the same local location as TUI `/login` and is loaded automatically the next time `kimi` starts.

```sh
kimi login
```

This subcommand has no flags. Press `Ctrl-C` at any time during polling to cancel; the exit code is `1` on cancellation or failure, and `0` on success.

### `kimi acp`

Switch Kimi Code CLI to ACP (Agent Client Protocol) mode, communicating with an IDE via JSON-RPC over stdin/stdout so the editor can directly drive kimi's sessions and tool calls. You typically do not need to run this manually — the IDE starts it as a subprocess entry point. For configuration, see [Using in IDEs](../guides/ides.md); for technical details, see the [kimi acp reference](./kimi-acp.md).

```sh
kimi acp
```

### `kimi server`

Run, install, and manage the local Kimi server — a single process that exposes the REST + WebSocket API and serves the web UI from the same origin. The parent command is split into an on-demand entrypoint (`run`) and an OS-managed service lifecycle (`install`, `uninstall`, `start`, `stop`, `restart`, `status`). `kimi server run` ensures a single background daemon is running and returns once it is healthy; pass `--foreground` to keep the server attached to the current terminal instead.

When the server is running, `GET /openapi.json` returns the REST OpenAPI document and `GET /asyncapi.json` returns the local WebSocket AsyncAPI document.

```sh
kimi server run                # start or reuse a background daemon
kimi server run --foreground   # run attached to the current terminal
kimi server install            # register with launchd / systemd / schtasks
kimi server start              # start the OS-managed service
kimi server status             # snapshot of installed/running state
```

#### `kimi server run`

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port; defaults to `58627` |
| `--log-level <level>` | Enable server logs at the selected level; omitted by default |
| `--debug-endpoints` | Mount `/api/v1/debug/*` routes (off by default) |
| `--foreground` | Run in the foreground instead of spawning a background daemon |
| `--open` | Open the web UI in the default browser once the server is healthy |

`kimi server run` binds to local loopback only. By default it spawns a single background daemon (reused across runs) and exits once the daemon is healthy; the daemon shuts itself down after the last web client disconnects. Pass `--foreground` to run the server in the current process instead — it then stays attached to the terminal and shuts down cleanly on `SIGINT` / `SIGTERM`.

#### `kimi server install`

Register the server as an OS-managed service so it starts at login and restarts after a crash. The backend picks itself based on the running platform:

- **macOS**: writes a LaunchAgent plist to `~/Library/LaunchAgents/ai.moonshot.kimi-server.plist` and bootstraps it via `launchctl bootstrap gui/<uid>`.
- **Linux**: writes a `--user` systemd unit to `~/.config/systemd/user/kimi-server.service` and runs `systemctl --user enable --now`.
- **Windows**: registers a scheduled task named `KimiServer` via `schtasks /Create /XML`.

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port the supervised server uses; defaults to `58627` |
| `--log-level <level>` | Log level recorded in the generated unit |
| `--force` | Replace an existing install instead of failing |
| `--json` | Output JSON instead of a human-readable line |

The loopback host, chosen port, and log level are recorded to `~/.kimi-code/server/install.json` so `kimi server status` can report them even when the service is stopped.

#### Lifecycle subcommands

| Command | Description |
| --- | --- |
| `kimi server uninstall` | Stop and remove the OS service definition. Idempotent. |
| `kimi server start` | Start the OS-managed service. Errors if not installed. |
| `kimi server stop` | Stop the OS-managed service. |
| `kimi server restart` | Restart the OS-managed service. |
| `kimi server status` | Print installed / running / pid / port / log-path. `--json` for automation. |

#### `kimi web`

Alias for `kimi server run` with `--open` defaulted to `true` — runs the server in the foreground and opens the web UI in the default browser once it is healthy. Use `--no-open` to skip the browser launch (effectively turning it back into `kimi server run`).

```sh
kimi web                        # foreground + open browser
kimi web --no-open              # equivalent to `kimi server run`
```

The same `--port`, `--log-level`, and `--debug-endpoints` flags work as on `kimi server run`.

### `kimi doctor`

Validate `config.toml` and `tui.toml` without starting the TUI or modifying either file. By default, the command checks the files under `KIMI_CODE_HOME` (or `~/.kimi-code` when the environment variable is unset). Missing default files are reported as skipped because built-in defaults can apply.

```sh
kimi doctor
```

| Command | Description |
| --- | --- |
| `kimi doctor` | Validate the default `config.toml` and `tui.toml` |
| `kimi doctor config [path]` | Validate only `config.toml`, using `path` instead of the default file when provided |
| `kimi doctor tui [path]` | Validate only `tui.toml`, using `path` instead of the default file when provided |

When an explicit path is passed, the file must exist. The command exits with `0` when all checked files are valid or skipped, and `1` when any requested file is missing or invalid.

```sh
# Check the default config files
kimi doctor

# Check only the default runtime config
kimi doctor config

# Check a candidate TUI config before replacing the live config
kimi doctor tui ./tui.toml
```

### `kimi export`

Package a session into a ZIP file for sharing, archiving, or submitting bug reports.

```sh
kimi export [sessionId] [options]
```

| Parameter / Option | Short | Description |
| --- | --- | --- |
| `sessionId` | | The ID of the session to export. When omitted, the most recent session in the current working directory is automatically selected and requires confirmation |
| `--output <path>` | `-o` | Output ZIP file path. When omitted, writes to a default filename in the current directory |
| `--yes` | `-y` | Skip the confirmation prompt for the default session and export directly |
| `--no-include-global-log` | | Do not include the global diagnostic log. Included by default |

The export contains all files in the target session directory. The global diagnostic log (`~/.kimi-code/logs/kimi-code.log`) is included by default because it may contain events from other sessions or projects; add `--no-include-global-log` if you do not want to share it.

```sh
# Export the most recent session in the current directory, skipping confirmation
kimi export -y

# Export a specific session to a custom path
kimi export 01HZ...XYZ -o ./bug-report.zip

# Exclude the global diagnostic log
kimi export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kimi migrate`

Migrate local data from a legacy kimi-cli installation to kimi-code, including session history and configuration files. Runs entirely interactively, guiding you through the full process.

```sh
kimi migrate
```

For full migration instructions, see [Migrating from kimi-cli](../guides/migration.md).

### `kimi upgrade`

Immediately check for the latest version and display an update prompt; exits after you make a selection.

```sh
kimi upgrade
```

For global npm, pnpm, yarn, bun, and macOS / Linux native installations, `kimi upgrade` shows update options; selecting `Install update now` runs the corresponding foreground install command. When the current installation method cannot be upgraded automatically (e.g., Windows native installation), the manual update command is printed instead.

### `kimi vis`

Launch the session visualizer in your browser to inspect a session as it unfolds. The command starts an in-process server pointed at your local sessions, prints the URL, opens your browser, and keeps running until you press `Ctrl-C`.

```sh
kimi vis [sessionId] [options]
```

| Parameter / Option | Description |
| --- | --- |
| `sessionId` | Open the visualizer directly to this session. When omitted, it opens the home view listing your sessions |
| `--port <number>` | Port to bind. By default an available port is picked automatically |
| `--host <host>` | Host to bind. Default: `127.0.0.1` |
| `--no-open` | Do not open the browser automatically; just print the URL |

```sh
# Start the visualizer and open the browser at the home view
kimi vis

# Open directly to a specific session
kimi vis 01HZ...XYZ

# Bind a fixed port and host without opening a browser (e.g. on a remote host)
kimi vis --host 0.0.0.0 --port 8123 --no-open
```

### `kimi provider`

Manage providers in the shell — the non-interactive equivalent of `/provider` in the TUI. Suitable for scripted deployments, CI initialization, and one-line setup on a new machine.

```sh
kimi provider <action> [options]
```

Five actions are available:

#### `kimi provider add <url>`

Bulk-import all providers from a custom registry (`api.json`). The command fetches the registry, creates a `[providers.<id>]` and `[models.<alias>]` entry for each item, and writes `source` metadata so the TUI refreshes providers and models from the same registry URL automatically on next startup.

| Parameter / Option | Description |
| --- | --- |
| `<url>` | Registry URL |
| `--api-key <key>` | Bearer token for accessing the registry. Falls back to the `KIMI_REGISTRY_API_KEY` environment variable if not provided; required |

```sh
kimi provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# Or via environment variable (suitable for CI / .envrc)
KIMI_REGISTRY_API_KEY=YOUR_KEY kimi provider add https://registry.example.com/v1/models/api.json
```

If a provider ID already exists, it is removed and re-created. The default model is not set automatically; you can select one later with `-m` or `/model` in the TUI.

#### `kimi provider remove <providerId>`

Remove the specified provider and all its model aliases. If the removed provider is the one referenced by `default_model`, `default_model` is also cleared.

```sh
kimi provider remove kohub
```

#### `kimi provider list`

Print each configured provider on a separate line, including type, model count, and source. Add `--json` to output the raw `providers` and `models` tables for programmatic processing.

```sh
kimi provider list
kimi provider list --json | jq '.providers | keys'
```

#### `kimi provider catalog list [providerId]`

Browse the public [models.dev](https://models.dev/) model catalog without modifying any configuration. Without an argument, lists all providers along with their protocol type and model count; with a `providerId`, lists all models under that provider along with their context window and capabilities.

| Parameter / Option | Description |
| --- | --- |
| `[providerId]` | Optional — the provider ID to inspect |
| `--filter <substring>` | Case-insensitive substring filter on ID or name |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |
| `--json` | Output matching entries as JSON |

```sh
kimi provider catalog list
kimi provider catalog list --filter anthropic
kimi provider catalog list anthropic
```

#### `kimi provider catalog add <providerId>`

Import a known provider directly from the catalog by ID. The protocol type, base URL, and model information are all supplied by the catalog — only an API key is required.

| Parameter / Option | Description |
| --- | --- |
| `<providerId>` | Provider ID in the catalog, e.g., `anthropic`, `openai` |
| `--api-key <key>` | Provider API key. Falls back to `KIMI_REGISTRY_API_KEY` if not provided; required |
| `--default-model <modelId>` | Optional — set `default_model` to `<providerId>/<modelId>` after import |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |

```sh
kimi provider catalog list anthropic          # Browse available models first
kimi provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## Next steps

- [Slash Commands](./slash-commands.md) — Quick reference for control commands in the interactive TUI
- [Configuration Files](../configuration/config-files.md) — Persistent configuration for `default_model`, permission mode, and other startup parameters
- [Agent Skills](../customization/skills.md) — Skill file format for directories loaded via `--skills-dir`
