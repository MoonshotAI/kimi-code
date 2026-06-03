# Using in IDEs

Kimi Code CLI integrates with IDEs through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), so you can use AI-assisted coding directly inside your editor.

## Prerequisites

Before configuring your IDE, make sure Kimi Code CLI is installed and signed in.

The ACP adapter exposes a `kimi acp` subcommand. The IDE launches it as a child process and speaks JSON-RPC on its stdio. Every session reuses the CLI's existing auth state — no separate login is required from inside the IDE.

::: tip Path note
On macOS, child processes spawned by an IDE's GUI typically do **not** inherit the `PATH` from your terminal shell. If `kimi` lives anywhere other than the usual `/usr/local/bin`-style directories, configure the IDE with an **absolute path**. Run `which kimi` in a terminal to find the current location.
:::

## Using in Zed

[Zed](https://zed.dev/) is a modern editor with native ACP support.

Add the following to Zed's configuration file `~/.config/zed/settings.json`:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "type": "custom",
      "command": "kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

Field reference:

- `type`: fixed value `"custom"`.
- `command`: path to the Kimi Code CLI executable. If `kimi` is not on `PATH`, use a full absolute path (e.g. `/Users/you/.local/bin/kimi`).
- `args`: startup arguments. The `acp` subcommand switches Kimi Code into ACP mode.
- `env`: extra environment variables. Usually empty — Zed injects a sensible default environment.

After saving, opening a new chat in Zed's Agent panel will spawn an ACP-mode `kimi` subprocess using your configuration. Any MCP servers declared inside Zed's `agent_servers` block are forwarded to Kimi Code via the ACP protocol.

## Using in JetBrains IDEs

JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, …) support ACP through the AI Chat plugin.

If you do not have a JetBrains AI subscription, enable `llm.enable.mock.response` in the Registry so you can still reach the AI Chat panel when only ACP is needed. Press Shift twice to search for "Registry" and open it.

From the AI Chat panel menu, click "Configure ACP agents" and add the following:

```json
{
  "agent_servers": {
    "Kimi Code CLI": {
      "command": "~/.local/bin/kimi",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

JetBrains is strict about the `command` field — always use an **absolute path**. `which kimi` in a terminal will print the right value. After saving, `Kimi Code CLI` will appear in the AI Chat Agent selector.

## Troubleshooting

- **The session terminates immediately / the IDE shows "agent exited"**: usually a bad `command` path or the CLI is not signed in. Run `kimi acp` in a terminal: if it blocks waiting for stdin, the CLI itself is healthy and the issue is the IDE config; if it errors immediately, follow the message (most commonly `/login` is missing).
- **The IDE shows "auth required"**: there's no usable auth token. Quit the IDE, run `kimi` in a terminal to sign in, then relaunch the IDE.
- **MCP tools don't show up**: see the capability matrix in [`kimi acp`](../reference/kimi-acp.md) and confirm the MCP transport you configured is supported. The current ACP adapter forwards `http` and `stdio` transports; `sse` and `acp` MCP entries are silently dropped and a warn line is written to the diagnostic log.
