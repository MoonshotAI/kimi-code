# Slash Commands

Slash commands are built-in control commands provided by Kimi Code CLI in the interactive TUI, covering account configuration, session management, mode switching, information queries, and more. Type `/` in the input box to trigger command completion — the candidate list filters in real time as you continue typing; command aliases are also matched.

After typing the full command name, press `Enter` to execute. If the `/`-prefixed input does not match any built-in or Skill command, it is sent to the Agent as a regular message.

::: tip
Some commands are only available in the idle state. Executing these commands while a session is streaming output or compacting context will be blocked — press `Esc` or `Ctrl-C` to interrupt first. The "Always available" column in the tables below indicates commands that are also available during streaming.
:::

## Account & Configuration

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/login` | — | Select an account or platform and log in: Kimi Code uses OAuth device-code flow; Kimi Platform uses API key login | No |
| `/logout` | — | Clear credentials for the currently selected account | No |
| `/provider` | — | Open the interactive provider manager to view, add, and remove configured providers. See [Platforms & Models — `/provider` and provider management](../configuration/providers.md#provider-与供应商管理) | Yes |
| `/model` | — | Switch the LLM model used in the current session | Yes |
| `/settings` | `/config` | Open the settings panel inside the TUI | Yes |
| `/experiments` | `/experimental` | Open the experimental feature panel. Confirm changes to persist them to `config.toml` and reload the current session | Yes |
| `/permission` | — | Select a permission mode | Yes |
| `/editor` | — | Configure the external editor launched by `Ctrl-G` | Yes |
| `/theme` | — | Switch the terminal UI color theme | Yes |

## Session Management

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/new` | `/clear` | Start a fresh session, discarding the current context | No |
| `/sessions` | `/resume` | Browse historical sessions and switch to / restore one | No |
| `/tasks` | `/task` | Browse the background task list | Yes |
| `/fork` | — | Fork a new session from the current one, preserving the full conversation history | No |
| `/title [<text>]` | `/rename` | Without arguments, display the current session title; with an argument, set a new title (max 200 characters) | Yes |
| `/compact [<instruction>]` | — | Compact the current conversation context to free up token usage; an optional custom instruction can hint to the model what to preserve | No |
| `/reload` | — | Reload the current session and apply the latest `config.toml` settings (providers, models, etc.) and `tui.toml` UI preferences, without restarting the CLI | No |
| `/reload-tui` | — | Reload only the `tui.toml` UI preferences (theme, editor, notifications, etc.) without rebuilding the session | Yes |
| `/init` | — | Analyze the current codebase and generate `AGENTS.md` | No |
| `/export-md [<path>]` | `/export` | Export the current session as a Markdown file | No |
| `/export-debug-zip` | — | Export the current session as a debug ZIP archive (same behavior as [`kimi export`](./kimi-command.md#kimi-export)) | No |

## Modes & Run Control

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/yolo [on\|off]` | `/yes` | Toggle YOLO mode. Without arguments, flips the current state; explicitly passing `on`/`off` forces the setting. When enabled, skips approval for regular tool calls; Plan mode exit approval is not affected | Yes |
| `/auto [on\|off]` | — | Toggle auto permission mode. When enabled, tool approvals are handled automatically and the Agent will not ask the user questions | Yes |
| `/plan [on\|off]` | — | Toggle Plan mode. Without arguments, flips the current state; explicitly passing `on`/`off` forces the setting. Simply toggling does not create an empty plan file | Yes |
| `/plan clear` | — | Clear the current plan | No |
| `/goal [...]` | — | Start or manage an autonomous goal (experimental feature; enable it from `/experiments`, `[experimental].goal_command`, or `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1`) | See below |

::: warning
`/yolo` skips approval for regular tool calls. Please make sure you understand the potential risks before enabling it. Plan mode exit approval is not bypassed by `/yolo`; `Bash` inside Plan mode is still subject to the regular `/yolo` allow rules.
:::

## Autonomous Goal (Experimental)

::: info
`/goal` is an experimental command. Enable it from `/experiments`, or write it in `~/.kimi-code/config.toml`:
```toml
[experimental]
goal_command = true
```

You can also override the setting for one process with an environment variable:
```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```
:::

`/goal` starts or manages goal mode: a persistent objective that Kimi Code works toward across automatically continuing turns. For usage guidance and examples, see [Goals](../guides/goals.md).

```sh
/goal Update the checkout docs, run docs build, and stop if still blocked after 20 turns
```

| Command | Action | Availability |
| --- | --- | --- |
| `/goal` or `/goal status` | Display the current goal along with its status, elapsed time, turn count, and token count | Always available |
| `/goal pause` | Pause an active goal and keep it | Always available |
| `/goal resume` | Resume a paused or blocked goal | Idle only |
| `/goal cancel` | Remove the current goal | Always available |
| `/goal replace <objective>` | Replace the saved goal with a new objective | Idle only |
| `/goal next <objective>` | Queue an upcoming goal for this session. If no goal is active, start it immediately. The agent does not see queued goals until the current goal completes | Always available |
| `/goal next manage` | Open the upcoming-goal manager. Use <kbd>↑</kbd> / <kbd>↓</kbd> to browse, <kbd>Space</kbd> to select a goal for moving, selected <kbd>↑</kbd> / <kbd>↓</kbd> to reorder it, <kbd>E</kbd> to edit, <kbd>D</kbd> to delete, and <kbd>Esc</kbd> to cancel. In the edit field, use <kbd>Shift-Enter</kbd> or <kbd>Ctrl-J</kbd> for a new line and <kbd>Enter</kbd> to save | Always available |

The words `status`, `pause`, `resume`, `cancel`, `replace`, and `next` act as subcommands only when they are the first word after `/goal`. If your objective needs to start with one of those words, put `--` before it:

```sh
/goal -- cancel the old rollout note after the new docs are published
```

If an upcoming goal needs to start with `manage`, put `--` after `next`:

```sh
/goal next -- manage the release checklist
```

In non-interactive prompt mode, only the create forms start goal mode:

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi -p "/goal Fix the failing checkout test"
```

Prompt mode exits with code `0` when the goal completes, `3` when it blocks, and `6` when it pauses. Other `/goal` subcommands, including `next`, are TUI controls and are not handled by `kimi -p`.

## Information & Status

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/help` | `/h`, `/?` | Show keyboard shortcuts and all available commands | Yes |
| `/btw [question]` | — | Open a side conversation in a forked sub-Agent without affecting the current main Agent turn; without a question, opens the panel first to wait for input | Yes |
| `/usage` | — | Show token usage, context consumption, and quota information | Yes |
| `/status` | — | Show the current session runtime state: version, model, working directory, permission mode, etc. | Yes |
| `/mcp` | — | List MCP servers and their connection status in the current session | Yes |
| `/plugins` | — | Open the interactive plugin manager | Yes |
| `/version` | — | Display the Kimi Code CLI version number | Yes |
| `/feedback` | — | Submit feedback to help improve Kimi Code CLI | Yes |

## Exit

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/exit` | `/quit`, `/q` | Exit Kimi Code CLI | No |

## Skill Dynamic Commands

Activated external Skills are automatically registered as slash commands with the `skill:` namespace prefix:

```
/skill:<name> [extra text]
```

For example, `/skill:code-style` loads the Skill named `code-style` and sends it to the Agent; any text appended after the command is concatenated to the Skill prompt.

For convenience, external Skill commands also support a shorthand form that omits the `skill:` prefix — `/<name>` — as long as the name is not taken by a system slash command. That is, `/code-style` falls back to matching `/skill:code-style`.

Built-in Skills shipped with Kimi Code CLI, such as `mcp-config`, appear directly as `/<name>` in the slash command panel for cases like configuring MCP servers and handling MCP OAuth login.

::: info
All Skill commands are only available in the idle state. `flow`-type Skills are also exposed via `/skill:<name>` — there is no separate `/flow:` namespace.
:::

For installing and authoring Skills, see [Agent Skills](../customization/skills.md).

## Next steps

- [Keyboard Shortcuts](./keyboard.md) — Quick reference for TUI keyboard operations
- [Built-in Tools](./tools.md) — Complete reference for tools the Agent can call
