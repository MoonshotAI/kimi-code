# `kimi acp` Subcommand

`kimi acp` switches Kimi Code CLI to **ACP (Agent Client Protocol)** mode: it communicates with an ACP client (such as Zed, JetBrains AI Chat, etc.) via JSON-RPC over stdin/stdout, letting the IDE directly drive kimi's sessions, prompts, and tool calls.

```sh
kimi acp
```

Once started, the command prints no banner and immediately waits for the ACP client to send an `initialize` request on stdin. Logs are written to stderr (as well as the diagnostic log under `~/.kimi-code/logs/`), so the ACP channel itself stays clean.

::: tip Who calls this?
You typically do not need to run `kimi acp` manually — this command is the subprocess entry point for IDEs. For IDE-side configuration, see [Using in IDEs](../guides/ides.md).
:::

## Capability matrix

The table below lists the capabilities declared by the ACP server. The `agentCapabilities` field is returned in full in the `initialize` response, so the IDE can adjust its UI accordingly.

| Capability | Value | Description |
| --- | --- | --- |
| `loadSession` | `true` | Supports `session/load` to resume an existing session, replaying history on load |
| `promptCapabilities.image` | `true` | Supports ACP `image` content blocks (base64 + mimeType) |
| `promptCapabilities.audio` | `false` | Audio prompts not yet supported |
| `promptCapabilities.embeddedContext` | `true` | Client may send `resource`/`resource_link` embedded resource blocks; text content is injected into the prompt as `<resource uri="...">...</resource>`; blob resources are dropped with a warn |
| `sessionCapabilities.list` | `{}` | Supports `session/list` to enumerate the current user's sessions |
| `sessionCapabilities.resume` | `{}` | Supports `session/resume` to reattach to a session without history replay |
| `sessionCapabilities.close` | `{}` | Supports `session/close` to tear down a live session |
| `sessionCapabilities.delete` | `{}` | Supports `session/delete` to permanently remove a session |
| `sessionCapabilities.fork` | `{}` | Supports `session/fork` to branch an existing session |
| `sessionCapabilities.additionalDirectories` | `{}` | Extra working directories; honored on `session/new` only |
| `mcpCapabilities.http` | `true` | Forwards HTTP MCP services configured by the IDE |
| `mcpCapabilities.sse` | `true` | Forwards legacy SSE MCP services configured by the IDE |
| `auth.logout` | `{}` | Supports ACP `logout` to drop the managed provider's token |

## ACP method coverage

With `@agentclientprotocol/sdk@1.x`, the ACP method set is organized by namespace: `core` and `session` cover the main agent flow, while `providers`, `nes` (inline-edit prediction), and `document` (buffer sync) are optional extension surfaces. On the client side, reverse-RPC methods are grouped under `session`, `fs`, `terminal`, and `elicitation`.

**Summary: the ACP server implements the full core (3/3) and session (11/11) agent-side surface, 10/11 client reverse-RPC methods, and the `session/set_model` extension. Not implemented: `providers/*`, `nes/*`, `document/*`, and `elicitation/complete` — requests for them return `methodNotFound`.**

### Core agent-side — IDE → agent (3 / 3)

| Method | Implemented | Description |
| --- | --- | --- |
| `initialize` | Yes | Version negotiation; returns `agentInfo: { name: 'Kimi Code CLI', version }`, capability matrix, and `authMethods` (first-class `type:'terminal'` plus the legacy `_meta['terminal-auth']` fallback) |
| `authenticate` | Yes | Validates `method_id='login'`; returns `authRequired (-32000)` if the token is missing, `invalidParams (-32602)` for an unknown ID |
| `logout` | Yes | Drops the managed provider's token; subsequent gated calls return `auth_required` again |

### Session agent-side — IDE → agent (11 / 11)

| Method | Implemented | Description |
| --- | --- | --- |
| `session/new` | Yes | Accepts `cwd` / `mcpServers` / `additionalDirectories`; returns `sessionId` + `configOptions[]` + `modes` |
| `session/load` | Yes | Restores a session from disk and replays history via `session/update` before the response settles |
| `session/resume` | Yes | Lightweight sibling of `session/load`; skips history replay |
| `session/list` | Yes | Enumerates sessions on disk, filterable by `cwd` |
| `session/fork` | Yes | Branches a source session; `cwd` / `additionalDirectories` / `mcpServers` on the request are ignored with a warning |
| `session/close` | Yes | Best-effort teardown: cancels any in-flight turn, disposes per-session resources, and closes the live session; an unknown id is not an error |
| `session/delete` | Yes | Permanently removes a session and its persisted data; an unknown id returns `invalidParams (-32602)` |
| `session/prompt` | Yes | Accepts `text` / `image` / `resource` / `resource_link` content blocks; streams `agent_message_chunk` |
| `session/cancel` | Yes | Interrupts the current turn (a JSON-RPC `$/cancel_request` for a prompt lands in the same cancel path) |
| `session/set_mode` | Yes | Validates `modeId`; the same underlying mode switch as `set_config_option({configId:'mode'})` |
| `session/set_config_option` | Yes | Unified model / thinking / mode picker dispatcher |

### Client-side reverse-RPC — agent → IDE (10 / 11)

| Method | Implemented | Description |
| --- | --- | --- |
| `session/update` | Yes | Streams `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | Yes | Shared channel for tool approval and question prompts |
| `fs/read_text_file` | Yes | Engine file reads are routed to the client when it advertises `fsCapabilities` |
| `fs/write_text_file` | Yes | Engine file writes are routed to the client |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | Yes | Shell executions reverse-RPC to the client when it advertises `clientCapabilities.terminal` |
| `elicitation/create` | Yes | Ask-user questions go through the native form when the client advertises `elicitation.form`; RPC failures fall back to `session/request_permission` |
| `elicitation/complete` | No | |

### Extension methods

| Method | Implemented | Description |
| --- | --- | --- |
| `session/set_model` | Yes | Carried over from the ACP 0.23 unstable surface as an extension method; equivalent to `set_config_option({configId:'model'})` |

All methods not listed above return `methodNotFound`.

## MCP forwarding

When an ACP client provides `mcpServers` in `session/new` or `session/load`, the ACP server performs the following conversions:

- `http` → kimi's `transport: 'http'` configuration
- `stdio` → kimi's `transport: 'stdio'` configuration
- `sse` → kimi's `transport: 'sse'` configuration
- `acp` → discarded with a warn log entry

## Next steps

- [Using in IDEs](../guides/ides.md) — Zed / JetBrains configuration steps and troubleshooting
- [`kimi` Command Reference](./kimi-command.md) — Complete subcommand list
