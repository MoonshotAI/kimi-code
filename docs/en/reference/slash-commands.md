# Slash Commands

Slash commands are built-in control commands provided by Kimi Code CLI in the interactive TUI, used to switch modes, manage sessions, view status, and more. Type `/` in the input box to trigger command completion; the candidate list filters in real time as you continue typing, and command aliases participate in matching as well.

After typing a full command name (such as `/help`), press `Enter` to execute it. If the `/`-prefixed input does not match any built-in or skill command, it is sent to the agent as an ordinary message.

::: tip Tip
Some commands are only available in the idle state. Running them while the session is streaming a response or compacting the context will be blocked, with a hint to press `Esc` or `Ctrl-C` first to interrupt the current operation. The "Always available" column in the tables below marks commands that remain available during streaming or compacting.
:::

## Account and configuration

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/login` | — | Pick an account or platform and sign in: Kimi Code uses the OAuth device code flow, while Kimi Platform signs in with an API key. | No |
| `/logout` | — | Clear the credentials of the currently selected account (Kimi Code OAuth credentials, or the corresponding open platform provider config). | No |
| `/provider` | — | Open the interactive provider manager to view, add, and delete configured providers. See [Providers and models — `/provider` and provider management](../configuration/providers.md#provider-and-provider-management). | Yes |
| `/model` | — | Switch the LLM model used by the current session. | Yes |
| `/settings` | `/config` | Open the settings panel inside the TUI. | Yes |
| `/permission` | — | Choose a permission mode. | Yes |
| `/editor` | — | Configure the external editor launched by `Ctrl-G`. | Yes |
| `/theme` | — | Switch the terminal UI color theme. | Yes |

## Session management

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/new` | `/clear` | Start a brand-new session, discarding the current context. | No |
| `/sessions` | `/resume` | Browse historical sessions and switch to or resume one. | No |
| `/tasks` | `/task` | Browse the background task list. | Yes |
| `/fork` | — | Fork a new session from the current one, preserving the full conversation history. | No |
| `/title [<text>]` | `/rename` | Without arguments, show the current session title; with an argument, set it as the new title (up to 200 characters). | Yes |
| `/compact [<instruction>]` | — | Compact the current conversation context to free up token usage; optionally pass a custom instruction telling the model what to preserve during compaction. | No |
| `/init` | — | Analyze the current codebase and generate `AGENTS.md`. | No |
| `/export-md [<path>]` | `/export` | Export the current session as a Markdown file. With no argument, writes to `kimi-export-<short-id>-<timestamp>.md` in the working directory; pass a path to choose the output location. | No |
| `/export-debug-zip` | — | Export the current session as a debug ZIP archive (mirrors [`kimi export`](./kimi-command.md#kimi-export)). The archive always includes the active global diagnostic log. | No |

## Mode and runtime control

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/yolo [on\|off]` | `/yes` | Toggle YOLO mode. Without arguments, flip the current state; pass `on`/`off` explicitly to force the corresponding state. When enabled, ordinary tool call approvals are skipped; the Plan mode exit approval is not skipped. | Yes |
| `/auto [on\|off]` | — | Toggle auto permission mode. Without arguments, flip the current state; pass `on`/`off` explicitly to force the corresponding state. When enabled, tool approvals are handled automatically and the agent will not ask questions. | Yes |
| `/plan [on\|off]` | — | Toggle Plan mode. Without arguments, flip the current state; pass `on`/`off` explicitly to force the corresponding state. Toggling alone does not create an empty plan file. | Yes |
| `/plan clear` | — | Clear the current plan. | No |
| `/goal [status\|pause\|resume\|cancel\|replace <objective>\|<objective>]` | — | Start or manage an autonomous goal. This command is experimental. Enable it with `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1`. | See below |

::: warning Note
`/yolo` skips approval confirmation for ordinary tool calls. Make sure you understand the potential risks before enabling it. It does not skip the approval required to leave Plan mode; in Plan mode, `Bash` follows the same ordinary allow rules as `/yolo`.
:::

## Autonomous goals

`/goal` is an experimental command for tasks where you want Kimi Code to keep working through automatic continuation turns. Enable it when starting `kimi`:

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi
```

Experimental flags are read from environment variables. `config.toml` does not currently have an `experimental` option for `/goal`.

Start a goal by writing the objective after the command:

```sh
/goal Update the checkout docs, run the docs build, and stop after 20 turns if this is still blocked
```

Kimi Code saves the objective, sends it as the next user message, and keeps running turns until the goal stops. A goal can stop in three ways:

- `complete`: the objective is done. Kimi Code posts a completion message and clears the goal.
- `paused`: you paused it, interrupted it, or resumed a session that had an active goal. You can resume it later.
- `blocked`: Kimi Code stopped because it needs input, cannot complete the objective as written, hit a configured turn, token, or time budget, or ran into a runtime failure. You can resume it later.

Write stop conditions in the objective itself. `/goal` does not have separate flags for stop limits.

In the TUI, starting or replacing a goal in `manual` permission mode opens a confirmation prompt first. You can switch to `auto`, switch to `yolo`, or start in `manual`. You can also return to the input box with your `/goal` command still there.

`manual` mode is not suitable for unattended goal work. Kimi Code may stop and wait for your approval.

Use these forms to manage the current goal:

| Command | What it does | Availability |
| --- | --- | --- |
| `/goal` or `/goal status` | Show the current goal, status, elapsed time, turn count, token count, and any configured turn, token, or time budget. | Always available |
| `/goal pause` | Pause the active goal and keep it saved. If a response is streaming, the current turn is interrupted. | Always available |
| `/goal resume` | Resume a paused or blocked goal and start a new turn. | Idle only |
| `/goal cancel` | Remove the current goal. If a response is streaming, the current turn is interrupted. | Always available |
| `/goal replace <objective>` | Replace the saved goal with a new objective. | Idle only |

Only one goal can be saved in a session. If you already have one, start a different one with `/goal replace <objective>`.

The words `status`, `pause`, `resume`, `cancel`, and `replace` act as subcommands only when they are the first word after `/goal`. If your objective needs to start with one of those words, put `--` before it:

```sh
/goal -- cancel the old rollout note after the new docs are published
```

In non-interactive prompt mode, only the create forms start goal mode:

```sh
KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1 kimi -p "/goal Fix the failing checkout test"
```

Prompt mode exits with code `0` when the goal completes, `3` when it blocks, and `6` when it pauses. Other `/goal` subcommands are TUI controls and are not handled by `kimi -p`.

## Information and status

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/help` | `/h`, `/?` | Show keyboard shortcuts and all available commands. | Yes |
| `/usage` | — | Show token usage, context consumption, and quota information. | Yes |
| `/status` | — | Show the current session runtime status, including version, model, working directory, and permission mode. | Yes |
| `/mcp` | — | List the MCP servers in the current session and their connection status. | Yes |
| `/plugins` | — | Open the interactive plugin manager for user/global installs: install, inspect, enable, disable, confirm removal, reload, browse the official marketplace, and toggle plugin MCP servers. Shortcut subcommands remain available. | Yes |
| `/version` | — | Show the Kimi Code CLI version number. | Yes |
| `/feedback` | — | Submit feedback to help improve Kimi Code CLI. | Yes |

## Exit

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/exit` | `/quit`, `/q` | Exit Kimi Code CLI. | No |

## Dynamic skill commands

In addition to the built-in commands, user-activatable skills are automatically registered as slash commands under the `skill:` namespace:

```
/skill:<name> [extra text]
```

For example, `/skill:code-style` loads the content of the `code-style` skill and sends it to the agent; any text after the command is appended to the skill prompt, as in `/skill:git-commits fix the login failure issue`.

For convenience, skill commands also support a short form `/<name>` that omits the `skill:` prefix, provided the name is not already taken by a built-in command. In other words, `/code-style` falls back to matching `/skill:code-style`.

Kimi Code CLI ships with a built-in `mcp-config` skill for configuring MCP servers and handling MCP OAuth login. It still belongs to the skill namespace in completion and help (`/skill:mcp-config`), and it can also be invoked directly as `/mcp-config`.

Skill types that can be exposed as slash commands include `prompt`, `inline`, `flow`, and skills without an explicitly declared type. For skill installation and authoring, see [Agent Skills](../customization/skills.md).

::: info Note
All skill commands are only available while the agent is idle; during streaming or compacting, press `Esc` or `Ctrl-C` first to interrupt the current operation.
:::

::: info Note
Flow-type skills are also exposed via `/skill:<name>`; there is no separate `/flow:` namespace.
:::
