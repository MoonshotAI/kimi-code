# Slash Commands

Slash commands are built-in control commands provided by Kimi Code CLI in the interactive TUI, used to switch modes, manage sessions, view status, and more. Type `/` in the input box to trigger command completion; the candidate list filters in real time as you continue typing, and command aliases participate in matching as well.

After typing a full command name (such as `/help`), press `Enter` to execute it. If the `/`-prefixed input does not match any built-in or skill command, it is sent to the agent as an ordinary message.

::: tip Tip
Some commands are only available in the idle state. Running them while the session is streaming a response or compacting the context will be blocked, with a hint to press `Esc` or `Ctrl-C` first to interrupt the current operation. The "Always available" column in the tables below marks commands that remain available during streaming or compacting.
:::

## Account and configuration

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/login` | — | Pick an account or platform and sign in: Kimi Code uses the OAuth device code flow, while the Moonshot AI Open Platform signs in with an API key. | No |
| `/logout` | — | Clear the credentials of the currently selected account (Kimi Code OAuth credentials, or the corresponding open platform provider config). | No |
| `/connect [--refresh] [--url=<catalog-url>]` | — | Configure a provider and model from a model catalog. The default catalog is bundled with the CLI; pass `--refresh` to fetch the latest catalog from models.dev, or `--url` to read it from a custom URL. See [Providers and models — `/connect` and the model catalog](../configuration/providers.md#connect-and-the-model-catalog). | No |
| `/model` | — | Switch the LLM model used by the current session. | No |
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
| `/yolo [on\|off]` | `/yes` | Toggle auto-approve mode. Without arguments, flip the current state; pass `on`/`off` explicitly to force the corresponding state. When enabled, ordinary tool call approvals are skipped; the Plan mode exit approval is not skipped. | Yes |
| `/plan [on\|off]` | — | Toggle Plan mode. Without arguments, flip the current state; pass `on`/`off` explicitly to force the corresponding state. Toggling alone does not create an empty plan file. | Yes |
| `/plan clear` | — | Clear the current plan. | No |

::: warning Note
`/yolo` skips approval confirmation for ordinary tool calls. Make sure you understand the potential risks before enabling it. It does not skip the approval required to leave Plan mode; in Plan mode, `Bash` follows the same ordinary allow rules as `/yolo`.
:::

## Information and status

| Command | Alias | Description | Always available |
| --- | --- | --- | --- |
| `/help` | `/h`, `/?` | Show keyboard shortcuts and all available commands. | Yes |
| `/usage` | — | Show token usage, context consumption, and quota information. | Yes |
| `/status` | — | Show the current session runtime status, including version, model, working directory, and permission mode. | Yes |
| `/mcp` | — | List the MCP servers in the current session and their connection status. | Yes |
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
