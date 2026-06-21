# Message / Context Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的 message-context 读取流](#统一的-message-context-读取流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，**message** 与 **context** 是两个相邻但职责不同的 domain：

- `message` = **query（消息列表 / 转录读取）**：面向 daemon / SDK 的**只读 transcript 查询**——`IMessageService.list(sid, query)` 与 `get(sid, mid)`。它回答“这个 session 有哪些消息、按什么顺序、长什么样”，把 agent-core 的 `ContextMessage` 历史适配成协议的 `Message` 形状（含 `deriveMessageId` 合成 id、`toProtocolMessage` 内容映射）。它**没有任何写入入口**。
- `context` = **runtime assembly（上下文装配）**：agent 进程内**模型当前上下文窗口**的装配——`ContextMemory` 维护 `_history` / `tokenCount`，负责 `appendMessage` / `appendLoopEvent` / `applyCompaction` / `project`，把内部历史投影成送给模型的 kosong `Message[]`。它回答“下一次喂给模型的上下文长什么样”。它是**运行时活状态 + 装配逻辑**，不是查询模型。

**这两个 domain 不需要合并、也不需要进一步拆分。** 边界当前就是干净的：

- message 只做**只读 transcript 查询**（`list` / `get`），不写 context、不驱动 compaction、不持有模型的当前上下文窗口；它只在需要“未落盘的活尾巴”时经 CoreAPI **读取** `getContext().history` 一次，把它拼到 wire transcript 后面。
- context 只做**上下文装配**（history / token / compaction / projection），不暴露 daemon 形状、不合成协议 id、不做分页；`IContextService` 是 agent 进程内的运行时接口，不是 SDK facade。

**关系一句话：context 拥有模型当前的上下文窗口；message 通过 wire transcript（必要时拼接 context 的活尾巴）向 daemon / SDK 提供只读 transcript 查询。**

接口定义见 `services/message/message.ts` 的 `IMessageService`（query facade）与 `agent/context/index.ts` 的 `IContextService` / `ContextMemory`（runtime assembly owner）；本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. “转录查询”与“上下文装配”是两个不同的关注点

“这个 session 发生过哪些消息”与“下一次送给模型的上下文长什么样”是两件不同的事：

- **转录查询（transcript）**：给定一个 session，列出它的全部消息历史（包括已被 compaction 折叠掉的早期消息），按协议形状返回，支持游标分页与角色过滤。这是**只读、可分页、可缓存**的查询，真相在 `wire.jsonl` 记录日志。
- **上下文装配（context window）**：维护模型**当前**的上下文窗口——追加用户 / 助手 / 工具消息，累计 token，按需 compaction 成 `[compaction_summary, ...tail]`，投影成 kosong `Message[]` 送给模型。这是**可变、运行时、有副作用**的装配逻辑，真相在 agent 进程内存。

这两者的生命周期、真相、副作用都不同：

- transcript 的真相在磁盘（`wire.jsonl`），读取不应改变 agent 状态；context 的真相在内存，每次 append / compaction 都会改变它。
- compaction 会**折叠** context（当前窗口变短），但 transcript 要**保留**全部被折叠的消息——所以 transcript 不能只读 `getContext().history`（否则折叠前的消息会丢失）。

因此它们分属两个 domain：message 拥有 transcript 查询，context 拥有上下文窗口装配。

### 2. 命令 / 查询 / 运行时状态分开（按需要引入）

按 service-skill 的角色表，本组 domain 实际用到两类：

| 类型 | 关注 | 归属 |
|---|---|---|
| Query | 多 scope 列表 / 单条读取：message list / get（游标分页、角色过滤、协议形状适配） | `message`（`IMessageService` / `MessageService`） |
| Runtime assembly | 上下文窗口的活状态与装配：append / compaction / projection / token 计数 | `context`（`IContextService` / `ContextMemory`） |
| Command | aggregate 写入入口 | **无**（message 没有写入；context 的 append / compaction 是装配副作用，不是 daemon 暴露的 aggregate 生命周期命令） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md) 的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才引入”。

- **message 已经是 query facade。** `IMessageService` 只有 `list` / `get` 两个读方法，没有写入方法、没有运行时状态、没有命令语义——它**就是** message aggregate 的 query 角色。再拆一个 `MessageQueryService` 不会引入新的契约，只是把同一个 facade 换个名字。
- **context 不是查询模型。** `IContextService.history` / `tokenCount` / `messages` 是上下文窗口的当前快照（装配的副产物），不是多 scope 的 list / search / count；它不在 SDK 边界暴露协议形状，因此不套用 Query Service 骨架。

### 3. message 不持有“上下文窗口”，context 不表达“transcript 查询语义”

边界保持干净：

- message 侧只持有**查询所需的缓存**：按 session 的 wire transcript LRU（`transcriptCache`）。它不知道模型的当前 token 数、不知道哪些消息已被 compaction 折叠、不调用 `appendMessage` / `applyCompaction`。
- context 侧只持有**装配所需的状态**：`_history` / `_tokenCount` / `openSteps` / `pendingToolResultIds` / `deferredMessages`。它不知道 daemon 的 `Message.id` 怎么合成、不知道 `before_id` / `after_id` 分页、不输出协议 `Message`。

这条边界是“是否需要拆分 / 合并”的唯一硬指标：只要 message 不混入上下文装配、context 不混入 transcript 查询，两个 domain 就是清晰的。

### 4. “transcript 还原”是 message 对 wire 记录的再归约，不是 context 的副作用

daemon 看到的 transcript 必须包含**全部被 compaction 折叠的早期消息**，而 `getContext().history` 在 compaction 后只剩 `[compaction_summary, ...tail]`。因此 message **不直接以 context 为真相**，而是：

- 读取 `wire.jsonl` 记录日志，按与 `ContextMemory` restore 相同的语义**再归约**一份完整 transcript（`readWireTranscript` / `WireTranscript`），只是 `context.apply_compaction` 在这里**保留前缀 + 插入摘要**，而不是丢弃前缀。
- 对正在运行的 session，wire 文件可能落后内存几条记录；message 用 `WireTranscript.foldedLength` 与 `getContext().history.length` 比较，把未落盘的尾巴**只读地拼上去**。

这避免了“transcript 真相在谁手里”的二义性：transcript 的真相在 wire 日志，由 message 还原；context 只负责模型当前窗口，不是 transcript 的真相来源。

### 5. Service 层 facade 暴露查询，transport 层只做形状适配

- `message`：transcript 还原（wire 再归约 + 活尾巴拼接）在 `MessageService` 内部完成；SDK 边界 `IMessageService.list` / `get` 只做 `ContextMessage` → 协议 `Message` 的形状翻译（`toProtocolMessage` / `deriveMessageId`）；REST 路由只负责游标校验与错误码映射（`SessionNotFoundError` → 40401、`MessageNotFoundError` → 40403），不重新解释 transcript 语义。
- `context`：上下文装配在 agent 进程内的 `ContextMemory` 完成；不直接暴露到 daemon / SDK 边界，message 只在必要时经 CoreAPI 读取它的 `history` 作为活尾巴来源。

## Service 拆分概览

| Service | 一句话职责 | 角色 |
|---|---|---|
| `IMessageService` | daemon/SDK 只读 transcript 查询：`list` / `get`（wire 再归约 + 活尾巴拼接 + 协议形状翻译） | query |
| `MessageService` | `IMessageService` 实现：wire transcript LRU + `_getProtocolMessages` 映射 | query（impl） |
| `IContextService` | agent 进程内的上下文窗口装配：history / token / compaction / projection | runtime assembly |
| `ContextMemory` / `ContextService` | `IContextService` 实现：append / applyCompaction / project | runtime assembly（impl） |

> 只有这些 Service。**不引入 `IMessageQueryService` / `MessageQueryService`**——`IMessageService` 已经是纯 query facade（只有 `list` / `get`，无写入、无运行时状态），再拆一层只是同名复制。
> **不引入 `IContextQueryService`**——`IContextService.history` / `messages` / `tokenCount` 是上下文窗口的当前快照，不是多 scope 查询模型。
> 共享类型（`ContextMessage` / `MessageListQuery` / `Message` / `WireTranscript` 等）见 `agent/context/types.ts`、`services/message/message.ts` 与 `services/message/transcript.ts`。

模式参考：

- message 侧对齐 [`query-service.md`](../../reference/patterns/query-service.md)：message list / get 是这个 aggregate 的读模型入口，`MessageListQuery`（`before_id` / `after_id` / `page_size` / `role`）就是统一的 `Query` 类型；scope 固定为单个 session，不扩展多 scope 便捷方法。`IMessageService` 已经把 query 角色的契约（list / get / 分页 / 过滤）一次性实现完，无需再拆。
- context 侧不对齐 query / command / runtime Service 骨架——它是 agent 进程内的**运行时装配**（更接近 [`runtime-service.md`](../../reference/patterns/runtime-service.md) 描述的“事件驱动活状态”，但活状态就是模型上下文窗口本身，不投影到 SDK）；它的“写入”是装配副作用（append / compaction），不是 daemon 暴露的 aggregate 生命周期命令。

## 统一的 message-context 读取流

一次 `GET /v1/sessions/{sid}/messages` 只有一条主路径：

```text
messageService.list(sid, query)                       // IMessageService：transcript 查询入口
  ├─ _requireSession(sid)                             //   确认 session 存在（→ SessionNotFoundError / 40401）
  ├─ _getTranscriptEntries(sid, summary)
  │     ├─ resumeSession(sid)                         //   确保 wire 协议版本已重写
  │     ├─ _readTranscriptCached(...)                 //   读 wire.jsonl + 再归约（LRU on size,mtime）
  │     │     └─ readWireTranscript → WireTranscript  //   完整 transcript（保留被折叠前缀）
  │     └─ coreApi().getContext({sid, agentId})       //   只读：取模型当前 history 作活尾巴
  │           └─ context.history.slice(foldedLength)  //   未落盘的 tail，append 到 transcript
  ├─ entries → toProtocolMessage(...)                 //   ContextMessage → 协议 Message（合成 id / created_at）
  └─ 按 before_id / after_id / page_size / role 分页  //   游标 + 角色过滤，created_at desc
```

要点：

- message 是**唯一的 transcript 查询 owner**：所有 `list` / `get` 都经 `IMessageService`，真相来自 wire 日志再归约，必要时只读拼接 context 活尾巴。
- context 是**唯一的上下文窗口 owner**：`_history` / `tokenCount` / compaction 都在 `ContextMemory`，message 不写它，只在需要活尾巴时经 CoreAPI 读一次 `history`。
- 协议形状适配的**副作用为零**：`toProtocolMessage` / `deriveMessageId` 是纯函数，不改变 context 或 wire 日志。

> `coreApi().getContext` 是 message 消费 context 运行时的**只读入口原语**，不是 `IMessageService` 暴露的方法。message 把它作为还原完整 transcript 的实现细节，对外只暴露 list / get 查询语义。

## 关键场景

### 场景 A：列出已落盘的 transcript（纯 wire，无活尾巴）

```ts
messageService.list(sid, { page_size: 50 });
```

内部解析：`_readTranscriptCached` 命中 wire transcript LRU；`getContext().history.length <= foldedLength`，无需拼接活尾巴；`toProtocolMessage` 映射后按 `created_at desc` 分页。无 context 写入。

### 场景 B：正在运行的 session，wire 落后内存几条

```text
messageService.list(sid, query)
  → _readTranscriptCached → WireTranscript{ entries, foldedLength }
  → getContext().history.length > foldedLength
  → liveTail = history.slice(foldedLength)            // 未落盘的 tail
  → return [...transcript.entries, ...liveTail]        // 只读拼接
```

内部解析：context 的活尾巴经 CoreAPI 只读取出、append 到 wire transcript 之后；message 不调用任何 `appendMessage` / `applyCompaction`。

### 场景 C：按 id 取单条消息

```ts
messageService.get(sid, 'msg_' + sid + '_000042');
```

内部解析：先 `_getProtocolMessages(sid)` 还原全量，再 `parseMessageId(mid)` 校验 `sessionId` 与 index；id 不属于该 session 或越界时抛 `MessageNotFoundError`（→ 40403）。纯查询。

### 场景 D：模型上下文窗口 compaction（context 侧，不影响 transcript）

```text
context.applyCompaction(result)
  → records.logRecord({ type:'context.apply_compaction', ...result })
  → _history = [ compaction_summary, ...tail ]         // 当前窗口被折叠
  → _tokenCount = result.tokensAfter
```

内部解析：context 折叠的是**模型当前窗口**；wire 日志里的早期记录仍在，`readWireTranscript` 仍能还原完整 transcript。message 侧的查询结果不因 compaction 丢失历史。

### 场景 E：message 读 wire 日志失败，降级到 live history

```text
messageService.list(sid, query)
  → _readTranscriptCached throws (wire 缺失 / 解析失败)
  → transcript === undefined
  → return context.history.map(message => ({ message }))   // 降级：仅用当前窗口
```

内部解析：transcript 读取失败时降级为 context 的当前 history（可能不含被折叠前缀），而不是让整个端点失败。这是 message 对 context 的**只读降级**，不是 context 的副作用。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 |
|---|---|---|
| 列出 session 消息（游标分页 / 角色过滤） | `messageService.list(sid, query)` | query（message） |
| 按 id 取单条消息 | `messageService.get(sid, mid)` | query（message） |
| 合成协议消息 id | `deriveMessageId(sessionId, index)` / `parseMessageId(id)` | query（message，纯函数） |
| ContextMessage → 协议 Message 形状翻译 | `toProtocolMessage(...)` | query（message，纯函数） |
| 还原完整 transcript（wire 再归约） | `readWireTranscript(sessionDir, agentId)` → `WireTranscript` | query（message，内部） |
| 取模型当前上下文窗口 | `context.history` / `context.messages` / `context.tokenCount` | runtime assembly（context） |
| 追加用户 / 系统提醒消息 | `context.appendUserMessage` / `appendSystemReminder` / `appendMessage` | runtime assembly（context） |
| 把 loop 事件装配进上下文 | `context.appendLoopEvent(event)` | runtime assembly（context） |
| 折叠上下文窗口 | `context.applyCompaction(result)` | runtime assembly（context） |
| 投影成送给模型的 Message[] | `context.project(messages)` / `context.messages` | runtime assembly（context，投影） |
| message 拼接活尾巴（只读） | `messageService._getTranscriptEntries` 内 `coreApi().getContext(...)` | query 消费 runtime（只读） |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service
  IMessageService              (query — daemon/SDK 只读 list / get，ContextMessage → 协议 Message)
  IContextService              (runtime assembly — 上下文窗口 history / token / compaction / projection)

Runtime (in-process)
  ContextMemory                (装配实现：append / applyCompaction / project)
  projector                    (project / trimTrailingOpenToolExchange：内部历史 → kosong Message[])

Domain / Policy
  MessageListQuery             (before_id / after_id / page_size / role — 统一 Query 类型)
  Context window state         (_history / _tokenCount / openSteps / pendingToolResultIds / deferredMessages)

Infrastructure
  Wire transcript reader       (readWireTranscript / WireTranscript：wire.jsonl 再归约)
  SDK adapters                 (toProtocolMessage / deriveMessageId / parseMessageId：内部 → 协议形状)
  CoreAPI handle               (message 经 ICoreRuntime 取 in-process getContext / listSessions)
```

依赖关系：

```text
IMessageService  → Wire transcript reader          (transcript 真相：wire.jsonl 再归约)
IMessageService  → CoreAPI.getContext / listSessions (只读：活尾巴 + session 存在性校验)
IMessageService  → ContextMessage (type only)      (仅类型导入，用于 toProtocolMessage 适配)
IContextService  → projector / compaction          (上下文窗口装配)
```

禁止的边界：

```text
IMessageService  → context.appendMessage / applyCompaction / project   (message 不写上下文窗口)
IContextService  → deriveMessageId / toProtocolMessage / MessageListQuery (context 不表达 transcript 查询 / 协议形状)
IMessageService ⇄ IContextService 的业务方法互相调用                     (message 只单向只读 context；context 不回调 message)
```

关键不变量：

- message 侧不持有上下文窗口状态（无 `_history` / `_tokenCount` / compaction 状态机）；context 侧不持有 transcript 查询 / 协议 id 合成 / 分页逻辑。
- transcript 的真相在 wire 日志（`readWireTranscript`），context 的当前窗口只是活尾巴来源，不是 transcript 真相。
- message 对 context 的引用仅限：(1) 类型导入 `ContextMessage`（形状适配），(2) 只读 `getContext().history`（活尾巴）；两者都不改变 context。
- runtime→协议形状翻译集中在 `toProtocolMessage`，REST 路由不重新解释 transcript 语义。

## 决策记录

- **DR1：message 与 context 是两个独立 domain。** message 是 query（transcript 只读查询：list / get）；context 是 runtime assembly（模型当前上下文窗口的 history / token / compaction / projection）。二者关注点不同、真相不同、副作用不同，不合并。
- **DR2：不引入 `MessageQueryService`。** `IMessageService` 已经是纯 query facade——只有 `list` / `get` 两个读方法，无写入、无运行时状态、无命令语义。再拆一个 `MessageQueryService` 不会引入新契约，只是把同一个 facade 同名复制；当前 message aggregate 的 query 角色已经由 `IMessageService` 一次性实现完。
- **DR3：不引入 `ContextQueryService`。** `IContextService.history` / `messages` / `tokenCount` 是上下文窗口的当前快照（装配副产物），不是多 scope 的 list / search / count；context 不在 SDK 边界暴露协议形状，不套用 Query Service 骨架。
- **DR4：message 不持有上下文窗口。** 查询所需状态（wire transcript LRU）归 message；上下文窗口状态（`_history` / `_tokenCount` / `openSteps` / compaction）归 context。这是“是否需要拆分 / 合并”的唯一硬指标，当前为“边界干净，无需改动”。
- **DR5：context 不表达 transcript 查询语义。** context 只负责上下文窗口装配（append / compaction / project），不合成协议 id、不做游标分页、不输出协议 `Message`。transcript 查询一律发生在 message。
- **DR6：transcript 真相在 wire 日志，由 message 再归约。** `getContext().history` 在 compaction 后只剩 `[compaction_summary, ...tail]`，不能作为 transcript 真相；message 读 `wire.jsonl` 并按 `ContextMemory` restore 语义再归约（`readWireTranscript`），保留被折叠前缀。context 的当前窗口仅作为未落盘活尾巴的只读来源。
- **DR7：message 对 context 的依赖是只读 + 类型导入。** message 只 (1) 类型导入 `ContextMessage` 用于 `toProtocolMessage` 适配，(2) 经 CoreAPI 只读 `getContext().history` 拼接活尾巴；不调用 `appendMessage` / `applyCompaction` / `project`。services → runtime 的方向是 AGENTS.md 允许的方向。
- **DR8：当前代码布局已满足边界，无需迁移。** message 在 `services/message/`（`IMessageService` / `MessageService`，query facade）+ `transcript.ts`（wire 再归约）；context 在 `agent/context/`（`ContextMemory` / `ContextService` / `projector`，runtime assembly）。两个角色已经分离，没有发现重叠或渗漏，因此本次只出概念定稿，不做代码拆分。
