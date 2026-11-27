# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that lets models safely call external tools, such as reading GitHub issues, querying databases, or operating the local file system. Kimi Code CLI acts as an MCP client to connect these servers and makes their tools available to the agent alongside built-in tools.

To connect an MCP server, choose a connection method and add it to `mcp.json`, or run `/mcp-config` in the TUI. Tools load on demand by default to save context; session startup waits at most 2 seconds for initial tool discovery while slower servers keep connecting in the background.

## Connection methods

Choose a connection method based on how the server runs; prefer HTTP or stdio for new setups:

- **stdio**: The CLI starts the server as a child process and communicates over standard input/output, suitable for local command-line tools. It runs locally by default; set [`environment_id`](#running-stdio-servers-in-a-remote-environment) to start it in a [remote environment](../guides/remote-environment.md).
- **HTTP**: The CLI connects to a running HTTP endpoint, suitable for remote services or persistent processes.
- **SSE**: Connects to a legacy HTTP+SSE endpoint (Server-Sent Events). Set `transport: "sse"` explicitly only when a service still exposes SSE alone.

## Configuration

Configuration has two levels, and a project-level entry overrides a user-level entry with the same name:

- **User level**: `~/.kimi-code/mcp.json`, shared across projects, or `$KIMI_CODE_HOME/mcp.json` when `KIMI_CODE_HOME` is set.
- **Project level**: `.kimi-code/mcp.json` at the repository root, effective only for that repository. Starting in a subdirectory still reads the repository-root file, and each worktree reads its own.

Run `/mcp-config` in the TUI to add, edit, or remove servers interactively, and `/mcp` to check connection status. Changes take effect as follows:

- **Editing `mcp.json` or installing a new plugin**: applies only to sessions created later.
- **Deleting a server**: does not interrupt open sessions; its tools stay visible but calls fail with a removal notice, `/mcp` shows `removed`, and new sessions do not register it.
- **Managing in `/plugins`**: disabling or removing a server makes calls in open sessions fail immediately; adding or enabling one connects it to open sessions right away.

Example `mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    },
    "legacy-events": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

Entries with `command` are stdio servers; entries with `url` and no `transport` are HTTP servers; SSE servers require `transport: "sse"`.

Optional fields:

| Field | Type | Applies to | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | Environment variables injected into the child process |
| `environment_id` | `string` | stdio | Id of the [remote environment](../guides/remote-environment.md) that starts the server; defaults to `local` |
| `cwd` | `string` | stdio | Working directory for the child process |
| `headers` | `Record<string, string>` | HTTP, SSE | Static request headers appended to every request |
| `bearerTokenEnvVar` | `string` | HTTP, SSE | Name of an environment variable containing a bearer token |
| `enabled` | `boolean` | All | Set to `false` to disable this server |
| `deferred` | `boolean` | All | Set to `false` to put tools directly into the top-level list; defaults to global `default_deferred` (load on demand). See [Loading tools on demand](#loading-tools-on-demand) |
| `startupTimeoutMs` | `number` | All | Connection timeout from `1` to `2147483647` ms; default `30000` |
| `toolTimeoutMs` | `number` | All | Single tool-call timeout from `1` to `2147483647` ms |
| `enabledTools` | `string[]` | All | Tool allowlist |
| `disabledTools` | `string[]` | All | Tool blocklist |

Plugins can also declare MCP servers in their manifest, enabled by default. See [Plugins](./plugins.md#mcp-servers-in-plugins).

::: warning Note
stdio entries in a project-level `.kimi-code/mcp.json` execute commands when a session starts. Only enable them in repositories you trust.
:::

### Authentication and OAuth

Pass static credentials with `headers` or `bearerTokenEnvVar`. For OAuth, run `/mcp-config login <server-name>` to authorize in the browser.

After you approve an MCP authentication tool call in chat, you still need to confirm access on the provider's website: the desktop app opens your system browser, and the web UI shows an **Open authorization page** button in the chat card. If the browser does not open or you close the tab, click the same button to continue without resending the message.

## Workspace trust

Because a project-level `mcp.json` can run local commands, Kimi Code enables it only in trusted workspaces:

- **Interactive sessions**: When Kimi Code finds MCP servers in an untrusted project, the terminal lists each server's transport and launch target. Review the command, arguments, or remote URL and choose `Trust and continue` to enable them, or `Exit` to quit without enabling them.
- **Headless runs**: Commands such as `kimi -p` in CI cannot show a prompt, so project-level servers stay disabled in untrusted workspaces. Set [`KIMI_CODE_TRUST_WORKSPACE`](../configuration/env-vars.md#runtime-switches) to `1` to trust the current process, or set [`[workspace] require_trust = false`](../configuration/config-files.md#workspace-trust) in `config.toml` to disable the check globally only when every workspace is trusted.

## Connection, timeouts, and reconnection

Slow startups and temporary drops do not block conversation: initial discovery has a wait cap, and dropped connections retry automatically. Adjust runtime settings in `config.toml` or environment variables:

| Behavior | `[mcp]` field / environment variable | Default |
| --- | --- | --- |
| Initial discovery wait cap | `startup_wait_ms` / `KIMI_MCP_STARTUP_WAIT_MS` | `2000` ms; `0` skips waiting |
| Connection timeout | `startup_timeout_ms` / `KIMI_MCP_STARTUP_TIMEOUT_MS` | `30000` ms |
| Single tool-call timeout | `tool_timeout_ms` / `KIMI_MCP_TOOL_TIMEOUT_MS` | Per-server `toolTimeoutMs` |
| First reconnect delay | `reconnect_initial_delay_ms` / `KIMI_MCP_RECONNECT_INITIAL_DELAY_MS` | `5000` ms |
| Maximum reconnect delay | `reconnect_max_delay_ms` / `KIMI_MCP_RECONNECT_MAX_DELAY_MS` | `300000` ms |

Timeout precedence is: server field > environment variable > `config.toml` > built-in default. See [Configuration files](../configuration/config-files.md#mcp).

**Startup waiting**: When the wait cap is reached, the conversation starts with the tools already available. Servers still starting keep connecting in the background up to their `startupTimeoutMs` before timing out, and their tools become available to subsequent model steps.

**Automatic reconnection**: HTTP and SSE servers that fail at startup, as well as any server whose established connection drops unexpectedly, reconnect with exponential backoff up to the maximum delay. A stdio server that fails its initial startup stays `failed` because each attempt spawns a new child process; fix the issue and reconnect it manually from `/mcp`. Permanent failures such as an unknown command, invalid configuration, or rejected static credentials are never retried.

## Running stdio servers in a remote environment

stdio servers run locally by default, even when the session is bound to a remote environment. Setting `environment_id` on a server entry starts it inside the named [remote environment](../guides/remote-environment.md), so its process, working directory, and file access all live on the target machine.

First declare the environment in `config.toml`:

```toml
[environments.dev-box]
type = "ssh"
host = "dev-box"
defaultCwd = "/srv/work"
```

Then reference its id in `mcp.json`:

```json
{
  "mcpServers": {
    "remote-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/data"],
      "environment_id": "dev-box"
    }
  }
}
```

`environment_id` defaults to `local` and does not follow the session's environment binding; servers without this field still run locally. A cold environment connects on demand when the server starts. See [Declare Docker and custom-command environments](../guides/remote-environment.md#declare-docker-and-custom-command-environments).

### Environment variables for remote stdio servers

A remote server inherits `PATH`, `HOME`, and other base variables from the target environment, so local paths never leak into the remote process. The CLI sends only the literal key-value pairs in `env`, and the target resolves everything else:

```json
{
  "mcpServers": {
    "remote-db": {
      "command": "db-mcp-server",
      "environment_id": "dev-box",
      "env": { "LOG_LEVEL": "debug" }
    }
  }
}
```

## Loading tools on demand

To save context, every MCP server's tools load on demand by default: the model sees tool names first and loads full schemas through the built-in `select_tools` tool only when needed.

- **Prerequisite**: The current model must declare the `dynamically_loaded_tools` capability. Official models declare it automatically; for other models, add it to `capabilities` in `config.toml` — see [Configuration files](../configuration/config-files.md#models). Models without this capability receive all connected tools as ordinary top-level declarations.
- **Tool disclosure**: Initially deferred tool names are disclosed in a reminder; tools from servers that finish connecting after startup, as well as later additions and removals, are announced as deltas. Duplicate declarations prefer the top-level list.

### Changing how tools load

To keep tools in the top-level list, disable deferred loading per server or globally:

- **Single server**: Set `"deferred": false` in `mcp.json`.
- **Global default**: Set `default_deferred = false` under `[mcp]` in `config.toml` — see [Configuration files](../configuration/config-files.md#mcp).

The server field always overrides the global default, and authentication tools exposed before OAuth completes follow the same field. The setting is captured when a server connects, so reconnect the server or restart the process after changing it.

```json
{
  "mcpServers": {
    "github": {
      "url": "https://mcp.example.com/mcp",
      "deferred": false
    }
  }
}
```

### Tool schema updates

When a deferred tool's schema changes under the same name, one announcement removes the old version and adds the new one. The model must call `select_tools` again to load the current schema before calling that tool; earlier calls are rejected with guidance to reselect. Requests send the old declaration, an unload message, and the new declaration in order so duplicate declarations do not fail. Top-level inline tools with the same name stay pinned to their original schema for the current session and do not trigger a reload.

## Tool naming and permissions

MCP tools are named `mcp__<server>__<tool>`, for example `mcp__github__create_issue`. Permission rules match tool names and support `*` and `**` wildcards, so `mcp__github__*` matches every tool on that server; tool arguments are not matched.

Calls that match no permission rule trigger an approval request; choosing "Approve for this session" allows later calls of the same kind in that session. You can also pre-configure permanent rules in `[[permission.rules]]` in `config.toml`:

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

For the full syntax, see [Configuration files](../configuration/config-files.md#permission).

## Tool results and attachments

MCP tool results follow three rules: **text and structured data** go directly to the model, **media and file attachments** keep their originals for on-demand reading, and **oversized output and errors** use file offloading and explicit error reporting so nothing is silently lost.

### Text and structured data

- **Full delivery**: Both text `content` and structured `structuredContent` are provided to the agent.
- **Automatic deduplication**: The structured copy is omitted only when a text block already contains the exact same complete JSON value; text summaries and media never replace structured records.

### Media and file attachments

- **Originals preserved**: Attachments that cannot be delivered directly due to format or size limits are saved to the session's media storage. Embedded image, audio, and video originals are kept even when delivered unchanged, so later provider conversion or history reduction cannot lose them, and they are not evicted by the image cache.
- **How they are read**: Originals have absolute paths and stable `kimi-file://` references. The agent passes a reference as `path` to `Read` or `ReadMediaFile` without needing workspace filesystem access, and pagination and forked sessions keep the reference valid.
- **Format handling**: Text attachments such as CSV, HTML, JSON, and plain SVG use readable extensions; for binary formats `Read` cannot open, the error includes a server-local path when available for external converters that can access that filesystem.
- **Image reuse**: For providers that support image uploads and file references, later model requests reuse a newly returned MCP image after its first upload.

### Oversized output and errors

- **Large lists offloaded to files**: Attachment paths and compression notes count toward the tool-output budget. Very long lists are saved to a text file, and a `kimi-file://` pointer remains visible for `Read` pagination even when the accompanying text is truncated.
- **Cancellation and failures**: Canceling a tool call stops further attachment processing and signals active writes to stop; if decoding or saving fails, the result states clearly that the original could not be preserved while keeping other usable output.
- **Resource links**: Returned remote resource links are not downloaded automatically.

## Security

- Only connect servers from trusted sources.
- Check that tool names and arguments look reasonable in approval requests.
- Keep manual approval for high-risk tools such as file writes and command execution; avoid allowing all tools with `mcp__*`.

::: warning Note
In [Ask When Needed mode](../guides/interaction.md#the-three-permission-modes), MCP tool calls are automatically approved. Only use this mode when you fully trust the connected MCP servers.
:::

## Next steps

- [Plugins](./plugins.md) — Declare MCP servers in a plugin manifest to package and distribute them together
- [Configuration files](../configuration/config-files.md#permission) — Full field reference for permission rules
