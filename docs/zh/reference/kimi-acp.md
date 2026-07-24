# `kimi acp` 子命令

`kimi acp` 把 Kimi Code CLI 切换到 **ACP (Agent Client Protocol)** 模式：在标准输入/输出上以 JSON-RPC 形式与 ACP 客户端（如 Zed、JetBrains AI Chat 等）对话，让 IDE 直接驱动 kimi 的会话、prompt 与工具调用。

```sh
kimi acp
```

启动后命令不会打印任何 banner，立刻等待 ACP 客户端在 stdin 上发出 `initialize` 请求。日志会写到标准错误（以及 `~/.kimi-code/logs/` 下的诊断日志），所以 ACP 通道本身保持干净。

::: tip 谁会调用它？
你通常不需要手动跑 `kimi acp`——这个命令是给 IDE 的子进程入口准备的。IDE 端的配置见[在 IDE 中使用](../guides/ides.md)。
:::

## 能力矩阵

下表列出当前 ACP 适配层声明的能力。`agentCapabilities` 字段在 `initialize` 响应里完整返回，IDE 端可据此调整 UI。

| 能力 | 取值 | 说明 |
| --- | --- | --- |
| `promptCapabilities.image` | `true` | 支持 ACP `image` 内容块（base64 + mimeType） |
| `promptCapabilities.audio` | `false` | 暂不支持音频 prompt |
| `promptCapabilities.embeddedContext` | `true` | 客户端可发送 `resource`/`resource_link` 嵌入式资源块，文本内容会以 `<resource uri="...">...</resource>` 形式注入 prompt；blob 资源被丢弃并写 warn |
| `mcpCapabilities.http` | `true` | 转发 IDE 配置的 HTTP MCP 服务 |
| `mcpCapabilities.sse` | `true` | 转发 IDE 配置的旧式 SSE MCP 服务 |
| `loadSession` | `true` | 支持 `session/load` 续接已有会话，加载时会同步回放历史 |
| `sessionCapabilities.list` | `{}` | 支持 `session/list` 枚举当前用户的会话 |

## ACP 方法覆盖

规范把方法分为**稳定**面和仍在演化的**不稳定**面（`@agentclientprotocol/sdk@0.23.0` 中以 `unstable_*` 前缀挂载的 handler）。两部分稳定性保证完全不同——稳定面是任何生产 ACP 客户端都会用到的方法，不稳定面覆盖实验性扩展（inline-edit 预测、document 缓冲区同步、provider 管理、elicitation 等），因此分开追踪。

**概览：稳定面 agent-side 实现 10/12（83%）+ client reverse-RPC 实现 4/9（44%）；不稳定面只接入了 `session/set_model`（1/19）。** 任何正常 agent 流程所需的方法（initialize → auth → new/load/resume → prompt → cancel + 文件 I/O + 工具审批）都已实现。

### 稳定面 agent-side — IDE → agent（10 / 12）

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `initialize` | 是 | 版本协商；返回 `agentInfo: { name: 'Kimi Code CLI', version }`、能力矩阵、`authMethods` |
| `authenticate` | 是 | 校验 `method_id='login'`；token 缺失返回 `authRequired (-32000)`，未知 id 返回 `invalidParams (-32602)` |
| `session/new` | 是 | 接受 `cwd` / `mcpServers`，返回 `configOptions[]` |
| `session/load` | 是 | 恢复磁盘会话并把历史以 `session/update` 同步回放 |
| `session/resume` | 是 | `session/load` 的轻量兄弟方法，跳过历史回放 |
| `session/prompt` | 是 | 接受 `text` / `image` / `resource` / `resource_link` 内容块，流式输出 `agent_message_chunk` |
| `session/cancel` | 是 | 中断当前 turn |
| `session/list` | 是 | 枚举磁盘会话（通过 `sessionCapabilities.list = {}` 公告） |
| `session/set_mode` | 是 | 兼容路径，与 `set_config_option({configId:'mode'})` 走同一 dispatcher |
| `session/set_config_option` | 是 | 统一的 model / thinking / mode picker 分发 |
| `session/close` | 否 | |
| `logout` | 否 | |

### 稳定面 client-side reverse-RPC — agent → IDE（4 / 9）

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `session/update` | 是 | 流式推送 `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | 是 | 工具审批和问题 elicitation 共用此通道 |
| `fs/read_text_file` | 是 | kaos 层文件读取路由到客户端（通过 `fsCapabilities` 公告） |
| `fs/write_text_file` | 是 | kaos 层文件写入路由到客户端 |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | 否 | 终端 reverse-RPC 未接，shell 命令走本地执行 |

### 不稳定面（1 / 19）

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `session/set_model` | 是 | 兼容路径，等价于 `set_config_option({configId:'model'})` |
| 其余 18 个方法 | 否 | 包括 session 生命周期扩展、缓冲区同步、inline-edit 预测、provider 管理等 |

上述未列出的方法一律返回 `methodNotFound`。

## 扩展方法（`kimi/*` 命名空间）

适配器自有的扩展方法放在 `kimi/*` 命名空间，避免与未来 ACP 规范方法冲突。未知的扩展方法返回 `methodNotFound (-32601)`。

| 方法 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `kimi/session/fork` | `{ sessionId }` | `{ sessionId }` | 把会话 fork 成一个临时副本，并注册为一等 ACP 会话，客户端可照常 `session/prompt`（btw 式旁路对话，不会污染源上下文）。源会话有活跃 turn 时拒绝。继承源会话的 model/thinking 状态；客户端声明 `fs.readTextFile` / `fs.writeTextFile` 能力时，fork 与 `session/new` 一样走同一对 ACP reverse-RPC kaos 路由文件 I/O。不携带 ACP 侧提供的 MCP servers。 |
| `kimi/session/close` | `{ sessionId, archive? }` | `{}` | 关闭会话并从适配器移除。`archive: true` 时一并归档磁盘会话目录（fork 的清理路径）；否则会话仍可恢复。 |
| `kimi/session/steer` | `{ sessionId, prompt }` | `{ steered: true }` 或 `{ steered: false, reason: 'no_active_turn' }` | 把一条待处理的用户消息（`prompt` 为 `ContentBlock[]`，与 `session/prompt` 同构）注入当前活跃 turn；模型在下一个 step 边界消费，在途工具调用和 subagent 不受影响。无活跃 turn 时不报错，返回 `{ steered: false, reason: 'no_active_turn' }`，客户端应回退到 `session/prompt`。 |

## 内置斜杠命令

以纯文本 `session/prompt` 块发送的斜杠命令会被适配器拦截。每次 `session/new` / `session/load` / `session/resume` 之后通过 `available_commands_update` 公告给客户端：

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `/compact` | `<可选指令>` | 压缩会话上下文，可附带自定义总结指令 |
| `/undo` | `<可选 count>` | 撤销最近 N 个 turn（默认 1）；turn 运行中拒绝；活跃上下文中可撤销的 prompt 不足 N 个时（如 compaction 之后）预先拒绝 |
| `/status` | — | 显示当前会话状态 |
| `/usage` | — | 显示会话 token 用量 |
| `/mcp` | — | 显示 MCP server 状态 |
| `/tasks` | — | 列出后台任务 |
| `/help` | — | 显示可用 ACP 命令 |

未知斜杠命令在本地回复一条 "unknown command" 提示，不会转发给模型。

## MCP 转发

ACP 客户端在 `session/new` 或 `session/load` 中提供 `mcpServers` 时，适配层做如下转换：

- `http` → kimi 的 `transport: 'http'` 配置
- `stdio` → kimi 的 `transport: 'stdio'` 配置
- `sse` → kimi 的 `transport: 'sse'` 配置
- `acp` → 丢弃并写一条 warn 日志

## 下一步

- [在 IDE 中使用](../guides/ides.md) — Zed / JetBrains 配置步骤和故障排查
- [kimi 命令参考](./kimi-command.md) — 完整子命令列表
