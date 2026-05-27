# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open protocol that lets models safely call tools exposed by external processes or services. Kimi Code CLI acts as an MCP client to integrate these external tools, exposing them to the agent alongside built-in tools (`Read`, `Bash`, `Grep`, etc.).

## Integration scope

Kimi Code CLI connects to MCP servers via stdio (local subprocess) or HTTP. Once connected, MCP tools behave the same as built-in tools: they are available to the agent, subject to permission rules, and go through the approval flow.

## Configuration and login

MCP server configurations live in `mcp.json` in two layers:

- User-level: `~/.kimi-code/mcp.json` (or `$KIMI_CODE_HOME/mcp.json`), shared across projects
- Project-level: `.kimi-code/mcp.json` in the current workspace

Project entries override user-level entries with the same name.

The easiest entry point is running `/mcp-config` in the TUI, which guides you through adding, editing, or removing servers. To check connection status, run `/mcp`.

The top-level shape of `mcp.json` is:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    }
  }
}
```

Entries with `command` are stdio servers; entries with `url` are HTTP servers, so you usually do not need to write a `transport` field. HTTP servers can provide static credentials through `headers` or `bearerTokenEnvVar`. When OAuth is required, run `/mcp-config login <server-name>` to complete browser authorization.

Optional fields:

| Field | Type | Applies to | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | Environment variables injected into the subprocess |
| `cwd` | `string` | stdio | Working directory for the subprocess |
| `headers` | `Record<string, string>` | HTTP | Static headers appended to every request |
| `enabled` | `boolean` | both | Set to `false` to disable the server without removing the entry |
| `startupTimeoutMs` | `number` | both | Connection timeout in milliseconds, default `30000` |
| `toolTimeoutMs` | `number` | both | Per-tool-call timeout in milliseconds |
| `enabledTools` | `string[]` | both | Allowlist: only expose the tools in this list |
| `disabledTools` | `string[]` | both | Blocklist: exclude the tools in this list |

::: warning Note
Stdio entries in a project-level `.kimi-code/mcp.json` execute local commands when the session starts. Only enable project-level MCP servers in repositories you trust.
:::

## Tool naming and permissions

MCP tools are exposed using the naming convention `mcp__<server>__<tool>`. Permission matching supports `*` and `**` wildcards in tool names, so `mcp__github__*` covers every tool from the `github` server. MCP tool arguments are not part of permission matching; allow or deny the exact MCP tool name, or use a tool-name wildcard.

Calls that do not match any rule trigger an approval request. Choosing "Approve for this session" in the approval prompt auto-approves subsequent matching calls.

You can also pre-load permanent rules in the `[[permission.rules]]` array of tables in `config.toml`:

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

The full syntax of the `pattern` field and the accepted values of other fields such as `decision`, `scope`, and `reason` are documented in [Config files](../configuration/config-files.md#permission).

## Security

- Only integrate MCP servers from trusted sources
- Check that the tool name and arguments are reasonable in approval requests
- Keep manual approval for high-risk tools, and avoid broad `mcp__*` wildcard allowlisting

::: warning Note
In YOLO mode, MCP tool calls are auto-approved like any other tool. Only use this mode when you fully trust the integrated MCP servers.
:::
