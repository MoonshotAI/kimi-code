# Model Context Protocol

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) 是一个开放协议，让模型可以安全地调用外部进程或服务暴露的工具。Kimi Code CLI 作为 MCP client 接入这些外部工具，并把它们与内置工具（`Read`、`Bash`、`Grep` 等）一起暴露给 Agent 使用。

## 集成范围

Kimi Code CLI 支持通过 stdio（本地子进程）和 HTTP 两种方式接入外部 MCP 服务器。接入的 MCP 工具与内置工具一样，可以被 Agent 调用、受权限规则约束、参与审批流程，行为上没有差异。

## 配置与登录

MCP server 配置写在 `mcp.json` 中，分为两层：

- 用户级：`~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），跨项目共享
- 项目级：`.kimi-code/mcp.json`，仅当前仓库

项目级覆盖用户级同名条目。

最方便的入口是在 TUI 中运行 `/mcp-config`，它会引导你新增、编辑或删除 server。要查看当前连接状态，可运行 `/mcp`。

`mcp.json` 的顶层结构如下：

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

含 `command` 字段的条目为 stdio server，含 `url` 字段的条目为 HTTP server，通常不需要手写 `transport` 字段。HTTP server 支持通过 `headers` 或 `bearerTokenEnvVar` 提供静态凭证；需要 OAuth 时，可运行 `/mcp-config login <server-name>` 完成浏览器授权。

可选字段：

| 字段 | 类型 | 适用 transport | 说明 |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | stdio | 注入子进程的环境变量 |
| `cwd` | `string` | stdio | 子进程工作目录 |
| `headers` | `Record<string, string>` | HTTP | 附加到每次请求的静态请求头 |
| `enabled` | `boolean` | 两者 | 设为 `false` 可禁用该 server |
| `startupTimeoutMs` | `number` | 两者 | 连接超时，默认 `30000` |
| `toolTimeoutMs` | `number` | 两者 | 单次工具调用超时 |
| `enabledTools` | `string[]` | 两者 | 白名单 |
| `disabledTools` | `string[]` | 两者 | 黑名单 |

::: warning 注意
项目级 `.kimi-code/mcp.json` 中的 stdio 条目会在会话启动时执行本地命令，只在你信任的仓库里启用。
:::

## 工具命名与权限

MCP 工具按 `mcp__<server>__<tool>` 命名。权限匹配支持工具名中的 `*` 和 `**` 通配，例如 `mcp__github__*` 命中该 server 下所有工具。MCP 工具参数不会参与权限匹配；请放行或拒绝精确的 MCP 工具名，或使用工具名通配。

未命中权限规则的调用会触发审批请求；在审批弹窗中选择 "Approve for this session" 后，后续同类调用将自动放行。

也可以在 `config.toml` 的 `[[permission.rules]]` 中预置永久规则：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

`pattern` 的完整语法及 `decision`、`scope` 等字段的取值详见 [配置文件](../configuration/config-files.md#permission)。

## 安全性

- 只接入可信来源的 MCP server
- 在审批请求中检查工具名与参数是否合理
- 对高风险工具维持手动审批，避免宽泛的 `mcp__*` 通配放行

::: warning 注意
在 YOLO 模式下，MCP 工具调用会被自动批准。仅在完全信任所接入的 MCP server 时使用此模式。
:::
