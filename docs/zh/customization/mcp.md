# Model Context Protocol

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/) 是一个开放协议，让模型可以安全地调用外部进程或服务暴露的工具——例如读取 GitHub issues、查询数据库、操作本地文件系统。Kimi Code CLI 作为 MCP client 接入这些外部工具，并把它们与内置工具（`Read`、`Bash`、`Grep` 等）一起暴露给 Agent 使用，行为上没有差异。

## 接入方式

Kimi Code CLI 支持三种 MCP server 接入方式：

- **stdio**：CLI 以子进程方式启动本地 MCP server，通过标准输入输出通信。适合本地命令行工具。
- **HTTP**：CLI 连接一个已在运行的 HTTP 端点。适合远程服务或需要持久运行的进程。
- **SSE**：CLI 连接旧式 HTTP+SSE 端点（Server-Sent Events，一种流式 HTTP 机制）。新 MCP server 优先使用 HTTP；只有服务仍仅暴露旧式 SSE 传输时，才设置 `transport: "sse"`。

## 配置

MCP server 配置写在 `mcp.json` 中，分两层：

- **用户级**：`~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），跨项目共享
- **项目级**：工作目录下的 `.kimi-code/mcp.json`，只对当前仓库生效

同名条目以项目级为准，覆盖用户级。

在 TUI 中运行 `/mcp-config` 可以交互式地新增、编辑或删除 server，无需手动编辑 JSON 文件。运行 `/mcp` 可查看当前所有 server 的连接状态。

`mcp.json` 的结构：

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

含 `command` 字段的条目为 stdio server；含 `url` 字段且未写 `transport` 的条目为 HTTP server。旧式 SSE server 需要显式把 `transport` 设为 `"sse"`。

可选字段：

| 字段 | 类型 | 适用方式 | 说明 |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | 注入子进程的环境变量 |
| `cwd` | `string` | stdio | 子进程工作目录 |
| `headers` | `Record<string, string>` | HTTP、SSE | 附加到每次请求的静态请求头 |
| `bearerTokenEnvVar` | `string` | HTTP、SSE | 存放 bearer token 的环境变量名 |
| `enabled` | `boolean` | 全部 | 设为 `false` 可禁用该 server |
| `startupTimeoutMs` | `number` | 全部 | 连接超时，默认 `30000` 毫秒 |
| `toolTimeoutMs` | `number` | 全部 | 单次工具调用超时 |
| `enabledTools` | `string[]` | 全部 | 工具白名单 |
| `disabledTools` | `string[]` | 全部 | 工具黑名单 |

HTTP 与 SSE server 支持通过 `headers` 或 `bearerTokenEnvVar` 提供静态凭证。需要 OAuth 时，运行 `/mcp-config login <server-name>` 完成浏览器授权。

Plugins 也可以在 manifest 中声明 MCP servers。Plugin 声明的 servers 默认启用，可以在 `/plugins` 中禁用或重新启用，然后开启新会话。详见 [Plugins](./plugins.md)。

::: warning 注意
项目级 `.kimi-code/mcp.json` 中的 stdio 条目会在会话启动时执行本地命令，只在你信任的仓库里启用。
:::

## 工具命名与权限

MCP 工具按 `mcp__<server>__<tool>` 格式命名，例如 `mcp__github__create_issue`。权限规则中支持 `*` 和 `**` 通配，例如 `mcp__github__*` 命中该 server 下所有工具。MCP 工具参数不参与权限匹配。

未命中权限规则的调用会触发审批请求；在审批弹窗中选择"Approve for this session"后，本次会话内的后续同类调用自动放行。

也可以在 `config.toml` 的 `[[permission.rules]]` 中预置永久规则：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

权限规则的完整语法见[配置文件](../configuration/config-files.md#permission)。

## 安全性

接入外部 MCP server 时需注意：

- 只接入可信来源的 server
- 在审批请求中核查工具名与参数是否合理
- 对高风险工具（写文件、执行命令等）维持手动审批，避免用 `mcp__*` 通配放行全部工具

::: warning 注意
在 YOLO 模式下，MCP 工具调用会被自动批准。仅在完全信任所接入的 MCP server 时使用此模式。
:::

## 下一步

- [Plugins](./plugins.md) — 在 plugin manifest 中声明 MCP server，一键打包和分发
- [配置文件](../configuration/config-files.md#permission) — 权限规则的完整字段参考
