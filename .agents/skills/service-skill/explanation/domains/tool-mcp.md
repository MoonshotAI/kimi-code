# Tool / MCP Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的 tool-mcp 激活流](#统一的-tool-mcp-激活流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，**tool** 与 **mcp** 是两个相邻但职责不同的 domain：

- `tool` = **command / registry & policy（工具注册 + 激活策略）**：管理 agent 可见的工具集合（builtin / user / mcp 三类来源）的注册表，以及“哪些工具对当前 loop 可见”的激活策略（`setActiveTools` / `loopTools`）。它是 agent 进程内的**工具目录与策略**，决定一次 loop 能拿到哪些工具。
- `mcp` = **runtime（MCP 连接状态）**：管理每个 MCP server 的**连接生命周期与活状态投影**——`pending / connected / failed / disabled / needs-auth`、连接 / 断开 / 重连、以及状态变更订阅。它是 tool domain 的 mcp 来源背后的运行时真相。

**这两个 domain 不需要合并、也不需要进一步拆分。** 边界当前就是干净的：

- tool 只做**工具注册 + 激活策略**（registry / `setActiveTools` / `loopTools`），不直接持有任何 MCP 连接状态——没有 socket、没有 client、没有 per-server 的 `pending/connected/failed` 状态机；当它需要把某个 MCP server 的工具纳入注册表时，只通过订阅 mcp 的状态变更、读取 mcp 暴露的 `resolved(server)` 来反应式地维护注册表。
- mcp 只做**连接生命周期 + 活状态投影**，不表达任何工具注册 / 激活语义——它不知道某个 server 的工具最终被注册成了什么 qualified name、也不知道哪些工具当前对 loop 可见；那些都留在 tool 侧。

**关系一句话：mcp 拥有 MCP server 的连接状态；tool 订阅这份状态，把已连接 server 的工具纳入自己的注册表，并按激活策略决定可见性。**

接口定义见 `agent/tool/index.ts` 的 `IAgentToolService`（command owner）与 `services/tool/tool.ts` 的 `IToolService`（daemon/SDK 只读 facade），以及 `services/mcp/mcp.ts` 的 `IMcpService`（daemon/SDK 边界 facade，背后是 `mcp/connection-manager.ts` 的 `IMcpConnectionService` 运行时）；本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. “工具目录”与“连接状态”是两个不同的关注点

“agent 这次 loop 能调用哪些 MCP 工具”由两个步骤组成：

- **维护目录（register）**：给定三类来源（builtin / user / mcp）的工具集合，维护一份统一的工具注册表，并按激活策略算出 `loopTools`。这是**注册表 + 策略**，可以同步、可重放、可单测，不需要知道某个 MCP server 当前是 connected 还是 failed。
- **维持连接（connect）**：对每个 MCP server，建立 / 关闭 / 重连传输层，发现其工具，跟踪 `pending → connected / failed / needs-auth` 的状态迁移。这是**异步、跨进程、带超时与断连**的运行时态。

这两步的生命周期、依赖、失败语义都不同：

- 工具目录可以在没有 MCP 连接时照常运行（builtin / user 工具不依赖任何 server；mcp 工具随连接状态增删）。
- 连接状态必须绑定一个真实传输层，有超时 / 断连 / OAuth 等运行时态。

因此它们分属两个 domain：tool 拥有目录与激活策略，mcp 拥有连接状态。

### 2. 命令 / 查询 / 运行时状态分开（按需要引入）

按 service-skill 的角色表，本组 domain 实际用到两类：

| 类型 | 关注 | 归属 |
|---|---|---|
| Command | 工具注册 / 注销、激活策略（`setActiveTools`）、loop 工具解析 | `tool`（`ToolManager` / `IAgentToolService`） |
| Runtime | MCP server 的连接生命周期、per-server 活状态投影、状态变更订阅 | `mcp`（`IMcpConnectionService` 运行时 + `IMcpService` SDK facade） |
| Query | 多 scope 列表 / 搜索 / 计数 | **无**（tool 的 `data()` / `toolInfos()` 是单份注册表快照；mcp 的 `list()` 是 per-session 连接状态投影，不是查询模型） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md) 的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才引入”。本组 domain 没有多 scope 查询模型，因此不引入 Query Service。

### 3. tool 不持有“连接状态”，mcp 不表达“注册 / 激活语义”

边界保持干净：

- tool 侧只持有**目录与策略所需的状态**：`builtinTools` / `userTools` / `mcpTools` 三份注册表、`enabledTools` 激活集合、`mcpAccessPatterns`（MCP glob 策略）、`loopTools` 解析结果。它不知道某个 MCP server 当前是 connected 还是 failed、有没有 client、是否超时。
- mcp 侧只持有**连接状态**：按 server name 关联的 `InternalEntry`（status / client / tools / error）、状态变更 listener、initial-load 进度。它不知道某个工具最终被注册成了什么 qualified name、是否被激活。

这条边界是“是否需要拆分 / 合并”的唯一硬指标：只要 tool 不混入连接状态、mcp 不混入注册 / 激活语义，两个 domain 就是清晰的。

### 4. “mcp 工具进入注册表”是 tool 对 mcp 状态的反应，不是 mcp 的副作用

当某个 MCP server 从 `pending` 翻到 `connected` 时，它的工具需要出现在 agent 的注册表里；翻到 `failed / disabled` 时，需要被移除。这套反应：

- 是 **tool 的注册表维护**（`registerMcpServer` / `unregisterMcpServer`），由 tool 在收到 mcp 状态变更后执行。
- **不是** mcp 的副作用——mcp 只负责迁移连接状态并广播 `onStatusChange`，不关心 tool 侧如何消费这份状态。

这避免了“工具注册到底在谁手里”的二义性：所有工具（无论来自 builtin / user / mcp）都归 tool 的注册表。

### 5. “需要 OAuth” 的合成工具由 tool 侧构造，由 mcp 侧驱动

当一个远程 MCP server 翻到 `needs-auth` 时，tool 侧会构造一个合成的 `authenticate` 工具并纳入注册表，让模型可以触发 OAuth 流程。这条链路：

- **构造 + 注册**合成工具是 tool 的注册表操作（`registerNeedsAuthMcpServer`）。
- **驱动 OAuth**（提供 `oauthService` / `getRemoteServerUrl` / `reconnect`）是 mcp 的连接状态职责。

即：tool 决定“注册表里有没有这个 auth 工具”，mcp 决定“这个 server 为什么需要 auth、以及如何重连”。二者各管一段。

### 6. Service 层 facade 暴露运行时，transport 层只做形状适配

- `tool`：工具注册 / 激活策略的解析都在 agent 进程内的 manager 完成；command transport（如 `setActiveTools` RPC）只负责把激活集合写到 manager，不承载目录语义；SDK 只读 facade `IToolService.list` 只做 `ToolInfo` → `ToolDescriptor` 的形状翻译（`toProtocolTool`），不重新解释注册表语义。
- `mcp`：in-process 运行时（`IMcpConnectionService`）与 daemon/SDK 边界（`IMcpService`）之间的形状翻译集中在 `toProtocolMcpServer`（`McpServerInfo` → 协议 `McpServer`）；REST / WS 路由不重新解释 mcp 连接语义。

## Service 拆分概览

| Service | 一句话职责 | 角色 |
|---|---|---|
| `IAgentToolService` | 工具注册表（builtin / user / mcp）+ 激活策略（`setActiveTools` / `loopTools`） | command（registry & policy） |
| `IToolService` | daemon/SDK 只读 facade：列出工具描述符（`ToolInfo` → `ToolDescriptor` 形状翻译） | command-side read（SDK facade） |
| `IMcpService` | daemon/SDK 边界的 MCP server 列表与重连入口（运行时 facade） | runtime（facade） |
| `IMcpConnectionService` | in-process MCP 连接生命周期与 per-server 活状态投影 | runtime（connection state） |

> 只有这些 Service。不引入 `IAgentToolQueryService` / `IAgentToolRuntimeService`，也不把 tool 与 mcp 合并成一个 Service。
> `IToolService` 是 `services/tool/` 下的只读 SDK facade，是对 `getTools` 的薄投影 + 形状翻译，不构成独立的 Query Service（单一全局列表，非多 scope 查询模型）。
> `IMcpService` 是 `services/mcp/` 下的 daemon/SDK 边界 facade，它依赖 in-process 运行时 `IMcpConnectionService`（services → runtime 是允许的方向，见 AGENTS.md）。
> 共享类型（`ToolInfo` / `UserToolRegistration` / `McpServerEntry` / `McpServerStatus` / `McpServer` 等）见 `agent/tool/types.ts`、`mcp/connection-manager.ts` 与 `services/mcp/mcp.ts`。

模式参考：

- tool 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)：工具注册 / 激活是这份 aggregate 的写入入口；`loopTools` 是“命令驱动的策略解析”，不套用 create/archive/purge 生命周期骨架。
- mcp 侧对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)：MCP 连接状态是事件驱动的活状态投影，`connect` / `reconnect` / `remove` 是其生命周期入口，`onStatusChange` / `tool.list.updated` 是其对外事件；它不写入工具注册表（tool 注册表由 tool 自己写）。

## 统一的 tool-mcp 激活流

一个 MCP server 从“配置中出现”到“其工具进入 loop”只有一条主路径：

```text
mcp.connectAll(configs)                          // IMcpConnectionService：启动所有 server
  ├─ 每个 server: pending → connected / failed / needs-auth
  ├─ 状态迁移时 emit onStatusChange(entry)        // mcp 运行时：广播活状态
  │
  └─ tool.attachMcpTools() 订阅 onStatusChange
        ├─ connected  → registerConnectedMcpServer
        │     ├─ mcp.resolved(name) → { client, tools, enabledNames }
        │     ├─ registerMcpServer(...) → 写入 mcpTools 注册表（tool 侧）
        │     └─ emit tool.list.updated(reason='mcp.connected')
        ├─ needs-auth → registerNeedsAuthMcpServer
        │     ├─ 读取 mcp.oauthService / getRemoteServerUrl / reconnect
        │     ├─ 构造合成 authenticate 工具 → 写入 mcpTools 注册表（tool 侧）
        │     └─ emit tool.list.updated(reason='mcp.connected')
        ├─ failed     → unregisterMcpServer + emit tool.list.updated(reason='mcp.failed')
        └─ disabled / pending → unregisterMcpServer + emit tool.list.updated(reason='mcp.disconnected')

loopTools (getter)                                // tool：按激活策略解析本次 loop 的工具
  ├─ builtin / user 工具：按 enabledTools 过滤
  └─ mcp 工具：按 mcpAccessPatterns（glob）过滤已注册的 mcpTools
```

要点：

- mcp 是**唯一的连接状态 owner**：所有 `pending/connected/failed/needs-auth` 迁移都由 `McpConnectionManager` 产出，tool 只在 `onStatusChange` 的回调里被动反应。
- tool 是**唯一的注册表 owner**：所有工具（builtin / user / mcp / 合成 auth）的注册与注销都发生在 tool 侧；mcp 不直接写 tool 的注册表。
- 激活策略的**副作用落在 tool**：`setActiveTools` / `mcpAccessPatterns` / `loopTools` 都在 tool 侧，mcp 不参与“哪些工具对 loop 可见”的判定。

> `mcp.onStatusChange` / `mcp.resolved` 是 tool 消费 mcp 运行时的**调用入口原语**，不是 `IAgentToolService` 暴露的方法。tool 把它们作为反应式维护注册表的实现细节，对外只暴露目录与激活语义。

## 关键场景

### 场景 A：纯 builtin / user 工具（不涉及 mcp）

```ts
toolService.setActiveTools(['Read', 'Edit', 'Bash']);
toolService.loopTools;
```

内部解析：`setActiveTools` 写入 `enabledTools`；`loopTools` getter 按 `enabledTools` 从 `builtinTools` 解析。无 mcp 交互，无连接状态。

### 场景 B：MCP server 连接成功，工具进入注册表

```text
mcp.connect(name, config)
  → status: pending → connected
  → onStatusChange(entry{status:'connected'})
  → tool.registerConnectedMcpServer
    → mcp.resolved(name) → { client, tools, enabledNames }
    → tool.registerMcpServer(...) → mcpTools.set(qualified, { tool, serverName })
    → emit tool.list.updated(reason='mcp.connected')
```

### 场景 C：MCP server 连接失败 / 被禁用，工具移出注册表

```text
mcp.connect(name, config)
  → status: pending → failed | disabled
  → onStatusChange(entry)
  → tool.unregisterMcpServer(name) → 从 mcpTools / mcpToolsByServer 删除
  → emit tool.list.updated(reason='mcp.failed' | 'mcp.disconnected')
```

### 场景 D：MCP server 需要 OAuth，注册合成 authenticate 工具

```text
mcp.connect(name, config)
  → status: pending → needs-auth (401, 无静态 token)
  → onStatusChange(entry{status:'needs-auth'})
  → tool.registerNeedsAuthMcpServer
    → 读取 mcp.oauthService / getRemoteServerUrl / reconnect
    → createMcpAuthTool(...) → mcpTools.set(authToolName, ...)
    → emit tool.list.updated(reason='mcp.connected')
```

### 场景 E：切换激活策略（command）

```ts
toolService.setActiveTools(['Read', 'mcp__github__*']);
```

内部解析：`enabledTools = { Read }`，`mcpAccessPatterns = ['mcp__github__*']`。这是 tool 的命令写入：记录 `tools.set_active_tools`、更新激活集合与 glob 策略。不经过 mcp。

### 场景 F：daemon 列出 / 重启 MCP server（runtime facade）

```ts
mcpService.list();              // IMcpService：per-session 连接状态投影（适配为协议 McpServer）
mcpService.restart(serverId);   // IMcpService：触发重连
```

内部解析：`list` 读取 mcp 运行时的 per-server 状态并适配为协议形状；`restart` 经 CoreAPI 调用 `reconnectMcpServer`，由运行时重新进入 `pending → ...` 迁移。这是 mcp 的运行时投影 / 生命周期入口，不是 tool 的查询，也不是查询模型。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 |
|---|---|---|
| 注册 / 注销 user 工具 | `tool.registerUserTool` / `unregisterUserTool` | command（tool） |
| 设置激活工具（含 mcp glob） | `tool.setActiveTools(names)` | command（tool） |
| 解析本次 loop 可见工具 | `tool.loopTools` | command-side read（tool） |
| 读取工具注册表快照 | `tool.data()` / `tool.toolInfos()` | command-side read（tool） |
| daemon 列出工具描述符 | `toolService.list(sessionId?)`（SDK 只读 facade） | command-side read（tool） |
| 启动 / 连接所有 MCP server | `mcp.connectAll(configs)` / `mcp.connect(name, config)` | runtime（mcp） |
| 重连 / 移除 MCP server | `mcp.reconnect(name)` / `mcp.remove(name)` | runtime（mcp） |
| 列出 MCP server 连接状态 | `mcp.list()` / `mcpService.list()`（SDK facade） | runtime（mcp） |
| 读取已连接 server 的 client + tools | `mcp.resolved(name)` | runtime（mcp） |
| 订阅 MCP 状态变更 | `mcp.onStatusChange(listener)` | runtime（mcp） |
| mcp 工具随连接状态入 / 出注册表 | `tool.attachMcpTools` 订阅 `onStatusChange` → `registerMcpServer` / `unregisterMcpServer` | command（tool，反应式消费 runtime） |
| MCP 工具列表变更事件 | `tool.list.updated`（reason: `mcp.connected` / `mcp.failed` / `mcp.disconnected`） | runtime-derived event（tool 侧转发） |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service
  IAgentToolService            (command / registry & policy — 注册表、激活策略、loopTools 解析)
  IToolService                 (command-side read facade — daemon/SDK 只读 list，ToolInfo → ToolDescriptor)
  IMcpService                  (runtime facade — daemon/SDK 边界的 list / restart)

Runtime (in-process)
  IMcpConnectionService        (runtime — 连接生命周期、per-server 活状态投影、onStatusChange)

Domain / Policy
  Tool registry                (builtinTools / userTools / mcpTools + enabledTools / mcpAccessPatterns)
  MCP connection state         (per-server InternalEntry: status / client / tools / error)

Infrastructure
  MCP transports               (stdio / http / sse clients)
  OAuth orchestrator           (needs-auth 流程)
  SDK adapters                 (toProtocolTool / toProtocolMcpServer：runtime → 协议形状翻译)
  事件通道                      (onStatusChange / tool.list.updated)
```

依赖关系：

```text
IAgentToolService  → Tool registry / policy       (目录与激活策略)
IAgentToolService  → IMcpConnectionService        (仅反应式消费：onStatusChange / resolved / reconnect)
IToolService       → CoreAPI.getTools             (只读投影 + 形状翻译)
IMcpService        → IMcpConnectionService        (经 CoreAPI：list / reconnect)
IMcpConnectionService → MCP transports / OAuth    (连接生命周期)
```

禁止的边界：

```text
IAgentToolService     → MCP transports / client / status 状态机   (tool 不直接持有连接状态)
IMcpConnectionService → Tool registry / 激活策略                  (mcp 不解释工具如何注册 / 是否激活)
IAgentToolService ⇄ IMcpConnectionService 的业务方法互相调用       (tool 只单向订阅 mcp；mcp 不回调 tool 的目录方法)
```

关键不变量：

- tool 侧不持有 MCP 连接状态（无 client / 无 per-server status 状态机）；mcp 侧不持有工具注册表 / 激活策略。
- “mcp 工具进入 / 移出注册表”的反应发生在 tool，mcp 只交付状态变更。
- 合成 `authenticate` 工具的构造在 tool，驱动 OAuth 的能力（`oauthService` / `getRemoteServerUrl` / `reconnect`）在 mcp。
- runtime→协议形状翻译集中在 `toProtocolMcpServer`，REST / WS 路由不重新解释 mcp 连接语义。

## 决策记录

- **DR1：tool 与 mcp 是两个独立 domain。** tool 是 command / registry & policy（工具注册表 + 激活策略）；mcp 是 runtime（MCP 连接生命周期 + 活状态投影）。二者关注点不同、生命周期不同、失败语义不同，不合并。
- **DR2：不引入 Query Service。** tool 的 `data()` / `toolInfos()` 是单份注册表快照，mcp 的 `list()` 是 per-session 连接状态投影；两者都不是多 scope 查询模型，因此不开 `IAgentToolQueryService` / `IMcpQueryService`。
- **DR3：tool 不持有 MCP 连接状态。** 目录与策略所需状态（`builtinTools` / `userTools` / `mcpTools` / `enabledTools` / `mcpAccessPatterns`）归 tool；client / status 状态机 / 超时 / 断连 / OAuth 等运行时态归 mcp。这是“是否需要拆分 / 合并”的唯一硬指标，当前为“边界干净，无需改动”。
- **DR4：mcp 不表达工具注册 / 激活语义。** mcp 只负责连接生命周期与活状态投影（`connect` / `reconnect` / `remove` / `onStatusChange`），不解释工具如何注册为 qualified name、不决定是否激活。注册 / 激活一律发生在 tool。
- **DR5：“mcp 工具入注册表”是 tool 对 mcp 状态的反应。** tool 通过 `attachMcpTools` 订阅 `mcp.onStatusChange`，按 `connected / needs-auth / failed / disabled` 分别调用 `registerMcpServer` / `registerNeedsAuthMcpServer` / `unregisterMcpServer`；mcp 只广播状态，不写 tool 的注册表。
- **DR6：合成 authenticate 工具跨 domain 协作。** tool 负责构造并注册该合成工具（注册表操作）；mcp 负责提供 OAuth 驱动能力（`oauthService` / `getRemoteServerUrl` / `reconnect`）。二者各管一段，不互相侵入状态。
- **DR7：IMcpService 是 services/mcp 下的 runtime facade。** daemon/SDK 边界的 `list` / `restart` 经 CoreAPI 依赖 in-process 运行时 `IMcpConnectionService`（services → runtime 是 AGENTS.md 允许的方向）；协议形状翻译集中在 `toProtocolMcpServer`。
- **DR8：当前代码布局已满足边界，无需迁移。** tool 在 `agent/tool/`（`ToolManager` / `IAgentToolService`，command owner）+ `services/tool/`（`IToolService`，daemon/SDK 只读 facade）；mcp 运行时在 `mcp/connection-manager.ts`（`McpConnectionManager` / `IMcpConnectionService`），daemon/SDK facade 在 `services/mcp/`（`IMcpService` / `McpService`）。两个角色已经分离，没有发现重叠或渗漏，因此本次只出概念定稿，不做代码拆分。
