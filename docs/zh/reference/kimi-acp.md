# `kimi acp` 子命令

`kimi acp` 把 Kimi Code CLI 切换到 **ACP (Agent Client Protocol)** 模式：在标准输入/输出上以 JSON-RPC 形式与 ACP 客户端（如 Zed、JetBrains AI Chat 等）对话，让 IDE 直接驱动 kimi 的会话、prompt 与工具调用。

```sh
kimi acp
```

启动后命令不会打印任何 banner，立刻等待 ACP 客户端在 stdin 上发出 `initialize` 请求。日志会写到标准错误（以及 `~/.kimi-code/logs/` 下的诊断日志），所以 ACP 通道本身保持干净。

::: tip 谁会调用它？
你通常不需要手动跑 `kimi acp`——这个命令是给 IDE 的子进程入口准备的。IDE 端的配置见 [在 IDE 中使用](../guides/ides.md)。
:::

## 能力矩阵

下表列出当前 ACP 适配层声明的能力。`agentCapabilities` 字段在 `initialize` 响应里完整返回，IDE 端可据此调整 UI。

| 能力 | 取值 | 说明 |
| --- | --- | --- |
| `promptCapabilities.image` | `true` | 支持 ACP `image` 内容块（base64 + mimeType）。 |
| `promptCapabilities.audio` | `false` | 暂不支持音频 prompt。 |
| `promptCapabilities.embeddedContext` | `false` | 暂不支持嵌入式资源 prompt（`resource`/`resource_link` 走文本通道）。 |
| `mcpCapabilities.http` | `true` | 转发 IDE 配置的 HTTP MCP 服务。 |
| `mcpCapabilities.sse` | `false` | 不支持 SSE MCP 服务，相关条目会被丢弃并写 warn 日志。 |
| `loadSession` | `true` | 支持 `session/load` 续接已有会话，加载时会同步回放历史。 |
| `sessionCapabilities.list` | `{}` | 支持 `session/list` 枚举当前用户的会话。 |

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
| `session/resume` | 是 | `session/load` 的轻量兄弟方法，跳过历史回放（spec G4） |
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
| `session/set_model` | 是 | 兼容路径，等价于 `set_config_option({configId:'model'})`。也接受老的 `'<alias>,thinking'` 合并形式，会被拆为裸 model 的 `setModel` 加一次隐式的 `setThinking('high')` |
| `session/delete` · `session/fork` | 否 | 会话生命周期扩展 |
| `document/didOpen` · `didChange` · `didClose` · `didFocus` · `didSave` | 否 | 编辑器缓冲区同步 |
| `nes/start` · `suggest` · `accept` · `reject` · `close` | 否 | inline-edit 预测 |
| `providers/list` · `set` · `disable` | 否 | 内置 provider 管理（请用 `kimi provider`） |
| `elicitation/create` · `elicitation/complete` | 否 | 当前由 `session/request_permission` 覆盖 |

（`mcp/connect`、`mcp/disconnect`、`mcp/message` 虽然在 SDK enum 中声明，但 SDK 本身的 dispatcher 尚未路由，故不计入分母。）

上述未列出的方法一律返回 `methodNotFound`。

## 会话 configOptions

Phase 14 起，`session/new` 和 `session/load` 不再返回独立的 `modes` 字段，而是把所有 picker 都收敛到 ACP 规范的通用 `configOptions: SessionConfigOption[]` 数组下。Phase 15 进一步把 thinking 从 model id 拆出来变成独立的轴，Phase 16 把 thinking 从 `SessionConfigBoolean` 改成 2 项 `select`（`off` / `on`），因为 Zed 当前的 chip 渲染器只识别 `select`；目前公告**最多三个**选项：

- `id: 'model'`（`type: 'select'`、`category: 'model'`）— 列出 harness 配置的所有 model alias，**不再展开 `,thinking` 变体行**；thinking 走下面独立的轴。
- `id: 'thinking'`（`type: 'select'`、`category: 'thought_level'`，options 为 `[{value:'off'},{value:'on'}]`）— **仅当当前选中的 model 在 catalog 里标了 `thinkingSupported` 时才出现**；切到不支持的 model 后下次 `config_option_update` 会直接省掉这一条，客户端按 spec 的 "configOptions 集合可在不同更新之间增减" 重绘 picker 即可。
- `id: 'mode'`（`type: 'select'`、`category: 'mode'`）— 锁定的四模式分类法 PLAN D9：`default` / `plan` / `auto` / `yolo`。

`configOptions` 的样例（当前 model 支持 thinking）：

```json
{
  "configOptions": [
    {
      "type": "select",
      "id": "model",
      "name": "Model",
      "category": "model",
      "currentValue": "kimi-coder",
      "options": [
        { "value": "kimi-coder", "name": "Kimi Coder" },
        { "value": "kimi-v2", "name": "Kimi v2" }
      ]
    },
    {
      "type": "select",
      "id": "thinking",
      "name": "Thinking",
      "category": "thought_level",
      "currentValue": "off",
      "options": [
        { "value": "off", "name": "Thinking Off" },
        { "value": "on", "name": "Thinking On" }
      ]
    },
    {
      "type": "select",
      "id": "mode",
      "name": "Mode",
      "category": "mode",
      "currentValue": "default",
      "options": [
        { "value": "default", "name": "Default", "description": "Manual approvals; tools execute normally." },
        { "value": "plan", "name": "Plan", "description": "Read-only planning; no tool execution." },
        { "value": "auto", "name": "Auto", "description": "Auto-approve safe operations." },
        { "value": "yolo", "name": "YOLO", "description": "Auto-approve everything." }
      ]
    }
  ]
}
```

**切换：** 客户端推荐统一走 `session/set_config_option({ sessionId, configId, type, value })`。为了向后兼容，旧的 `session/set_session_mode` 和 `session/unstable_set_session_model` 仍可用，所有入口在适配层汇聚到同一个执行路径。各 `configId` 的语义：

- `'model'` 接受裸 alias id（如 `'kimi-coder'`）或旧的合并形式 `'kimi-coder,thinking'`——后者会被拆成裸 model 的 `setModel` 加一次隐式的 thinking-on，老客户端不会断。
- `'thinking'` 接受字符串 `'on'` / `'off'`，映射到 `Session.setThinking('high')`（`'on'`）或 `Session.setThinking('off')`（`'off'`）。`'low' / 'medium' / 'xhigh' / 'max'` 这种粒度刻意隐藏在适配层背后——ACP 暴露的 thinking 轴是二态的（Phase 16 用 2 项 `select` 而非 `SessionConfigBoolean`，仅为 Zed UI 兼容）。
- `'mode'` 接受 `'default' / 'plan' / 'auto' / 'yolo'`（PLAN D9）。

**变更通知：** model / thinking / mode 任一改变都会推送 `sessionUpdate: 'config_option_update'`，载荷为完整的 `configOptions` 快照。Phase 12 的 `current_mode_update` 已下线，不再发出。

## MCP 转发

ACP 客户端在 `session/new` 或 `session/load` 中提供 `mcpServers` 时，适配层会做如下转换：

- `http` → kimi 的 `transport: 'http'` 配置（headers 以 `Record<string, string>` 形式传入）。
- `stdio` → kimi 的 `transport: 'stdio'` 配置（env 同样转 Record）。
- `sse` / `acp` → 丢弃并写一条 warn 日志，避免错误地静默接受不支持的传输。

## 何时使用 `kimi acp`

- **直接接入 IDE**：见 [在 IDE 中使用](../guides/ides.md)。
- **写 ACP 客户端**：用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 接到 `kimi acp` 的 stdio，即可用一份代码同时驱动 kimi、Claude Code 等其他 ACP agent。
- **本地集成测试**：能力矩阵稳定后，本仓库的 `packages/acp-adapter` 也跑了一个 in-memory pipe 的 e2e 测试，可作为参考实现。

普通 CLI 交互依旧通过 `kimi`（不带 `acp` 子命令）启动 TUI。
