# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that lets models safely call tools exposed by external processes or services — for example, reading GitHub issues, querying databases, or operating the local file system. Kimi Code CLI acts as an MCP client to connect these external tools and exposes them to the Agent alongside built-in tools (`Read`, `Bash`, `Grep`, etc.) with no behavioral difference.

## Connection Methods

Kimi Code CLI supports three MCP server connection methods:

- **stdio**: The CLI starts the local MCP server as a child process and communicates via standard input/output. Suitable for local command-line tools.
- **HTTP**: The CLI connects to an already-running HTTP endpoint. Suitable for remote services or processes that need to run persistently.
- **SSE**: The CLI connects to a legacy HTTP+SSE endpoint (Server-Sent Events, a streaming HTTP mechanism). Prefer HTTP for new MCP servers, but use `transport: "sse"` when a service still exposes only the older SSE transport.

## Configuration

MCP server configuration is written in `mcp.json`, at two levels:

- **User level**: `~/.kimi-code/mcp.json` (or `$KIMI_CODE_HOME/mcp.json`), shared across projects
- **Project level**: `.kimi-code/mcp.json` in the working directory, effective only for the current repository

Entries with the same name: the project-level entry takes precedence and overrides the user-level entry.

Run `/mcp-config` in the TUI to interactively add, edit, or delete servers without manually editing the JSON file. Run `/mcp` to view the connection status of all current servers.

Structure of `mcp.json`:

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

Entries with a `command` field are stdio servers; entries with a `url` field and no `transport` are HTTP servers. For legacy SSE servers, set `transport` to `"sse"` explicitly.

Optional fields:

| Field | Type | Applies to | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | Environment variables injected into the child process |
| `cwd` | `string` | stdio | Working directory for the child process |
| `headers` | `Record<string, string>` | HTTP, SSE | Static request headers appended to every request |
| `bearerTokenEnvVar` | `string` | HTTP, SSE | Name of an environment variable that contains a bearer token |
| `enabled` | `boolean` | All | Set to `false` to disable this server |
| `startupTimeoutMs` | `number` | All | Connection timeout; default `30000` milliseconds |
| `toolTimeoutMs` | `number` | All | Timeout for a single tool call |
| `enabledTools` | `string[]` | All | Tool allowlist |
| `disabledTools` | `string[]` | All | Tool blocklist |

HTTP and SSE servers support providing static credentials via `headers` or `bearerTokenEnvVar`. When OAuth is needed, run `/mcp-config login <server-name>` to complete browser-based authorization.

Plugins can also declare MCP servers in their manifest. Servers declared by a plugin are enabled by default and can be disabled or re-enabled in `/plugins`, then a new session must be started. See [Plugins](./plugins.md) for details.

::: warning Note
stdio entries in a project-level `.kimi-code/mcp.json` execute local commands when a session starts. Only enable these in repositories you trust.
:::

## Tool Naming and Permissions

MCP tools are named in the format `mcp__<server>__<tool>`, for example `mcp__github__create_issue`. Permission rules support `*` and `**` wildcards, for example `mcp__github__*` matches all tools under that server. MCP tool parameters are not included in permission matching.

Calls that do not match any permission rule trigger an approval request. Selecting "Approve for this session" in the approval dialog automatically allows subsequent calls of the same kind within the current session.

You can also pre-configure permanent rules in `[[permission.rules]]` in `config.toml`:

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

For the full permission rule syntax, see [Configuration files](../configuration/config-files.md#permission).

## Security

When connecting to external MCP servers, be aware of:

- Only connect to servers from trusted sources
- Verify that tool names and parameters look reasonable in approval requests
- Keep manual approval for high-risk tools (file writes, command execution, etc.); avoid using `mcp__*` wildcards to allow all tools at once

::: warning Note
In YOLO mode, MCP tool calls are automatically approved. Only use this mode when you fully trust the MCP servers you have connected.
:::

## Next steps

- [Plugins](./plugins.md) — Declare MCP servers in a plugin manifest to package and distribute them together
- [Configuration files](../configuration/config-files.md#permission) — Full field reference for permission rules
