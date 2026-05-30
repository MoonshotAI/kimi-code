# kimi Command

`kimi` is the main command of Kimi Code CLI, used to start an interactive session in the terminal. When run without any arguments, it opens a new session in the current working directory; with different flags, you can resume a previous session, skip approvals, start in Plan mode, or point at custom Skills directories.

```sh
kimi [options]
kimi <subcommand> [options]
```

## Main command options

The table below lists all options supported by the `kimi` main command. All flags are optional — running `kimi` on its own is enough to enter an interactive session.

| Option | Short | Description |
| --- | --- | --- |
| `--version` | `-V` | Print the version number and exit. |
| `--help` | `-h` | Show help information and exit. |
| `--session [id]` | `-S` | Resume a session. With an ID, open the specified session directly; without an ID, enter the interactive picker to choose from historical sessions. |
| `--continue` | `-C` | Continue the most recent session in the current working directory, without manually specifying an ID. |
| `--model <model>` | `-m` | Use a model alias for this invocation. When omitted, new sessions use `default_model` from the config file, and resumed sessions use the session's current model. |
| `--prompt <prompt>` | `-p` | Run one prompt non-interactively and stream assistant output to stdout. This mode uses `auto` permission for tool calls and does not open the TUI. |
| `--output-format <format>` | | Set the non-interactive output format. Supported values are `text` and `stream-json`. Only valid with `--prompt`; defaults to `text`. |
| `--yolo` | `-y` | Auto-approve ordinary tool calls, skipping approval requests; Plan mode `Bash` approval and Plan mode exit approval are not skipped. |
| `--auto` | | Start in auto permission mode. Tool approvals are handled automatically and the agent will not ask questions. |
| `--plan` | | Start a new session in Plan mode, where the AI favors read-only tools for exploration and planning and can write the current plan file; Plan mode `Bash` is handled separately according to the permission mode. |
| `--skills-dir <dir>` | | Load Skills from the specified directory, replacing the auto-discovered user and project directories. Can be passed multiple times to stack several directories. See [Custom Skills directories](#custom-skills-directories) below. |

`-r` / `--resume` is a hidden alias for `--session`; `--yes` and `--auto-approve` are hidden aliases for `--yolo`. They do not appear in the help output and behave identically to their official counterparts.

::: warning Note
`--yolo` skips human confirmation for ordinary tool calls, including file writes and shell command execution. Use it only inside trusted working directories. Plan mode exit approval is not skipped by `--yolo`; in Plan mode, `Bash` also follows the same ordinary allow rules as `--yolo`.
:::

### Flag conflict rules

The following combinations are rejected at startup:

- `--continue` and `--session` are mutually exclusive: both mean "resume a previous session" and overlap in meaning.
- `--yolo` cannot be combined with `--continue` or `--session`: when resuming a session, the original session's approval settings are preserved. This rule only applies to interactive mode; in `--prompt` mode, `--yolo` is rejected earlier because it is mutually exclusive with `--prompt`.
- `--auto` cannot be combined with `--continue` or `--session`: same rationale as `--yolo`.
- `--auto` cannot be combined with `--yolo`: the two permission modes are mutually exclusive.
- `--plan` cannot be combined with `--continue` or `--session`: Plan mode only applies to new sessions.
- `--prompt` cannot be combined with `--yolo`, `--auto`, or `--plan`: non-interactive mode always uses `auto` permission and does not enter Plan mode.
- `--prompt` can be combined with `--continue` or `--session <id>` with an ID; bare `--session` without an ID would open the interactive picker and therefore cannot be used in non-interactive mode.
- `--output-format` can only be used with `--prompt`; the interactive TUI does not support writing the full event stream as stdout JSONL.

If you need to force YOLO or Plan mode while resuming a session, switch into them from inside the interactive session via slash commands instead.

## Typical usage

The most common entry point is to run `kimi` directly to start a fresh session in the current directory:

```sh
kimi
```

If the previous session was interrupted (terminal closed, network disconnected, etc.) and you want to pick up where you left off, use `--continue`:

```sh
kimi --continue
```

This automatically finds and resumes the most recent session under the current working directory. To pick a different historical session, run `kimi --session` to enter the interactive picker, or pass a known session ID directly:

```sh
kimi --session 01HZ...XYZ
```

When the task is trivial and you don't want to be interrupted by frequent approval requests, add `--yolo`:

```sh
kimi --yolo
```

If you want the agent to handle approvals on its own and not ask questions, use `--auto`:

```sh
kimi --auto
```

If you want the AI to read the code and produce an implementation plan first, rather than immediately editing files, use `--plan` to enter Plan mode:

```sh
kimi --plan
```

### Custom Skills directories

To load custom Skills directories, you have two options:

- **CLI flag `--skills-dir <dir>`**: Can be passed multiple times and **replaces** the auto-discovered user and project directories. Useful for temporary overrides or use in scripts. For example, to mount two directories at once:

  ```sh
  kimi --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`extra_skill_dirs` in `config.toml`**: Appends extra directories in the config file and **stacks** them with the auto-discovered ones. Suitable for persistent configuration of team-shared Skills (see [Agent Skills](../customization/skills.md)).

## Non-interactive execution

Use `-p` when a script or CI job needs to run one prompt:

```sh
kimi -p "Summarize the current repository status"
```

Output uses transcript-style blocks: thinking and assistant text start with `• `, with continuation lines indented by two spaces. Assistant text is written to stdout; thinking, tool progress, and the `To resume this session: kimi -r <id>` hint are written to stderr. Prompt mode does not wait for manual approvals: ordinary tool calls, Plan approvals, and agent questions follow the `auto` permission policy. Static deny rules still block matching tool calls.

To switch models for a single invocation, add `-m`:

```sh
kimi -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

If a script needs structured output, use JSONL:

```sh
kimi -p "List changed files" --output-format stream-json
```

In `stream-json` mode, each stdout line is one JSON object. Ordinary replies are emitted as assistant messages. If the model calls tools, the output first includes an assistant message with `tool_calls`, then the corresponding tool message, followed by later assistant messages. Thinking content is not written to JSONL; tool progress and the resume-session hint still go to stderr.

## Subcommands

### `kimi export`

Bundle a session into a ZIP file for sharing, archival, or bug reports. The exported archive contains all files under the session directory, such as context records, state files, and the session diagnostic log if that session has already produced `logs/kimi-code.log`.

```sh
kimi export [sessionId] [options]
```

| Argument / Option | Short | Description |
| --- | --- | --- |
| `sessionId` | | The ID of the session to export. When omitted, the most recent session under the current working directory is selected automatically and a confirmation is requested. |
| `--output <path>` | `-o` | Output path for the ZIP file. When omitted, writes to a default filename in the current directory. |
| `--yes` | `-y` | Skip the confirmation prompt for the default session and export directly. |
| `--no-include-global-log` | | Skip bundling the active global diagnostic log, `~/.kimi-code/logs/kimi-code.log`. It is included by default. |

By default, export includes files inside the target session directory. If that directory contains `logs/kimi-code.log`, it appears in the ZIP as `logs/kimi-code.log`. The global diagnostic log at `~/.kimi-code/logs/kimi-code.log` is also bundled by default, because it may contain events from other sessions or projects. Add `--no-include-global-log` when you do not want to share it. When included, its ZIP path is `logs/global/kimi-code.log`; rotated files such as `kimi-code.log.1` are not bundled.

When `sessionId` is omitted, the command first prints the session to be exported and asks for confirmation; `-y` skips this prompt, which is handy for scripts:

```sh
# Export the most recent session under the current working directory, skipping confirmation
kimi export -y

# Export a specific session to a custom path
kimi export 01HZ...XYZ -o ./bug-report.zip

# Exclude the global diagnostic log to avoid sharing events from other sessions
kimi export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kimi acp`

Run Kimi Code CLI as an [Agent Client Protocol](https://agentclientprotocol.com/) agent server over stdio. This mode is intended for ACP-compatible editors and tools that launch Kimi Code as a subprocess.

```sh
kimi acp
```

In ACP mode, stdout is reserved for newline-delimited JSON-RPC protocol messages. Logs, diagnostics, authentication errors, and progress text are written to stderr or the diagnostic log instead. The command does not open the TUI and does not run the interactive update preflight.

Configure your ACP client to run the `kimi` binary with `acp` as its only argument:

```json
{
  "agent_servers": {
    "Kimi Code": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"]
    }
  }
}
```

If Kimi Code is not authenticated or no default model is configured, `kimi acp` reports that through ACP authentication errors instead of printing setup instructions to stdout. Run `kimi` in a terminal and use `/login`, or configure `KIMI_MODEL_*` environment variables for the ACP server process.

### `kimi migrate`

Migrate local data from an older version of kimi-cli to kimi-code. This command has no flags and runs fully interactively, guiding you through the entire migration process.

```sh
kimi migrate
```

If you previously used an older version of kimi-cli, run this command to migrate historical sessions, configuration, and other data to kimi-code to avoid data loss. For the full migration flow, what gets migrated, and things to watch out for, see [Migrating from kimi-cli](../guides/migration.md).
