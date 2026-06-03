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
| `/provider` | — | Open the interactive provider manager to view, add, and remove configured providers. See [Platforms & Models — `/provider` and provider management](../configuration/providers-and-models.md#provider-与供应商管理) | Yes |
| `/model` | — | Switch the LLM model used in the current session | Yes |
| `/settings` | `/config` | Open the settings panel inside the TUI | Yes |
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
| `/goal [...]` | — | Start or manage an autonomous goal (experimental feature, requires `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1`) | See below |

::: warning
`/yolo` skips approval for regular tool calls. Please make sure you understand the potential risks before enabling it. Plan mode exit approval is not bypassed by `/yolo`; `Bash` inside Plan mode is still subject to the regular `/yolo` allow rules.
:::

## Autonomous Goal (Experimental)

::: info
`/goal` is an experimental command. Enable it by setting an environment variable when starting `kimi`:
```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```
:::

`/goal` is for tasks you want Kimi Code to work on continuously across automatically continuing turns. Write the goal after the command to start:

```
/goal Update the checkout docs, run docs build, and stop if still blocked after 20 turns
```

Kimi Code saves the goal, sends it as the next User message, and keeps running subsequent turns until the goal stops. A goal has three stop states:

- `complete`: The goal is done — Kimi Code sends a completion message and clears the goal
- `paused`: You paused the goal, interrupted the current turn, or resumed a session that had an active goal
- `blocked`: Kimi Code stopped because it needs input, cannot complete the goal, reached a budget limit, or encountered a runtime failure

Stop conditions must be written into the goal itself; `/goal` has no separate stop-limit flag.

Subcommands for managing the current goal:

| Command | Action | Availability |
| --- | --- | --- |
| `/goal` or `/goal status` | Display the current goal along with its status, elapsed time, turn count, and token count | Always available |
| `/goal pause` | Pause an active goal and keep it | Always available |
| `/goal resume` | Resume a paused or blocked goal | Idle only |
| `/goal cancel` | Remove the current goal | Always available |
| `/goal replace <objective>` | Replace the saved goal with a new objective | Idle only |

Only one goal can be saved per session. If the objective needs to start with a subcommand keyword such as `status` or `pause`, use `--` as a separator:

```
/goal -- cancel The function needs to return a retryable error on order failure, with tests added
```

In `manual` permission mode, the goal may pause to wait for tool call approval — not suitable for unattended scenarios.

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

Activated Skills are automatically registered as slash commands, all prefixed with the `skill:` namespace:

```
/skill:<name> [extra text]
```

For example, `/skill:code-style` loads the Skill named `code-style` and sends it to the Agent; any text appended after the command is concatenated to the Skill prompt.

For convenience, Skill commands also support a shorthand form that omits the `skill:` prefix — `/<name>` — as long as the name is not taken by a built-in command. That is, `/code-style` falls back to matching `/skill:code-style`.

Kimi Code CLI ships a built-in `mcp-config` Skill for configuring MCP servers and handling MCP OAuth login; invoke it directly with `/mcp-config`.

::: info
All Skill commands are only available in the idle state. `flow`-type Skills are also exposed via `/skill:<name>` — there is no separate `/flow:` namespace.
:::

For installing and authoring Skills, see [Agent Skills](../customization/skills.md).

## Next steps

- [Keyboard Shortcuts](./keyboard-shortcuts.md) — Quick reference for TUI keyboard operations
- [Built-in Tools](./tools.md) — Complete reference for tools the Agent can call
