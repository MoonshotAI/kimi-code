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

下表列出 ACP server 声明的能力。`agentCapabilities` 字段在 `initialize` 响应里完整返回，IDE 端可据此调整 UI。

| 能力 | 取值 | 说明 |
| --- | --- | --- |
| `loadSession` | `true` | 支持 `session/load` 续接已有会话，加载时会同步回放历史 |
| `promptCapabilities.image` | `true` | 支持 ACP `image` 内容块（base64 + mimeType） |
| `promptCapabilities.audio` | `false` | 暂不支持音频 prompt |
| `promptCapabilities.embeddedContext` | `true` | 客户端可发送 `resource`/`resource_link` 嵌入式资源块，文本内容会以 `<resource uri="...">...</resource>` 形式注入 prompt；blob 资源被丢弃并写 warn |
| `sessionCapabilities.list` | `{}` | 支持 `session/list` 枚举当前用户的会话 |
| `sessionCapabilities.resume` | `{}` | 支持 `session/resume` 重新挂接会话，不回放历史 |
| `sessionCapabilities.close` | `{}` | 支持 `session/close` 拆除存活中的会话 |
| `sessionCapabilities.delete` | `{}` | 支持 `session/delete` 永久删除会话 |
| `sessionCapabilities.fork` | `{}` | 支持 `session/fork` 从已有会话分叉 |
| `sessionCapabilities.additionalDirectories` | `{}` | 额外工作目录，仅在 `session/new` 时生效 |
| `mcpCapabilities.http` | `true` | 转发 IDE 配置的 HTTP MCP 服务 |
| `mcpCapabilities.sse` | `true` | 转发 IDE 配置的旧式 SSE MCP 服务 |
| `auth.logout` | `{}` | 支持 ACP `logout`，丢弃托管供应商的 token |

## ACP 方法覆盖

在 `@agentclientprotocol/sdk@1.x` 中，ACP 方法按命名空间组织：`core` 与 `session` 覆盖主 agent 流程，`providers`、`nes`（inline-edit 预测）与 `document`（缓冲区同步）是可选扩展面；客户端侧的 reverse-RPC 方法则分组在 `session`、`fs`、`terminal` 与 `elicitation` 下。

**概览：ACP server 实现了全部 core（3/3）与 session（11/11）agent 侧方法、10/11 客户端 reverse-RPC 方法，以及 `session/set_model` 扩展方法。未实现：`providers/*`、`nes/*`、`document/*` 与 `elicitation/complete`——对这些方法的请求一律返回 `methodNotFound`。**

### core agent 侧 — IDE → agent（3 / 3）

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `initialize` | 是 | 版本协商；返回 `agentInfo: { name: 'Kimi Code CLI', version }`、能力矩阵、`authMethods`（一等 `type:'terminal'` 加旧式 `_meta['terminal-auth']` 回退） |
| `authenticate` | 是 | 校验 `method_id='login'`；token 缺失返回 `authRequired (-32000)`，未知 id 返回 `invalidParams (-32602)` |
| `logout` | 是 | 丢弃托管供应商的 token；后续受限调用会再次返回 `auth_required` |

### session agent 侧 — IDE → agent（11 / 11）

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `session/new` | 是 | 接受 `cwd` / `mcpServers` / `additionalDirectories`，返回 `sessionId` + `configOptions[]` + `modes` |
| `session/load` | 是 | 恢复磁盘会话，在响应返回前把历史以 `session/update` 同步回放 |
| `session/resume` | 是 | `session/load` 的轻量兄弟方法，跳过历史回放 |
| `session/list` | 是 | 枚举磁盘会话，可按 `cwd` 过滤 |
| `session/fork` | 是 | 从源会话分叉；请求上的 `cwd` / `additionalDirectories` / `mcpServers` 会被忽略并写 warn |
| `session/close` | 是 | 尽力拆除：中断进行中的 turn、释放会话级资源并关闭存活会话；未知 id 不算错误 |
| `session/delete` | 是 | 永久删除会话及其持久化数据；未知 id 返回 `invalidParams (-32602)` |
| `session/prompt` | 是 | 接受 `text` / `image` / `resource` / `resource_link` 内容块，流式输出 `agent_message_chunk` |
| `session/cancel` | 是 | 中断当前 turn（针对 prompt 的 JSON-RPC `$/cancel_request` 走同一条取消路径） |
| `session/set_mode` | 是 | 校验 `modeId`，与 `set_config_option({configId:'mode'})` 走同一个模式切换 |
| `session/set_config_option` | 是 | 统一的 model / thinking / mode picker 分发 |

### 客户端 reverse-RPC — agent → IDE（10 / 11）

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `session/update` | 是 | 流式推送 `agent_message_chunk` / `tool_call*` / `plan` / `config_option_update` / `available_commands_update` |
| `session/request_permission` | 是 | 工具审批和问题提问共用此通道 |
| `fs/read_text_file` | 是 | 客户端声明 `fsCapabilities` 时，引擎的文件读取路由到客户端 |
| `fs/write_text_file` | 是 | 引擎的文件写入路由到客户端 |
| `terminal/create` · `output` · `release` · `kill` · `wait_for_exit` | 是 | 客户端声明 `clientCapabilities.terminal` 时，shell 执行通过 reverse-RPC 交给客户端 |
| `elicitation/create` | 是 | 客户端声明 `elicitation.form` 时，ask-user 问题走原生表单；RPC 失败回退 `session/request_permission` |
| `elicitation/complete` | 否 | |

### 扩展方法

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| `session/set_model` | 是 | 从 ACP 0.23 不稳定面保留下来的扩展方法，等价于 `set_config_option({configId:'model'})` |

上述未列出的方法一律返回 `methodNotFound`。

## MCP 转发

ACP 客户端在 `session/new` 或 `session/load` 中提供 `mcpServers` 时，ACP server 做如下转换：

- `http` → kimi 的 `transport: 'http'` 配置
- `stdio` → kimi 的 `transport: 'stdio'` 配置
- `sse` → kimi 的 `transport: 'sse'` 配置
- `acp` → 丢弃并写一条 warn 日志

## 下一步

- [在 IDE 中使用](../guides/ides.md) — Zed / JetBrains 配置步骤和故障排查
- [kimi 命令参考](./kimi-command.md) — 完整子命令列表
