# `kimi acp` Subcommand

`kimi acp` switches Kimi Code CLI to **ACP (Agent Client Protocol)** mode: it communicates with an ACP client (such as Zed, JetBrains AI Chat, etc.) via JSON-RPC over stdin/stdout, letting the IDE directly drive kimi's sessions, prompts, and tool calls.

```sh
kimi acp
```

Once started, the command prints no banner and immediately waits for the ACP client to send an `initialize` request on stdin. Logs are written to stderr (as well as the diagnostic log under `~/.kimi-code/logs/`), so the ACP channel itself stays clean.

::: tip Who calls this?
You typically do not need to run `kimi acp` manually — this command is the subprocess entry point for IDEs. For IDE-side configuration, see [Using in IDEs](../guides/ides.md).
:::

## Capability Matrix

The table below lists the capabilities declared by the current ACP adapter layer. The `agentCapabilities` field is returned in full in the `initialize` response, so the IDE can adjust its UI accordingly.

| Capability | Value | Description |
| --- | --- | --- |
| `promptCapabilities.image` | `true` | Supports ACP `image` content blocks (base64 + mimeType) |
| `promptCapabilities.audio` | `false` | Audio prompts not yet supported |
| `promptCapabilities.embeddedContext` | `true` | Client may send `resource`/`resource_link` embedded resource blocks; text content is injected into the prompt as `<resource uri="...">...</resource>`; blob resources are dropped with a warn |
| `mcpCapabilities.http` | `true` | Forwards HTTP MCP services configured by the IDE |
| `mcpCapabilities.sse` | `true` | Forwards legacy SSE MCP services configured by the IDE |
| `loadSession` | `true` | Supports `session/load` to resume an existing session, replaying history on load |
| `sessionCapabilities.list` | `{}` | Supports `session/list` to enumerate the current user's sessions |

## ACP Method Coverage

The spec divides methods into a **stable** surface and an evolving **unstable** surface (handlers mounted with the `unstable_*` prefix in `@agentclientprotocol/sdk@0.23.0`). The two have entirely different stability guarantees — the stable surface covers methods every production ACP client uses, while the unstable surface covers experimental extensions (inline-edit prediction, document buffer sync, provider management, elicitation, etc.) — so they are tracked separately.

**Summary: stable agent-side 10/12 (83%) + client reverse-RPC 4/9 (44%); unstable surface has only `session/set_model` (1/19).** All methods needed for a normal agent flow (initialize → auth → new/load/resume → prompt → cancel + file I/O + tool approval) are implemented.

### Stable agent-side — IDE → agent (10 / 12)

| Method | Implemented | Description |
| --- | --- | --- |
| `initialize` | Yes | Version negotiation; returns `agentInfo: { name: 'Kimi Code CLI', version }`, capability matrix, and `authMethods` |
| `authenticate` | Yes | Validates `method_id='login'`; returns `authRequired (-32000)` if token is missing, `invalidParams (-32602)` for unknown ID |
| `session/new` | Yes | Accepts `cwd` / `mcpServers`; returns `configOptions[]` |
| `session/load` | Yes | Restores a session from disk and replays history via `session/update` |
| `session/resume` | Yes | Lightweight sibling of `session/load`; skips history replay |
| `session/prompt` | Yes | Accepts `text` / `image` / `resource` / `resource_link` content blocks; streams `agent_message_chunk` |
| `session/cancel` | Yes | Interrupts the current turn |
| `session/list` | Yes | Enumerates sessions on disk (advertised via `sessionCapabilities.list = {}`) |
| `session/set_mode` | Yes | Compatibility path; dispatches to the same handler as `set_config_option({configId:'mode'})` |
| `session/set_config_option` | Yes | Unified model / thinking / mode picker dispatcher |
| `session/close` | No | |
| `logout` | No | |

### Stable client-side reverse-RPC — agent → IDE (4 / 9)

| Method | Implemented | Description |
| --- | --- | --- |
| `session/update` | Yes | Streams `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | Yes | Shared channel for tool approval and question elicitation |
| `fs/read_text_file` | Yes | File reads at the kaos layer are routed to the client (advertised via `fsCapabilities`) |
| `fs/write_text_file` | Yes | File writes at the kaos layer are routed to the client |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | No | Terminal reverse-RPC not connected; shell commands use local execution |

### Unstable surface (1 / 19)

| Method | Implemented | Description |
| --- | --- | --- |
| `session/set_model` | Yes | Compatibility path; equivalent to `set_config_option({configId:'model'})` |
| Remaining 18 methods | No | Includes session lifecycle extensions, buffer sync, inline-edit prediction, provider management, etc. |

All methods not listed above return `methodNotFound`.

## Extension methods (`kimi/*` namespace)

Adapter-owned extensions live in the `kimi/*` namespace so they never collide with future ACP spec methods. Unknown extension methods return `methodNotFound (-32601)`.

| Method | Params | Returns | Description |
| --- | --- | --- | --- |
| `kimi/session/fork` | `{ sessionId }` | `{ sessionId }` | Forks the session into an ephemeral copy and registers it as a first-class ACP session the client can `session/prompt` normally (btw-style side conversation that cannot pollute the source context). Rejected while the source has an active turn. Inherits the source session's model/thinking state; ACP-supplied MCP servers are not carried over. |
| `kimi/session/close` | `{ sessionId, archive? }` | `{}` | Closes the session and drops it from the adapter. With `archive: true` the on-disk session directory is archived as well (the fork cleanup path); otherwise the session stays resumable. |

## Built-in slash commands

Slash commands sent as plain-text `session/prompt` blocks are intercepted by the adapter. Advertised to the client via `available_commands_update` after every `session/new` / `session/load` / `session/resume`:

| Command | Args | Description |
| --- | --- | --- |
| `/compact` | `<optional instruction>` | Compacts the conversation context, with an optional custom summarization instruction |
| `/undo` | `<optional count>` | Undoes the last N turns (default 1); refused while a turn is running |
| `/status` | — | Shows current session status |
| `/usage` | — | Shows session token usage |
| `/mcp` | — | Shows MCP server status |
| `/tasks` | — | Lists background tasks |
| `/help` | — | Shows available ACP commands |

Unknown slash commands are answered locally with an "unknown command" notice instead of being forwarded to the model.

## MCP Forwarding

When an ACP client provides `mcpServers` in `session/new` or `session/load`, the adapter layer performs the following conversions:

- `http` → kimi's `transport: 'http'` configuration
- `stdio` → kimi's `transport: 'stdio'` configuration
- `sse` → kimi's `transport: 'sse'` configuration
- `acp` → discarded with a warn log entry

## Next steps

- [Using in IDEs](../guides/ides.md) — Zed / JetBrains configuration steps and troubleshooting
- [`kimi` Command Reference](./kimi-command.md) — Complete subcommand list
