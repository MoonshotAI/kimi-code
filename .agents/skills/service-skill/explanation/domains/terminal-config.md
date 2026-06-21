# Terminal / Config 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

> 范围说明：ROADMAP M4.8 把 `terminal` / `config` 放在同一个 step 里确认
> 边界。它们名字短、都挂在 `services/` 顶层、都经 REST 暴露，但**不是同一
> 个 domain**——本文先把它们拆清楚，再分别确认 query / command / runtime
> 各自落在哪一层，并说明为什么**不需要**代码拆分、改名或合并。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的终端与配置流](#统一的终端与配置流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，标题里的 “terminal / config” 是**两个相互独立的 domain**，共
享 “经 daemon / SDK 对外暴露” 的形状，但真相、键、作用域、副作用、对外入
口都不同：

- **terminal domain（PTY 终端生命周期 + 活帧流）**：在**某个 session 内**
  创建并持有交互式 PTY 进程。键是 `(sessionId, terminalId)`，真相是**进程内
  的 node-pty 子进程 + 其输出 / 退出事件流**（不落盘；服务进程退出即消
  失）。所有 terminal 都 scoped 到 session：创建时经 `ISessionService.get`
  取 cwd，再经 `resolveSafePath` 把 `input.cwd` 约束在 `session.metadata.cwd`
  内。
  - **query（查询）**：`ITerminalService.list(sessionId)` / `get(sessionId,
    terminalId)`——读 terminal 元数据快照（`Terminal`：`id` / `session_id` /
    `cwd` / `shell` / `cols` / `rows` / `status` / `created_at` / `exited_at`
    / `exit_code`）。
  - **command（命令）**：`ITerminalService.create`（spawn 一个 PTY，分配
    `term_<ulid>`）/ `write`（向进程 stdin 写）/ `resize`（改 PTY 窗口尺
    寸）/ `close`（kill 进程并标记 exited）。
  - **runtime（运行时 attach / spawn）**：`ITerminalService.attach` /
    `detach` / `detachAllForSink`——connection-scoped 的活订阅，按
    `(sessionId, terminalId, sink.id)` 持有 `TerminalAttachSink`，把
    node-pty 的 `onData` / `onExit` 事件推导成 `terminal_output` /
    `terminal_exit` 帧向外投递，并维护一个 ring buffer 用于 `sinceSeq` 重
    放。`TerminalBackend.spawn`（`NodePtyTerminalBackend`）是 runtime 的进
    程创建后端——它把 “活进程” 接入 terminal domain。这是 terminal domain
    的活状态 owner。
  - **infrastructure（基础设施，非 service）**：`TerminalBackend` /
    `TerminalProcess` / `TerminalFrame` / `TerminalAttachSink`（`terminal.ts`
    的类型契约）+ `disposeAll`（`terminal.ts:90`）——描述 “活进程 / 帧 / 订
    阅 sink” 的形状与批量 dispose，不是 `*Service`。
- **config domain（KimiConfig 读 / 写 facade）**：daemon / SDK 读写全局
  `KimiConfig` 的**薄 facade**。键是单一的 “the config”（无 id；全局只有一
  份），真相是 **core 进程持有的 config 文件（`configPath`）**——config
  domain **自己不拥有真相**，而是经 `ICoreRuntime` 的 in-process
  CoreAPI（`getCoreApi()`）委托给 `KimiCore.getKimiConfig` /
  `setKimiConfig`，由 core 负责读盘 / 合并 / 写盘。config domain 只负责：
  (a) 把 `KimiConfig` 投影成对外的 `ConfigResponse`（隐藏 apiKey 原文、派生
  `has_api_key`、snake↔camel 键转换）；(b) 在 `set` 成功后发布
  `event.config.changed`，通知下游（main agent、permission、thinking、
  telemetry 等）配置已变。
  - **query（查询）**：`IConfigService.get()` → `ConfigResponse`（reload +
    投影）。
  - **command（命令）**：`IConfigService.set(patch)` → 投影后的
    `ConfigResponse`，副作用 = 写盘（在 core）+ 发布
    `event.config.changed`。
  - config domain 本质上是 **core config 真相之上的投影 + 变更通知
    facade**，按 service-skill 的 “daemon / SDK facade” 形状暴露为顶层
    `IConfigService`；它不是 repository（真相在 core 进程），也不引入
    command / query 拆分。

**两者不是同一个 domain，也不需要进一步拆分、改名或合并。** 边界当前就是干
净的：

- `services/terminal`（terminal domain）只做**会话内 PTY 生命周期 + 活帧
  流**，不知道 config、不写 config、不读 config；唯一的 session 外依赖是
  `resolveSafePath`（cwd 约束）和 `ISessionService`（取 cwd）。
- `services/config`（config domain）只做**KimiConfig 投影 + 变更通知**，不
  知道 terminal、不持有任何进程、不 scoped 到 session；唯一的依赖是
  `ICoreRuntime`（真相 owner）和 `IEventService`（变更通知）。

**关系一句话：terminal 是会话内 PTY 生命周期 + 活帧流 domain（query +
command + runtime attach/spawn），config 是 core config 真相之上的投影 +
变更通知 facade（query + command）。两者不共享真相、不共享键、不共享作用域
、不互相调用，不应合并；当前代码已按目录物理分离，无需拆分或改名。**

接口 / 实现落点见 `services/terminal/terminal.ts` 的 `ITerminalService`
（terminal query + command + runtime facade，49–73 行）、
`services/terminal/terminalService.ts` 的 `TerminalService`（实现，43 行）
与 `NodePtyTerminalBackend`（spawn 后端，237 行）、
`services/config/config.ts` 的 `IConfigService`（config query + command
facade，4–9 行）、`services/config/configService.ts` 的 `ConfigService`
（实现 + 投影 + 变更通知，20 行）。共享协议类型（`Terminal` /
`CreateTerminalRequest` / `TerminalOutputMessage` / `TerminalExitMessage` /
`ConfigResponse` / `PatchConfigRequest`）见 `@moonshot-ai/protocol`。本文只
承载跨 Service 的概念叙述。

## 第一性原理

### 1. “terminal / config” 指代两件不同的事，不是单一 domain

它们都挂在 `services/` 顶层、都经 REST 暴露、都只有少量方法，但键 / 作用域
/ 真相完全不同：

- **terminal（会话内 PTY）**：在某个 session 内创建并持有交互式终端。键是
  `(sessionId, terminalId)`；真相是进程内的 node-pty 子进程 + 输出 / 退出事
  件流；每次 `create` 经 `ISessionService.get(sessionId)` 取 cwd，再经
  `resolveSafePath` 把 `input.cwd` 约束在 cwd 内。生命周期跟随 session 与
  服务进程——进程退出，terminal 消失；不落盘。
- **config（全局配置投影）**：读写全局 `KimiConfig`。键是单一的 “the
  config”（无 id）；真相是 core 进程持有的 config 文件；config domain 自己
  不持真相，经 `ICoreRuntime.getCoreApi()` 委托给 core。生命周期由
  `get` / `set` 驱动，`set` 成功后向全进程广播 `event.config.changed`。

把两者并成一个 “runtime / core service domain” 是误判：terminal 的真相是
**活进程**（易失、session-scoped），config 的真相是**磁盘文件**（持久、
global）。它们既不共享真相，也不共享键空间，也不共享作用域。

### 2. terminal 是会话内 PTY domain，query / command / runtime 各就其位

terminal domain 的职责可以按 “读快照 / 改生命周期 / 订阅活流” 清晰分层：

- **query**：`list` / `get` 只读 terminal 元数据快照（`Terminal`）。无副作
  用，不写进程、不持订阅。
- **command**：`create` / `write` / `resize` / `close` 是 terminal 生命周期
  的写入入口。`create` 分配 id + spawn 进程；`write` / `resize` 转发到
  `TerminalProcess`；`close` kill 进程并把 `Terminal.status` 置为
  `exited`。它们是 terminal domain 对 daemon / SDK 的写入。
- **runtime（attach / spawn）**：`attach` / `detach` / `detachAllForSink`
  持有 connection-scoped 的活订阅 sink；`onData` / `onExit` 把 node-pty 事
  件推导成 `terminal_output` / `terminal_exit` 帧，写入 ring buffer（受
  `maxBufferedFrames` 限额）并向所有 sink 投递；`attach(sinceSeq)` 用
  buffer 重放增量帧。`TerminalBackend.spawn`（`NodePtyTerminalBackend`）是
  runtime 的进程创建后端。runtime 不直接写 `Terminal` 真相之外的任何持久
  状态——它是进程内事件流的投影。

三者共用同一份 in-memory `records: Map<recordKey, TerminalRecord>`
（`terminalService.ts:51`），但**业务方法互不调用**：`create` / `write` /
`resize` / `close` 不调 `attach` / `detach`；`attach` / `detach` 也不调
command。它们通过共享的 `TerminalRecord`（process + sinks + buffer）协作，
而非通过业务方法互相调用——这正符合 service-skill 的 “command / query /
runtime 角色不互相调用业务方法”。

### 3. terminal 的 `create` 内嵌 `spawn` 不构成 muddle

`create` 内部调用 `this.backend.spawn(...)`（`terminalService.ts:74`）来创
建 node-pty 进程。这不意味着 “command 角色偷做了 runtime 的事”——`spawn`
是 terminal 生命周期创建的原子一步：`create` 的语义就是 “分配 id + 拉起进
程 + 登记 record + 返回元数据”。`TerminalBackend` 是注入的进程创建后端
（`TerminalServiceOptions.backend`，生产 = `NodePtyTerminalBackend`，测试
可注入 fake），它把 “如何拉起一个活进程” 与 “何时拉起 / 如何登记” 解耦。
`attach` / `detach` / 帧投递这条 runtime 流仍然独立，不被 `create` 复用。

### 4. config 是 core config 真相之上的投影 facade，不是 repository

`IConfigService.get` / `set` 看起来像 repository 的 `get` / `update`，但它
**不是** repository：

- config domain **不持有真相**：`KimiConfig` 的真相在 core 进程（
  `core-impl.ts` 的 `this.config` + `configPath` + `loadRuntimeConfigSafe`
  / `mergeConfigPatch` / `writeConfigFile`）。`ConfigService` 经
  `ICoreRuntime.getCoreApi()`（in-process CoreAPI，跳过 JSON 序列
  化）调用 `getKimiConfig` / `setKimiConfig`（`configService.ts:59-61`）。
- config domain 的职责是**投影 + 通知**：`toConfigResponse`
  （`configService.ts:64`）把 `KimiConfig` 投影成对外 `ConfigResponse`
  （隐藏 apiKey 原文、派生 `has_api_key`、camel→snake 键）；`set` 成功后发
  布 `event.config.changed`（`configService.ts:40-46`）。

因此 config domain **不引入** repository / index 角色——它没有自己的真相
要持久化。它是 core config 真相在 `services/` 层的 daemon / SDK facade。

### 5. config 的 query 与 `set` 共用 `IConfigService` 不构成 muddle

`IConfigService` 只有 `get` / `set` 两个方法，且实现里 `set` 不调 `get`
、各自独立访问 `coreApi()`。它们是同一 config facade 上的两个方法，共享的
只是 “coreAPI → toConfigResponse” 这条投影管道。为 `get` / `set` 各抽一
个 `IConfigQueryService` / `IConfigCommandService` 不带来新契约——只是同名
复制 + 管道复制。query 与 command 在 `IConfigService` 上同址，符合
service-skill 对 “小聚合 facade” 的容忍（见 AGENTS.md：角色只在 “有清晰
owner + 非空契约” 时才引入）。

### 6. 两者互不引用；向上各自由独立 transport 消费

- terminal 的对外入口：`packages/server/src/routes/terminals.ts`（REST
  list / create / get / close）+ `packages/server/src/start.ts` 的
  `wsGw.setTerminalHandler`（WebSocket attach / detach / write / resize /
  close，start.ts:223-233）。REST 负责生命周期快照，WebSocket 负责活帧流。
- config 的对外入口：`packages/server/src/routes/config.ts`（REST get /
  set，config.ts:40,61）。

terminal 不引用 config，config 不引用 terminal（`grep` 交叉引用为空）。
两者向上各自由独立的 transport 表面消费，不共享 transport、不共享真相、不
共享状态。

## Service 拆分概览

| Service / 角色 | 一句话职责 | 角色 | Domain |
|---|---|---|---|
| `ITerminalService` | 会话内 PTY facade：`list` / `get`（query）+ `create` / `write` / `resize` / `close`（command）+ `attach` / `detach` / `detachAllForSink`（runtime） | query + command + runtime（facade） | terminal |
| `TerminalService` | `ITerminalService` 实现：session → cwd → `resolveSafePath` → `TerminalBackend.spawn`；in-memory `records`；onData/onExit 帧推导 + ring buffer + sink 投递 | query + command + runtime（impl） | terminal |
| `NodePtyTerminalBackend`（`terminalService.ts:237`） | node-pty 进程创建后端：spawn shell + 桥接 onData/onExit/write/resize/kill | runtime infrastructure（非 service） | terminal |
| `TerminalBackend` / `TerminalProcess` / `TerminalFrame` / `TerminalAttachSink`（`terminal.ts`） | 活进程 / 帧 / 订阅 sink 的类型契约 | infrastructure（非 service） | terminal |
| `TerminalNotFoundError`（`terminal.ts:78`） / `disposeAll`（`terminal.ts:90`） | terminal 查找错误 + 批量 dispose helper | infrastructure（非 service） | terminal |
| `IConfigService` | 全局 KimiConfig facade：`get`（query）+ `set`（command） | query + command（facade） | config |
| `ConfigService` | `IConfigService` 实现：`coreApi()` → `getKimiConfig` / `setKimiConfig` + `toConfigResponse` 投影 + `event.config.changed` 通知 | query + command（impl） | config |
| `toConfigResponse` / `hasProviderCredential` / `convertKeysSnakeToCamel`（`configService.ts`） | KimiConfig → ConfigResponse 投影 + 凭证检测 + 键转换 | infrastructure（非 service） | config |

> 只有这些角色。**不为 terminal 拆出 `ITerminalQueryService` /
> `ITerminalCommandService` / `ITerminalRuntimeService`**——terminal 的
> query / command / runtime 已按方法语义在同一份 in-memory record 上清晰分
> 层，业务方法互不调用；为它们各抽接口只是把同一份 `records` Map 拆成三份
> 同名复制 + 管道复制。**不为 config 拆 command / query**——`IConfigService`
> 只有 `get` / `set` 两个方法，是 core config 真相的投影 facade 的直接暴
> 露，拆成两个接口不带来新契约。**不把 terminal / config 合并成一个
> “runtime service”**——两者键空间（`(sessionId, terminalId)` vs 单例）、
> 真相（活进程 vs 磁盘文件）、作用域（session vs global）、副作用（帧流
> vs 变更事件）完全相反，不能共存于一个 domain。
> 共享协议类型（`Terminal` / `CreateTerminalRequest` /
> `TerminalOutputMessage` / `TerminalExitMessage` / `ConfigResponse` /
> `PatchConfigRequest`）见 `@moonshot-ai/protocol`。

模式参考：

- query 侧对齐 [`query-service.md`](../../reference/patterns/query-service.md)
  的**只读 list / get 语义**：terminal 的 `list` / `get`、config 的 `get`
  都是只读读模型入口；但 terminal scope 是 `(sessionId, terminalId)`、
  config scope 是单例，无跨 scope 的统一分页 / search / count，所以**不
  套用**完整的 `BaseQuery` + scope 便捷方法骨架。
- command 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)
  的**唯一写入入口**语义：terminal 的 `create` / `write` / `resize` /
  `close`、config 的 `set` 各自是其 domain 的写入入口；但 terminal 没有
  create / update / archive / fork 生命周期族（`create` 是 spawn 而非持久
  化 aggregate 创建，`close` 是 kill 而非 archive），config 是单例投影（无
  lifecycle），所以**不套用**完整的 `ICommandService` 生命周期骨架。
- runtime 侧对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)
  描述的 “由进程内对象 / 事件流推导的活状态” 的 owner：`TerminalService`
  的 attach / detach / 帧投递持有 connection-scoped 的活订阅，由 node-pty
  事件推导 `terminal_output` / `terminal_exit` 帧向外投递；它不是 daemon /
  SDK 的 query / command facade。config domain **没有** runtime 角色——它
  的副作用是离散的 `event.config.changed` 通知（经 `IEventService`），不是
  持续活状态投影。

## 统一的终端与配置流

### terminal：创建（command）

```text
RPC/SDK create(sessionId, CreateTerminalRequest)
  → ITerminalService.create
    → ISessionService.get(sessionId)                       // 取 session + cwd
    → input.cwd ? resolveSafePath(cwd, input.cwd).absolute // 约束在 cwd 内
                : fs.realpath(session.metadata.cwd)
    → TerminalBackend.spawn({ cwd, shell, cols, rows })    // NodePtyTerminalBackend → node-pty
    → id = `term_${ulid()}`; record = { terminal, process, sinks, buffer, nextSeq, disposables, closed }
    → process.onData → onData(record, data); process.onExit → onExit(record, exitCode)
    → records.set(recordKey(sessionId, id), record)
    → return { ...terminal }                               // Terminal 快照（status: 'running'）
```

### terminal：列 / 读（query）

```text
RPC/SDK list(sessionId) / get(sessionId, terminalId)
  → ITerminalService.list / get
    → ISessionService.get(sessionId)                       // 校验 session 存在
    → records filtered by session_id / recordKey
    → return 快照（复制 Terminal，不暴露 record 内部 sinks / buffer）
```

### terminal：写 / 调整尺寸 / 关闭（command）

```text
RPC/SDK write / resize / close(sessionId, terminalId, ...)
  → ITerminalService.write / resize / close
    → requireRecord(sessionId, terminalId)                 // 校验 session + 取 record（否则 TerminalNotFoundError）
    → write  → record.process.write(data)
    → resize → record.terminal.cols/rows 更新 + record.process.resize(cols, rows)
    → close  → record.closed = true + record.process.kill() + markExited(record, null)
```

### terminal：订阅活帧流（runtime attach / spawn）

```text
WS attach(sessionId, terminalId, sink, { sinceSeq? })
  → ITerminalService.attach
    → requireRecord(...)
    → record.sinks.set(sink.id, sink)
    → replay = record.buffer.filter(frameSeq > sinceSeq)
    → for frame of replay: sink.send(frame)                // 增量重放
    → return { replayed: replay.length }

node-pty onData(data)
  → onData(record, data)
    → frame = { type: 'terminal_output', seq: ++record.nextSeq, session_id, terminal_id, timestamp, payload: { data } }
    → pushFrame(record, frame)                             // 写 ring buffer + 向所有 sink 投递

node-pty onExit({ exitCode })
  → onExit → markExited(record, exitCode)
    → record.terminal.status = 'exited' + exited_at + exit_code
    → frame = { type: 'terminal_exit', ... }
    → pushFrame(...) + disposeAll(record.disposables)      // 投递退出帧 + 释放 onData/onExit 订阅
```

### config：读（query）

```text
RPC/SDK get()
  → IConfigService.get
    → coreApi().getKimiConfig({ reload: true })            // in-process CoreAPI（core 进程重读盘）
    → toConfigResponse(KimiConfig)                         // 投影：隐藏 apiKey、派生 has_api_key、camel→snake
    → return ConfigResponse
```

### config：写（command + 变更通知）

```text
RPC/SDK set(PatchConfigRequest)
  → IConfigService.set
    → convertKeysSnakeToCamel(patch)                       // snake→camel 键转换
    → coreApi().setKimiConfig(camelPatch)                  // core 进程 merge + writeConfigFile
    → response = toConfigResponse(updated)
    → eventService.publish({ type: 'event.config.changed', agentId: 'main', sessionId: '__global__',
                              changedFields: Object.keys(patch), config: response })
    → return response
```

## 关键场景

### 场景 A：在 session 内创建一个交互式终端（terminal command）

用户在 CLI / Web 里请求 “在 session S 开一个终端”。daemon 经 REST
`routes/terminals.ts` 调用 `ITerminalService.create(S, req)`。`create` 取
session cwd、约束 `req.cwd`、spawn node-pty、分配 `term_<ulid>`、登记
record、返回 `Terminal` 快照（status `running`）。进程此时已活，但还没有订
阅者——输出帧会进入 ring buffer 等待 attach。

### 场景 B：把终端输出流式推到前端（terminal runtime）

前端经 WebSocket 连上，daemon 经 `start.ts` 的 `wsGw.setTerminalHandler`
调用 `attach(S, T, sink, { sinceSeq })`。`attach` 登记 sink，把 buffer 里
`seq > sinceSeq` 的帧重放给前端（断线重连不丢帧）。之后 node-pty 每产出
`onData`，`onData` → `pushFrame` 把帧写入 buffer 并向所有 sink 投递；进程
退出时 `onExit` → `markExited` 投递 `terminal_exit` 帧并释放订阅。连接断
开时 `detachAllForSink(sinkId)` 清理该连接在所有 terminal 上的 sink。

### 场景 C：向终端输入 / 调整尺寸 / 关闭（terminal command）

前端经 WebSocket 调用 `write(S, T, data)`（键盘输入）、`resize(S, T, cols,
rows)`（窗口尺寸变化）、`close(S, T)`（关闭终端）。三者经
`requireRecord` 校验后转发到 `TerminalProcess`；`close` 额外把
`Terminal.status` 置为 `exited` 并 kill 进程。REST `routes/terminals.ts`
也暴露 `close`，供非 WebSocket 客户端关闭终端。

### 场景 D：读取当前配置（config query）

用户在 CLI / Web 请求 “看当前配置”。daemon 经 REST `routes/config.ts` 调用
`IConfigService.get()`。`get` 经 `coreApi().getKimiConfig({ reload: true })`
让 core 重读盘，再经 `toConfigResponse` 投影成 `ConfigResponse`（apiKey 不
外泄，只返回 `has_api_key`）。

### 场景 E：修改配置并通知全进程（config command）

用户修改 default model / provider / permission。daemon 经 REST
`routes/config.ts` 调用 `IConfigService.set(patch)`。`set` 把 snake 键转
camel，经 `coreApi().setKimiConfig(...)` 让 core 合并 + 写盘，拿到更新后
的 `KimiConfig`，投影成 `ConfigResponse`，再发布
`event.config.changed`（`sessionId: '__global__'`）。下游（main agent 的
modelAlias、permission、thinking、telemetry 等）订阅该事件并刷新运行时配
置——config domain 自己**不**负责把变更应用到每个运行时，只负责通知。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 | Domain |
|---|---|---|---|
| 列出 session 内终端 | `terminalService.list(sid)` | query（facade） | terminal |
| 读单个终端元数据 | `terminalService.get(sid, tid)` | query（facade） | terminal |
| 创建终端（spawn PTY） | `terminalService.create(sid, req)` → `backend.spawn` | command（含 runtime spawn） | terminal |
| 向终端写输入 | `terminalService.write(sid, tid, data)` | command | terminal |
| 调整终端尺寸 | `terminalService.resize(sid, tid, cols, rows)` | command | terminal |
| 关闭终端 | `terminalService.close(sid, tid)` | command | terminal |
| 订阅终端输出 | `terminalService.attach(sid, tid, sink, opts)` | runtime | terminal |
| 取消订阅 | `terminalService.detach(sid, tid, sinkId)` / `detachAllForSink(sinkId)` | runtime | terminal |
| 帧推导 + ring buffer + 投递 | `onData` / `onExit` / `markExited` / `pushFrame`（`terminalService.ts`） | runtime（内部） | terminal |
| node-pty 进程后端 | `NodePtyTerminalBackend.spawn`（`terminalService.ts:237`） | runtime infrastructure | terminal |
| 读全局配置 | `configService.get()` → `coreApi().getKimiConfig` | query | config |
| 写全局配置 | `configService.set(patch)` → `coreApi().setKimiConfig` + `event.config.changed` | command | config |
| KimiConfig → ConfigResponse 投影 | `toConfigResponse` / `hasProviderCredential` / `convertKeysSnakeToCamel`（`configService.ts`） | infrastructure | config |
| REST 路由（terminal） | `packages/server/src/routes/terminals.ts` | transport | terminal |
| WebSocket（terminal 活流） | `packages/server/src/start.ts`（`wsGw.setTerminalHandler`） | transport / runtime | terminal |
| REST 路由（config） | `packages/server/src/routes/config.ts` | transport | config |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service (daemon / SDK facade)
  ITerminalService                      (terminal query + command + runtime — 会话内 PTY)
  IConfigService                        (config query + command — 全局 KimiConfig 投影 facade)

Runtime / Infrastructure (in-process)
  TerminalBackend / NodePtyTerminalBackend  (terminal runtime — node-pty spawn 后端)
  TerminalProcess / TerminalFrame / TerminalAttachSink (terminal 活进程 / 帧 / sink 契约)
  toConfigResponse / hasProviderCredential / convertKeysSnakeToCamel (config 投影 helper)

Persistence / Truth
  node-pty 子进程 + onData/onExit 事件流  (terminal 真相 — 进程内、易失、session-scoped)
  KimiCore.getKimiConfig / setKimiConfig + configPath 文件 (config 真相 — core 进程持有、持久、global)

Transport (above agent-core)
  packages/server/src/routes/terminals.ts   (terminal REST: list/create/get/close)
  packages/server/src/start.ts              (terminal WebSocket: attach/detach/write/resize/close)
  packages/server/src/routes/config.ts      (config REST: get/set)
```

依赖关系：

```text
ITerminalService.list/get          → ISessionService.get + records Map                (query → session + in-memory record)
ITerminalService.create            → ISessionService.get + resolveSafePath + TerminalBackend.spawn (command → cwd 约束 + spawn)
ITerminalService.write/resize/close → requireRecord + TerminalProcess                 (command → 进程转发)
ITerminalService.attach/detach     → requireRecord + sinks Map + ring buffer          (runtime → 活订阅 + 重放)
onData/onExit/markExited/pushFrame → TerminalFrame + sinks + disposeAll               (runtime → 帧推导 + 投递)
NodePtyTerminalBackend.spawn       → node-pty                                         (runtime infrastructure → 子进程)
IConfigService.get                 → ICoreRuntime.getCoreApi().getKimiConfig + toConfigResponse (query → core 投影)
IConfigService.set                 → ICoreRuntime.getCoreApi().setKimiConfig + IEventService.publish (command → core + 变更通知)
routes/terminals.ts                → ITerminalService                                 (transport → terminal)
start.ts (wsGw.setTerminalHandler) → ITerminalService.attach/detach/write/resize/close (transport → terminal runtime)
routes/config.ts                   → IConfigService                                   (transport → config)
```

禁止的边界：

```text
services/terminal/**     ⇄ services/config/**            (terminal 与 config 互不引用)
services/terminal/**     → IConfigService / KimiConfig   (terminal 不读 / 不写 config)
services/config/**       → ITerminalService / TerminalProcess (config 不持有任何进程、不 scoped 到 session)
services/terminal/**     → (持久化 records 到盘)          (terminal 真相是活进程，不落盘)
services/config/**       → (自己持有 config 真相)         (config 真相在 core，config domain 只投影)
ITerminalService (cmd)   → attach/detach 业务方法          (command 不调 runtime 业务方法；共享 record 协作)
ITerminalService (rt)    → create/write/resize/close       (runtime 不回调 command 业务方法)
ConfigService.set        → (跳过 coreApi 直接写盘)         (config 写必须经 core 的 setKimiConfig，避免双真相)
ConfigService            → (在 ConfigResponse 暴露 apiKey 原文) (投影必须派生 has_api_key，不外泄凭证)
```

关键不变量：

- terminal / config 两目录之间**零 import**（`grep` 交叉引用为空）。两者共
  享的只是 `@moonshot-ai/protocol` 的协议类型与 `di`，不共享任何 service
  / 状态 / 真相。
- terminal 的真相是 node-pty 子进程 + 事件流（进程内、易失、session-
  scoped）；config 的真相是 core 进程的 config 文件（core 持有、持久、
  global）。两种真相不重叠、不互相派生。
- terminal 的所有 `input.cwd` 经 `resolveSafePath` 约束在 session cwd 内
  （`terminalService.ts:67-70`）；config 不碰路径、不 scoped 到 session。
  两种作用域语义互不兼容，不能合并进同一个 domain。
- terminal 的 command 不调用 attach/detach 业务方法；runtime 也不回调
  command。它们通过共享的 in-memory `TerminalRecord`（process + sinks +
  buffer）协作，符合 “command / query / runtime 角色不互相调用业务方
  法”。
- config 的所有读 / 写都经 `ICoreRuntime.getCoreApi()`（in-process
  CoreAPI），不直接读盘 / 写盘（`configService.ts:59-61`）。这保证 config
  domain 不会与 core 形成 “双真相”。
- config 的 `set` 成功后必须发布 `event.config.changed`
  （`configService.ts:40-46`）；下游运行时刷新依赖该事件。config domain 自
  己不把变更应用到每个运行时，只负责投影 + 通知。

## 决策记录

- **DR1：“terminal / config” 是两个独立 domain，不是一个 domain。**
  terminal（会话内 PTY 生命周期 + 活帧流）、config（全局 KimiConfig 投影 +
  变更通知）共享 “经 daemon / SDK 对外暴露” 的形状，但键
  （`(sessionId, terminalId)` / 单例）、作用域（session / global）、真相
  （活进程 / 磁盘文件）、写语义、对外入口都不同。它们不合并成一个
  “runtime / core service domain”，也不互相调用。
- **DR2：terminal 是会话内 PTY domain，query + command + runtime 各就其
  位。** `ITerminalService` 的 `list` / `get` = query；`create` / `write`
  / `resize` / `close` = command；`attach` / `detach` / `detachAllForSink`
  + `onData` / `onExit` / `pushFrame` + `NodePtyTerminalBackend.spawn` =
  runtime。所有方法 scoped 到 session，`create` 经 `resolveSafePath` 约束
  cwd。
- **DR3：terminal 的 `create` 内嵌 `spawn` 不构成 muddle。** `spawn` 是
  terminal 生命周期创建的原子一步（分配 id + 拉起进程 + 登记 record），
  `TerminalBackend` 是注入的进程创建后端（生产 node-pty / 测试 fake），把
  “如何拉起活进程” 与 “何时拉起 / 如何登记” 解耦。attach / 帧投递这条
  runtime 流仍独立。
- **DR4：config 是 core config 真相之上的投影 + 变更通知 facade，不是
  repository。** config domain 不持有真相（真相在 core 进程的
  `configPath` 文件），经 `ICoreRuntime.getCoreApi()` 委托给
  `getKimiConfig` / `setKimiConfig`，只负责 `toConfigResponse` 投影 +
  `event.config.changed` 通知。因此 config domain **不引入** repository /
  index 角色。
- **DR5：config 的 `get` / `set` 共用 `IConfigService` 不构成 muddle。**
  它们是同一 config facade 上的两个方法，实现互不调用（`set` 不调
  `get`），共享的只是 “coreAPI → toConfigResponse” 投影管道。为它们各抽
  query / command 接口只是同名复制 + 管道复制。
- **DR6：两者互不引用 + 各自独立 transport 表面。** terminal →
  `routes/terminals.ts`（REST）+ `start.ts`（WebSocket `setTerminalHandler`）；
  config → `routes/config.ts`（REST）。两目录之间零 import。这条边界是
  “是否需要拆分 / 合并” 的硬指标：不共享真相、不互相调用、不共享
  transport，两类关注点就是清晰的。
- **DR7：不引入 `ITerminalQueryService` / `ITerminalCommandService` /
  `ITerminalRuntimeService`。** terminal 的 query / command / runtime 已按
  方法语义在同一份 in-memory record 上清晰分层，业务方法互不调用（经共享
  `TerminalRecord` 协作）。再抽三层接口只是把同一份 `records` Map 拆成三
  份同名复制 + 管道复制。
- **DR8：不为 config 拆 command / query。** `IConfigService` 只有 `get` /
  `set` 两个方法，是 core config 真相投影 facade 的直接暴露。拆成
  `IConfigCommandService` / `IConfigQueryService` 不带来新契约，反而把同
  一条 “coreAPI → toConfigResponse” 管道复制两遍。
- **DR9：不需要改名。** `terminal` / `ITerminalService` / `TerminalService`
  / `config` / `IConfigService` / `ConfigService` 的命名已精确反映其职责
  （terminal = PTY 终端生命周期；config = KimiConfig 投影 facade）。不存在
  “名字覆盖多个不相关关注点” 或 “名字误导” 的问题；现有命名与 service-
  skill 的 `<domain>.ts` + `<domain>Service.ts` command-facade 布局一致。
- **DR10：不需要拆分、合并或移动文件。** terminal 已物理隔离在
  `services/terminal/`（`terminal.ts` 契约 + `terminalService.ts` 实现 +
  node-pty 后端），config 已物理隔离在 `services/config/`（`config.ts` 契
  约 + `configService.ts` 实现 + 投影 helper）。两者零 cross-import、无
  god 残留（terminal 不碰 config，config 不碰 terminal / 进程）、各自独立
  transport。M4.8 结论：**保持现状**，仅在本概念定稿中固化边界。
