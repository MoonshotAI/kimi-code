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
| `--session [id]` | `-S` | Resume a session. With an ID, opens that session from the directory it runs in (elsewhere, prints the `cd` command to run); without an ID, enters an interactive selector |
| `--continue` | `-c` | Continue the most recent session in the current working directory, without specifying an ID manually |
| `--model <model>` | `-m` | Specify a model alias for this launch. When omitted, new sessions use `default_model` from the config file |
| `--prompt <prompt>` | `-p` | Run a single prompt non-interactively and stream the Assistant output to stdout. This mode does not open the TUI |
| `--output-format <format>` | | Set the non-interactive output format; supports `text` and `stream-json`. Can only be used with `--prompt`; defaults to `text` |
| `--yolo` | `-y` | Start in Ask When Needed mode: routine edits and commands run automatically; risky actions, questions, and plans still ask |
| `--auto` | | Start in Never Ask mode: everything runs and is decided automatically; only plans in Plan mode wait for your review |
| `--plan` | | Start a new session in Plan mode — the AI will prioritize read-only tools for exploration and planning |
| `--skills-dir <dir>` | | Load Skills from the specified directory, replacing the automatically discovered user and project directories. Can be repeated |
| `--agent <name>` | | Start a new session with the specified agent as the main Agent. Cannot be combined with `--session`/`--continue` |
| `--agent-file <path>` | | Load a custom agent from a Markdown file for the new session and select it. Cannot be repeated or combined with `--agent`, `--session`, or `--continue` |
| `--add-dir <dir>` | | Add an extra workspace directory for this session. Relative paths resolve against the current working directory. Can be repeated |

`-r` / `--resume` is a hidden alias for `--session`; `--yes` and `--auto-approve` are hidden aliases for `--yolo` and are not shown in help output. The hidden `--environment <id>` flag binds the new session to a configured remote environment, and `--environment-cwd <path>` overrides that environment's working directory (see [Remote environments](../guides/remote-environment.md#kimi-environment-and-environment-cwd)).

::: warning
`--yolo` skips human approval for regular tool calls, including file writes and shell command execution. Use it only in trusted working directories. Plan mode exit approval is not bypassed by `--yolo`; `Bash` inside Plan mode is handled under the regular allow rules.
:::

### Flag Conflict Rules

The following combinations are rejected at startup:

- `--continue` and `--session` are mutually exclusive — both mean "resume a previous session"
- `--yolo` and `--auto` are mutually exclusive — the two permission modes cannot be combined
- `--prompt` cannot be used with `--yolo`, `--auto`, or `--plan` — non-interactive mode uses `auto` permission by default
- `--output-format` can only be used together with `--prompt`
- `--environment` cannot be combined with `--session`/`--continue` — the environment is bound at session creation and the bound environment is restored automatically on resume
- `--environment-cwd` requires `--environment`; both flags are creation-only and cannot be combined with `--session`/`--continue`

Nobody can review a plan in non-interactive mode, so `default_plan_mode` is not applied to new sessions. A resumed session that is already in Plan mode still runs and stays in Plan mode, but its plan cannot be approved in non-interactive mode: it waits for your review the next time you open the session with `kimi -r`.

When resuming a session, you can override its saved permission or plan mode by adding `--auto`, `--yolo`, or `--plan`. For example, `kimi --continue --auto` resumes the latest session and switches it to Never Ask mode.

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

### Custom Agents

`--agent` and `--agent-file` select which agent drives a new session, in both print mode (`kimi -p`) and the interactive TUI:

```sh
kimi --agent reviewer
kimi -p --agent reviewer "Review the changes on this branch"
```

`--agent-file` registers a single agent file at the highest priority for this launch only and selects it; the flag cannot be repeated, and `--agent` and `--agent-file` are mutually exclusive. Both flags only apply when starting a new session — neither can be combined with `--session`/`--continue`, because the agent is bound at session creation and resuming restores the bound agent automatically. The selection is fixed at the session's first bind and cannot be switched later; in the TUI the flags bind only the startup session, and a session created later in the same process (for example via `/new`) starts with the default agent. See [Agents and Sub-Agents](../customization/agents.md#custom-agents) for the agent file format and discovery directories.

## Print mode

Use `-p` or `--prompt` to run a single task without opening the interactive terminal UI. Kimi prints the result to standard output and exits automatically, making it well suited for shell scripts, Git hooks, and CI pipelines.

### Basic usage

Pass a prompt directly to run a single task, and add `-m` when you want to override the model for that run.

```sh
# Run a single prompt
kimi -p "Summarize the current repository status"

# Override the model for this run
kimi -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

By default, Kimi outputs plain text with output and progress separated. The final reply goes to `stdout`, with each paragraph prefixed by `• `, ready for file redirection or shell pipes; thinking traces, tool progress, and session-resume hints go to `stderr` so they never pollute redirected output.

::: warning Unattended auto-approval
`-p` runs without interactive approval prompts. Regular file operations and shell commands are allowed automatically, while `deny` rules in your configuration file still apply.
:::

### Structured output

When your script or CI job needs to parse output fields programmatically, pass `--output-format stream-json`. Each line on `stdout` is a standalone JSON object emitted in order, covering assistant replies, tool calls, tool results, and the trailing session hint; thinking traces and tool progress still stay on `stderr`.

```sh
# Stream the full JSON event output
kimi -p "List changed files" --output-format stream-json

# Extract the final reply text with jq
kimi -p "Write a commit message for the staged changes" --output-format stream-json \
  | jq -r 'select(.role == "assistant" and .content != null and (.tool_calls | not)) | .content' \
  | tail -n 1
```

### Continuing a session

Every `-p` run saves its session automatically and outputs a `session_id` when finished. In plain-text mode it appears at the end of `stderr`; in `stream-json` mode it is emitted on `stdout` as a `session.resume_hint` line.

Choose the continuation method that fits your workflow. Use `-c` to quickly continue the most recent session in the current directory, or capture `session_id` and pass it to `-S` for explicit chaining in scripts and CI.

```sh
# Continue the most recent session in the current directory
kimi -p "Add parameter validation to src/retry.ts"
kimi -c -p "Run the unit tests and fix any failures"

# Capture session_id and chain explicitly in a script
RUN=$(kimi -p "Add parameter validation to src/retry.ts" --output-format stream-json)
SID=$(printf '%s\n' "$RUN" | jq -r 'select(.type == "session.resume_hint") | .session_id')
kimi -S "$SID" -p "Run the unit tests and fix any failures"
```

### Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | The task completed normally |
| `1` | Invalid CLI arguments, model authentication not ready, or an execution error |
| `4` | The session specified via `-S` / `-c` is currently held by another process |

## Subcommands

`kimi` provides the following subcommands: `login` (non-interactive login), `acp` (ACP IDE mode), `web` (run the local REST/WebSocket/web service in the foreground and open the web UI), `doctor` (validate configuration files), `export` (export a session), `migrate` (migrate legacy data), `import-sessions` (import Claude Code and Codex sessions), `upgrade` (check for updates), and `provider` (manage providers).

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

### `kimi web`

Run the local Kimi server in the foreground of the current terminal — a single process that exposes the REST + WebSocket API and serves the web UI from the same origin — and open the web UI in the default browser once it is ready. The command stays attached to the terminal and shuts down cleanly on `SIGINT` / `SIGTERM` (e.g. `Ctrl-C`).

When the server is running, `GET /api/v1/kap.md` returns the version-matched KAP runtime guide, `GET /openapi.json` returns the REST OpenAPI document, and `GET /asyncapi.json` returns the local WebSocket AsyncAPI document. For interacting with or handing off sessions from other agents, see [Using in Other Agents (Agent to Agent)](../guides/other-agents.md).

```sh
kimi web                 # run the server in the foreground and open the browser
kimi web --no-open       # don't open the browser
kimi web --port 58628    # pick a specific bind port
```

Multiple instances can share one home directory: each registers itself under `~/.kimi-code/server/instances/`, and a busy port is retried with `port + 1` (58628, 58629, …).

| Option | Description |
| --- | --- |
| `--port <port>` | Bind port; defaults to `58627`; a busy port is retried with `+1` |
| `--host [host]` | Bind host; omit for `127.0.0.1` (this machine only), pass a bare `--host` for `0.0.0.0` (all interfaces) |
| `--allowed-host <host...>` | Extra Host header values allowed through the DNS-rebinding check; repeatable or comma-separated |
| `--log-level <level>` | Enable server logs at the selected level; omitted by default |
| `--debug-endpoints` | Mount `/api/v1/debug/*` routes (off by default) |
| `--dangerous-bypass-auth` | Disable bearer-token auth on all REST and WebSocket routes so the web UI connects without a token; only for trusted networks or behind an authenticating proxy |
| `--web-title <title>` | Custom browser tab title for the web UI; defaults to the workspace directory name |
| `--no-open` | Do not open the browser once the server is ready |
| `--json` | Machine-readable startup mode: skips opening the browser, mints an in-memory bearer token for this process, prints a single JSON line (`{ origin, ws_url, token, kimi_agent_protocol_version }`) on `stdout` once ready, and routes logs to `stderr` |

`kimi web` binds to local loopback only by default and prints the bearer token in the startup banner; the web UI authenticates automatically via the `#token=` URL fragment.

::: danger
`--dangerous-bypass-auth` disables authentication entirely. Anyone who can reach the port gets full access to your sessions, filesystem, and shell. Only use it on a trusted network or behind your own authenticating reverse proxy, and stop the server with `Ctrl+C` when you are done.
:::

#### `kimi server kill`

Deprecated — only stops a server started by a version before 0.28.0. Those versions could leave a background server behind, recorded in the legacy single-instance lock at `~/.kimi-code/server/lock`; the command first tries `POST /api/v1/shutdown` for a graceful exit, then signals the recorded pid with SIGTERM, escalating to SIGKILL when needed, and removes the lock file once the process is confirmed dead. Servers started by `kimi web` run in the foreground — stop them with `Ctrl+C` instead.

#### `kimi web rotate-token`

Generate a new persistent bearer token (written to `~/.kimi-code/server.token`); the previous token stops working immediately. The token is shared by the whole home directory, so every running instance picks the new one up on its next auth check — no restart needed.

### `kimi app`

Open Kimi Code desktop and start a new chat in the current directory or a specified directory:

```sh
kimi app
kimi app ~/project
```

This requires an installed desktop version that supports opening workspaces from the CLI. Relative paths are resolved from the current directory. An existing workspace opens a new draft instead of restoring its previous session.

If the system reports that it cannot open the app, the command suggests `kimi install-desktop`, which opens the download page. This command does not download or install the desktop app automatically.

### `kimi install-desktop`

Print the Kimi Code desktop app page and open it in the default browser, so you can download and install the desktop app without leaving the terminal. The URL follows the active region: `https://www.kimi.com/code` on the mainland region, `https://www.kimi.ai/code` on the global region.

```sh
kimi install-desktop
```

This subcommand has no flags. The former name, `kimi install-app`, still works as a hidden alias. The same page is also reachable from the TUI with the `/desktop` (alias `/install-desktop`) slash command.

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

# Check only the default environment config
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

### `kimi import-sessions`

Import recent Claude Code and Codex sessions as regular Kimi Code sessions. The command opens an interactive page: choose the last 15 days (the default) or the last 30 days, then follow the progress and the summary. Inside the TUI, `/import-sessions` opens the same page.

```sh
kimi import-sessions
```

- Each run imports at most the newest 100 sessions; sessions imported before are skipped.
- Sessions without a prompt, subagent sessions, and non-interactive runs such as `codex exec` are not listed. Sessions whose project folder no longer exists, sessions still being written, and Codex sessions that were forked or restarted from an earlier message are skipped and reported.
- Sessions are read from `~/.claude` and `~/.codex`; set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to read them from other locations. The original session files are not changed.

See [Importing sessions from Claude Code and Codex](../guides/sessions.md#importing-sessions-from-claude-code-and-codex) for what an imported session contains.

### `kimi upgrade`

Immediately check for the latest version and display an update prompt; exits after you make a selection. `kimi update` is an alias for this command.

```sh
kimi upgrade [-y]
```

For global npm, pnpm, yarn, and bun installations, `kimi upgrade` shows update options; selecting `Install update now` runs the corresponding foreground install command. For native installations (including Windows), it downloads and verifies the new binary in the foreground and swaps it in on the next start. When the current installation method cannot be upgraded automatically, the manual update command is printed instead. Pass `-y, --yes` to skip the confirmation prompt and install the update directly.

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

Bulk-import all providers from a custom registry (`api.json`). The command fetches the registry, creates a `[providers.<id>]` and `[models.<alias>]` entry for each item, and writes `source` metadata so the TUI refreshes providers and models from the same registry URL automatically on next startup. When a registry entry declares the `env` field, the command prints a hint naming the declared variable — set `api_key_env` in `config.toml` to use it; see [Providers and models](../configuration/providers.md).

| Parameter / Option | Description |
| --- | --- |
| `<url>` | Registry URL |
| `--api-key <key>` | Bearer token for accessing the registry. Falls back to the `KIMI_REGISTRY_API_KEY` environment variable if not provided; optional — omit both for public registries |

```sh
kimi provider add https://registry.example.com/v1/models/api.json --api-key YOUR_KEY

# Or via environment variable (suitable for CI / .envrc)
KIMI_REGISTRY_API_KEY=YOUR_KEY kimi provider add https://registry.example.com/v1/models/api.json

# Public registry: no key needed
kimi provider add https://registry.example.com/v1/models/api.json
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

Browse the public [models.dev](https://models.dev/) model catalog without modifying any configuration. Without an argument, lists all providers along with their protocol type and model count; with a `providerId`, lists all models under that provider along with their context window and capabilities. If the catalog URL cannot be reached, a built-in snapshot of the catalog is used instead.

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

Import a known provider directly from the catalog by ID. The protocol type, base URL, and model information are all supplied by the catalog — only an API key is required. Vendors whose protocol the catalog does not declare (e.g. xai, openrouter, and other vendor-specific SDKs) are imported as OpenAI-compatible and the output notes the guess; when the catalog provides no usable endpoint, `--base-url` is required. Proprietary protocols (e.g. Amazon Bedrock) cannot be imported. When the public catalog is unreachable, the import uses the built-in snapshot, so it still works offline or in blocked networks.

| Parameter / Option | Description |
| --- | --- |
| `<providerId>` | Provider ID in the catalog, e.g., `anthropic`, `openai` |
| `--api-key <key>` | Provider API key. Falls back to `KIMI_REGISTRY_API_KEY` if not provided; required |
| `--default-model <modelId>` | Optional — set `default_model` to `<providerId>/<modelId>` after import |
| `--base-url <url>` | Override the catalog endpoint; required when the catalog declares none (or only an env placeholder) |
| `--url <url>` | Override the catalog URL; defaults to `https://models.dev/api.json` |

```sh
kimi provider catalog list anthropic          # Browse available models first
kimi provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```

## Next steps

- [Slash Commands](./slash-commands.md) — Quick reference for control commands in the interactive TUI
- [Configuration Files](../configuration/config-files.md) — Persistent configuration for `default_model`, permission mode, and other startup parameters
- [Agent Skills](../customization/skills.md) — Skill file format for directories loaded via `--skills-dir`
- [Agents and Sub-Agents](../customization/agents.md) — Built-in sub-agents, custom agent files, and main Agent selection via `--agent`
