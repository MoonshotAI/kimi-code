# Permission / Approval Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的 permission-approval 决策流](#统一的-permission-approval-决策流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，**permission** 与 **approval** 是两个相邻但职责不同的 domain：

- `permission` = **command / policy（规则决策）**：管理权限模式（mode）、规则集（rules）、以及 `beforeToolCall` 时的规则引擎决策（approve / deny / ask）。它是 agent 进程内的策略引擎，决定一次工具调用“该不该放行、该不该拒绝、该不该问人”。
- `approval` = **runtime event（请求 / 解决事件）**：当 permission 决策为 `ask` 时，把一次“向人请示”的动作建模为一个**一次性请求-响应**（one-shot broker）：`request(req): Promise<resp>` + `resolve(id, resp)`，并伴随 `event.approval.*` 事件。它是 permission 决策的人类介入（human-in-the-loop）升级通道。

**这两个 domain 不需要合并、也不需要进一步拆分。** 边界当前就是干净的：

- permission 只做**规则决策**（mode / rules / beforeToolCall），不直接持有任何“等待中的请求”或 WS/REST 通道；当它需要人介入时，只通过一次 `requestApproval` 调用把决策权交给 approval。
- approval 只做**请求 / 解决的事件中转**（one-shot broker），不表达任何规则语义——它不知道为什么会发起这次请求、也不知道决策为 `approved` 之后要不要写 session 缓存；那些都留在 permission 侧。

**关系一句话：permission 自动决策；当规则要求人介入时，approval 是那条 human-in-the-loop 升级通道。**

接口定义见 `permission/index.ts` 的 `IPermissionService` 与 `services/approval/approval.ts` 的 `IApprovalService`；本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. “决策”与“等待人介入”是两个不同的关注点

一次工具调用的放行问题由两个步骤组成：

- **决策（decide）**：给定模式 + 规则集 + 调用上下文，算出 approve / deny / ask。这是**纯策略**，可以同步、可重放、可单测，不需要任何外部通道。
- **请示（escalate）**：仅当决策为 `ask` 时，需要把问题呈现给一个外部 waiter（Web 客户端、TUI、测试 mock），等待其返回 `approved` / `rejected` / `cancelled`。这是**异步、跨进程、带超时与取消**的一次性交互。

这两步的生命周期、依赖、失败语义都不同：

- 决策可以在没有客户端连接时照常运行（`ask` 退化为本地默认）。
- 请示必须绑定一个外部 waiter，有超时 / 取消 / 断连等运行时态。

因此它们分属两个 domain：permission 拥有决策，approval 拥有请示。

### 2. 命令 / 查询 / 运行时状态分开（按需要引入）

按 service-skill 的角色表，本组 domain 实际用到两类：

| 类型 | 关注 | 归属 |
|---|---|---|
| Command | 模式 / 规则的写入，工具调用前的规则决策 | `permission`（`PermissionManager` / `IPermissionService`） |
| Runtime | 等待人介入的请求 / 解决事件、pending 状态投影 | `approval`（`IApprovalService`） |
| Query | 多 scope 列表 / 搜索 / 计数 | **无**（permission 的 `data()` 是单份配置快照；approval 的 `listPending` 是运行时 per-session pending 投影，不是查询模型） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md) 的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才引入”。本组 domain 没有多 scope 查询模型，因此不引入 Query Service。

### 3. permission 不持有“等待中的请求”，approval 不表达“规则语义”

边界保持干净：

- permission 侧只持有**决策所需的状态**：mode、rules、session 级放行规则缓存（`sessionApprovalRulePatterns`）。它不知道某个 `ask` 当前是否已经发出请求、有没有 waiter、是否超时。
- approval 侧只持有**等待中的请求**：按 `toolCallId` 关联的 pending Promise，以及把它们广播给 waiter 的事件通道。它不知道为什么会发起这次请求，也不知道响应回来后要不要写 session 缓存。

这条边界是“是否需要拆分 / 合并”的唯一硬指标：只要 permission 不混入 pending-request 状态、approval 不混入规则语义，两个 domain 就是清晰的。

### 4. “approve for session” 是 permission 的规则写入，不是 approval 的状态

当用户对某次 `ask` 选择 `approved` + `scope: session` 时，系统会把一条 session 级放行规则记下来，使后续同类调用直接放行、不再请示。这条规则：

- 是 **permission 的规则集**的一部分（运行时 scope = `session-runtime`），由 permission 在收到 approval 响应后写回自己的规则缓存。
- **不是** approval 的状态——approval 只是把响应交给 permission，写完规则后 approval 不再持有它。

这避免了“规则缓存到底在谁手里”的二义性：所有规则（无论来自静态配置还是 session 运行时放行）都归 permission。

### 5. Service 层解析业务标识，transport 层只做形状适配

- `permission`：tool call 上下文、mode、rule pattern 的解析与匹配都在 agent 进程内的策略引擎完成；transport（`setPermission` RPC）只负责把 mode 写到 manager，不承载规则语义。
- `approval`：in-process SDK 形状（camelCase）与协议 wire 形状（snake_case）之间的字段翻译集中在 approval adapter（`toBrokerRequest` / `toAgentCoreResponse`）；REST / WS 路由不重新解释 approval 语义。

## Service 拆分概览

| Service | 一句话职责 | 角色 |
|---|---|---|
| `IPermissionService` | 权限模式 / 规则集的管理，以及 `beforeToolCall` 的规则决策 | command（policy） |
| `IApprovalService` | 把一次 `ask` 升级为“请求 / 解决”的一次性事件中转 | runtime（one-shot broker） |

> 只有这两个 Service。不引入 `IPermissionQueryService` / `IPermissionRuntimeService`，也不把 permission 与 approval 合并成一个 Service。
> 共享类型（`PermissionMode` / `PermissionRule` / `PermissionPolicyResult` / `ApprovalRequest` / `ApprovalResponse` 等）见 `permission/types.ts` 与 `services/approval/approval.ts`。

模式参考：

- permission 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)：mode / rules 的写入是这份 aggregate 的唯一写入入口；`beforeToolCall` 的决策是“命令驱动的策略判定”，不套用 create/archive/purge 生命周期骨架。
- approval 侧对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)：pending approval 是事件驱动的活状态投影，`request` / `resolve` 是其中转入口，`event.approval.*` 是其对外事件；它不写入真相（permission 规则由 permission 自己写）。

## 统一的 permission-approval 决策流

一次工具调用从“进入 permission”到“拿到放行结果”只有一条主路径：

```text
beforeToolCall(context)
  ├─ evaluatePolicies(context)
  │    ├─ approve  → 直接放行（可能带 executionMetadata）
  │    ├─ deny     → 直接拒绝（block + reason）
  │    └─ ask      → 进入 approval 升级通道
  │
  └─ (ask) requestToolApproval(context, askResult)
        ├─ approval.request(req)  ──────────────→  IApprovalService.request
        │                                            ├─ 登记 pending Promise (by toolCallId)
        │                                            └─ 广播 event.approval.requested 给 waiter
        │
        ├─ (waiter 返回) approval.resolve(id, resp) ─→  IApprovalService.resolve
        │                                            ├─ settle pending Promise
        │                                            └─ 广播 event.approval.resolved
        │
        └─ 回到 permission：recordApprovalResult(resp)
              ├─ 若 approved + scope=session → 写入 sessionApprovalRulePatterns
              └─ resolveApproval? / block + reason
```

要点：

- permission 是**唯一的决策点**：所有 approve / deny / ask 都由 `evaluatePolicies` 产出，外部通道（approval）只在 `ask` 分支出现。
- approval 是**唯一的请示中转**：所有“问人”都走 `IApprovalService.request` / `resolve`，并由它统一广播 `event.approval.*`；permission 不直接和 WS / REST / TUI 打交道。
- 决策结果的**副作用落在 permission**：session 级放行规则由 permission 写回自己的缓存，approval 只负责把响应交回。

> `agent.rpc.requestApproval` / `BridgeClientAPI.requestApproval` 是 approval 的**调用入口原语**，不是 `IPermissionService` 暴露的方法。permission 把它作为升级到 approval 的实现细节，对外只暴露规则决策语义。

## 关键场景

### 场景 A：规则直接放行（不触发 approval）

```ts
permissionService.beforeToolCall(context);
```

内部解析：`evaluatePolicies → 命中 approve policy → 返回 undefined / { executionMetadata }`。无 approval 交互，无事件广播。

### 场景 B：规则直接拒绝（不触发 approval）

```ts
permissionService.beforeToolCall(context);
```

内部解析：`evaluatePolicies → 命中 deny policy → 返回 { block: true, reason }`。无 approval 交互。

### 场景 C：规则要求请示（进入 approval 升级通道）

```ts
permissionService.beforeToolCall(context);
```

内部解析：

```text
evaluatePolicies → 命中 ask policy
  → requestToolApproval
    → approval.request(req)            // IApprovalService：登记 pending + 广播 event.approval.requested
    → ...等待...
    → approval.resolve(id, resp)        // IApprovalService：settle + 广播 event.approval.resolved
    → recordApprovalResult(resp)        // permission：写 session 缓存（如 scope=session）
    → resolveApproval? / block + reason
```

### 场景 D：切换权限模式（command）

```ts
// 经由 setPermission RPC → permission.setMode(mode)
```

内部解析：`rpc-controller.setPermission → permission.setMode(mode)`。这是 permission 的命令写入：记录 `permission.set_mode` 记录、推送 `permission_updated` 重放事件、更新 mode。不经过 approval。

### 场景 E：列出某 session 当前等待中的 approval（runtime 投影）

```ts
approvalService.listPending(sessionId);
```

内部解析：读取 approval 侧按 `toolCallId` 维护的 pending 集合，过滤出该 session 的协议形状请求。这是 approval 的运行时投影（用于 session status 生命周期判定 `awaiting_approval`），不是 permission 的查询，也不是查询模型。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 |
|---|---|---|
| 切换权限模式（manual / yolo / auto） | `setPermission` RPC → `permission.setMode(mode)` | command（permission） |
| 工具调用前的规则决策 | `permission.beforeToolCall(context)` | command（permission） |
| 读取当前模式 / 规则快照 | `permission.mode` / `permission.data()` | command-side read（permission） |
| 发起一次 human-in-the-loop 请示 | `approval.request(req)` | runtime（approval） |
| waiter 返回响应 | `approval.resolve(id, resp)` | runtime（approval） |
| 查看 session 等待中的请示 | `approval.listPending(sessionId)` | runtime（approval） |
| 订阅请示事件 | `event.approval.requested` / `resolved` / `expired` | runtime（approval） |
| session 级放行规则缓存 | `permission.recordApprovalResult` → `sessionApprovalRulePatterns` | command（permission） |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service
  IPermissionService          (command / policy — 模式、规则、beforeToolCall 决策)
  IApprovalService            (runtime — 请求 / 解决 one-shot broker、pending 投影)

Domain / Policy
  PermissionRule[]            (规则真相：mode + rules + session-runtime 缓存)
  PermissionPolicy[]          (决策策略链)

Infrastructure
  Approval 事件通道            (event.approval.requested / resolved / expired)
  Approval adapter             (toBrokerRequest / toAgentCoreResponse：SDK↔协议形状翻译)
  外部 waiter                  (Web 客户端 over WS / TUI / 测试 mock)
```

依赖关系：

```text
IPermissionService  → PermissionPolicy[] (决策策略链)
IPermissionService  → IApprovalService   (仅 ask 分支：requestApproval 升级)
IApprovalService    → Approval 事件通道 / adapter / 外部 waiter
```

禁止的边界：

```text
IPermissionService → 任何 transport / WS / REST 展示逻辑   (permission 不直接和 waiter 打交道)
IApprovalService   → PermissionPolicy / 规则语义           (approval 不解释为什么请示、不写规则缓存)
IPermissionService ⇄ IApprovalService 的业务方法互相调用    (permission 只单向升级到 approval；approval 不回调 permission 决策)
```

关键不变量：

- permission 侧不持有 pending-request 状态；approval 侧不持有规则语义。
- “approve for session” 的规则写回发生在 permission，approval 只交付响应。
- SDK↔协议形状翻译集中在 approval adapter，REST / WS 路由不重新解释 approval 语义。

## 决策记录

- **DR1：permission 与 approval 是两个独立 domain。** permission 是 command / policy（模式 + 规则 + beforeToolCall 决策）；approval 是 runtime（请求 / 解决 one-shot broker）。二者关注点不同、生命周期不同、失败语义不同，不合并。
- **DR2：不引入 Query Service。** permission 的 `mode` / `data()` 是单份配置快照，approval 的 `listPending` 是 per-session 运行时 pending 投影；两者都不是多 scope 查询模型，因此不开 `IPermissionQueryService` / `IApprovalQueryService`。
- **DR3：permission 不持有“等待中的请求”。** 决策所需状态（mode / rules / session 缓存）归 permission；pending Promise / 超时 / 断连等运行时态归 approval。这是“是否需要拆分 / 合并”的唯一硬指标，当前为“边界干净，无需改动”。
- **DR4：approval 不表达规则语义。** approval 只负责请求 / 解决中转与事件广播，不解释为什么发起请示、不写 session 放行规则。规则写回一律发生在 permission。
- **DR5：“approve for session” 是 permission 的规则写入。** 来自 session 运行时放行的规则与静态规则一样归 permission 的规则集；approval 只把响应交回 permission。
- **DR6：permission 单向升级到 approval。** `ask` 分支通过 `requestApproval` 进入 approval；approval 不回调 permission 的决策方法。决策结果（放行 / 拒绝 + session 缓存）由 permission 在收到响应后自己收尾。
- **DR7：SDK↔协议形状翻译集中在 approval adapter。** `toBrokerRequest` / `toAgentCoreResponse` 是唯一发生 camelCase↔snake_case 翻译的地方；REST / WS 路由只做转发，不重新解释 approval 语义。
- **DR8：当前代码布局已满足边界，无需迁移。** permission 在 `agent/permission/`（`PermissionManager` / `IPermissionService` / policies），approval 在 `services/approval/`（`IApprovalService` 契约）+ server 侧的 broker 实现。两个角色已经分离，没有发现重叠或渗漏，因此本次只出概念定稿，不做代码拆分。
