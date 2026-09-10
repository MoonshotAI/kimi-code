# Model Context Protocol

[Model Context Protocol（MCP）](https://modelcontextprotocol.io/) 是一个开放协议，让模型可以安全地调用外部进程或服务暴露的工具：读取 GitHub issues、查询数据库、操作本地文件系统。Kimi Code CLI 作为 MCP client 接入这些外部工具，把它们与内置工具一起暴露给 Agent 使用，行为上没有差异。

MCP 工具结果可以包含文本（`content`）和结构化数据（`structuredContent`）。Kimi Code CLI 会将两者提供给 Agent，只有能够确认某个文本块已包含同一份完整 JSON 值时，才省略重复的结构化内容。文本摘要和媒体不会替代结构化记录。

Kimi Code CLI 会保留因格式或大小限制而无法直接交付的内嵌 MCP 附件。内嵌图片、音频和视频即使能够原样交付也会保存，因为后续供应商协议转换或历史精简可能省略它们。模型支持相应内容时，即使工作区文件系统不可用，也仍可读取会话附件。原件随会话保存在媒体存储中，不会被图片缓存淘汰。保存的原件（包括图片压缩前的原图）均提供绝对路径和稳定的 `kimi-file://` 引用。将引用作为 `path` 传给 `Read` 或 `ReadMediaFile`，即使工作区 runtime 无法访问会话存储，也能直接从当前会话存储读取字节。分页续读会保留该引用，包括 fork 后的会话。对于 `Read` 无法打开的二进制格式，错误信息会在可用时提供服务端本地路径；外部转换工具必须能够访问该文件系统。CSV、HTML、JSON 和普通 SVG 等文本附件使用可读取的扩展名。

附件路径和压缩说明共用工具输出预算。较长的清单会保存为文本文件，结果中保留简短指针，即使伴随的文本被截短，该指针仍然可见；Agent 可将清单的 `kimi-file://` 引用传给 `Read`，分页读取完整内容。取消工具调用会停止后续附件处理，并通知正在进行的写入操作。如果解码或保存失败，结果会明确说明原件未能保留，并保留其他可用输出。资源链接不会被自动下载。

## 接入方式

Kimi Code CLI 支持三种 MCP server 接入方式：

- **stdio**：CLI 以子进程方式启动本地 MCP server，通过标准输入输出通信。适合本地命令行工具。
- **HTTP**：CLI 连接一个已在运行的 HTTP 端点。适合远程服务或需要持久运行的进程。
- **SSE**：CLI 连接旧式 HTTP+SSE 端点。新 MCP server 优先使用 HTTP；只有服务仍仅暴露旧式 SSE 传输时，才设置 `transport: "sse"`。

## 配置

MCP server 配置写在 `mcp.json` 中，分两层：

- **用户级**：`~/.kimi-code/mcp.json`（或 `$KIMI_CODE_HOME/mcp.json`），跨项目共享
- **项目级**：工作目录下的 `.kimi-code/mcp.json`，只对当前仓库生效

同名条目以项目级为准，覆盖用户级。

在 TUI 中运行 `/mcp-config` 可以交互式地新增、编辑或删除 server，无需手动编辑 JSON 文件。运行 `/mcp` 可查看当前所有 server 的连接状态。

从配置中删除某个 server 不会打断进行中的会话：该 server 在 `/mcp` 中仍显示为 `removed`，其工具在这些会话中保持可见，但调用会失败并返回移除提示；新会话则完全不会注册这些工具。反过来，编辑 `mcp.json` 或安装 plugin 新增的 server 也不会注册到已打开的会话，只会加入之后创建的会话。

当 Kimi Code 在不受信任的文件夹中发现项目级 MCP server 时，工作区信任提示会显示每个 server 的传输方式和启动目标。提示默认选中 `Trust this folder`；核对列出的命令与参数或远程 URL 后确认即可，选择 `Don't trust` 则该工作区的项目级 MCP server 不会启用。

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
| `toolTimeoutMs` | `number` | 全部 | 单次工具调用超时（毫秒） |
| `enabledTools` | `string[]` | 全部 | 工具白名单 |
| `disabledTools` | `string[]` | 全部 | 工具黑名单 |

连接超时和单次工具调用超时的默认值都不必逐个 server 设置：`config.toml` 的 `[mcp] startup_timeout_ms` / `[mcp] tool_timeout_ms` 或环境变量 `KIMI_MCP_STARTUP_TIMEOUT_MS` / `KIMI_MCP_TOOL_TIMEOUT_MS` 可以调整全局默认值，优先级为 server 字段 > 环境变量 > `config.toml` > 内置默认。详见 [配置文件](../configuration/config-files.md#mcp)。

HTTP 与 SSE server 支持通过 `headers` 或 `bearerTokenEnvVar` 提供静态凭证。需要 OAuth 时，运行 `/mcp-config login <server-name>` 完成浏览器授权。

Plugins 也可以在 manifest 中声明 MCP servers。Plugin 声明的 servers 默认启用，可以在 `/plugins` 中禁用或重新启用：禁用或移除后，已打开会话中的工具调用会失败并返回移除提示；新增或启用 server 会立即连接到已打开的会话。详见 [Plugins](./plugins.md#plugin-中的-mcp-servers)。

::: warning 注意
项目级 `.kimi-code/mcp.json` 中的 stdio 条目会在会话启动时执行本地命令，只在你信任的仓库里启用。
:::

## 工具命名与权限

MCP 工具按 `mcp__<server>__<tool>` 格式命名，例如 `mcp__github__create_issue`。权限规则中支持 `*` 和 `**` 通配，例如 `mcp__github__*` 命中该 server 下所有工具。MCP 工具参数不参与权限匹配。

未命中权限规则的调用会触发审批请求；在审批弹窗中选择“Approve for this session”后，本次会话内的后续同类调用自动放行。

也可以在 `config.toml` 的 `[[permission.rules]]` 中预置永久规则：

```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__github__*"

[[permission.rules]]
decision = "deny"
pattern = "mcp__filesystem__write_file"
```

权限规则的完整语法见 [配置文件](../configuration/config-files.md#permission)。

## 安全性

接入外部 MCP server 时需注意：

- 只接入可信来源的 server
- 在审批请求中核查工具名与参数是否合理
- 对高风险工具（写文件、执行命令等）维持手动审批，避免用 `mcp__*` 通配放行全部工具

::: warning 注意
在 [YOLO 模式](../guides/interaction.md#三种权限模式)下，MCP 工具调用会被自动批准。仅在完全信任所接入的 MCP server 时使用此模式。
:::

## 下一步

- [Plugins](./plugins.md) — 在 plugin manifest 中声明 MCP server，一键打包和分发
- [配置文件](../configuration/config-files.md#permission) — 权限规则的完整字段参考
