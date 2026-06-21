# Plugin 目标架构定稿

本文是**概念定稿**：不预设迁移路径。描述 plugin domain 的目标形态、依赖方
向、决策记录，并**显式记录它落在哪一层**——这是 M4.9 的核心结论。

> 范围说明：ROADMAP M4.9 字面上写 “`services/plugin/pluginService.ts`
> (new) + 从 `KimiCore` 迁出 7 个 plugin 方法”。但 plugin domain **早已**
> 被抽取成一个完整的 runtime 模块，挂在 `#/plugin`（
> `packages/agent-core/src/plugin/`）。按 service-skill 的 M1.1 分层规则
> （**runtime-consumed domain 留在 runtime，不进 `services/`**），M4.9
> **不是**一次代码抽取，而是一次**边界确认 + 概念定稿**：确认 plugin
> domain 留在 `#/plugin`，确认 `KimiCore` 上的 7 个 CoreAPI plugin 方法是
> wire protocol（留在 `KimiCore`），并说明为什么**不能**把它搬到
> `services/`。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的插件流](#统一的插件流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，plugin domain 是一个**已抽取完成、位于 runtime 层的聚合**：

- **plugin domain（插件生命周期 + 注册表 + 会话启动投影）**：管理 `kimiHomeDir`
  下已安装插件的**安装 / 启用 / 禁用 / 卸载 / 重载**，并把启用态插件投影成
  core runtime 在 session 启动时直接消费的三类派生数据——**skill 根目录**
  （`pluginSkillRoots`）、**session-start 注入**（`enabledSessionStarts`）、
  **MCP 服务器**（`enabledMcpServers`）。真相是 **`kimiHomeDir` 下的插件文件
  （`plugins/managed/<id>/`）+ 注册表索引（`installed.json`）+ 进程内
  `records: Map<id, PluginRecord>`**。
  - **command（生命周期写入）**：`install` / `setEnabled` /
    `setMcpServerEnabled` / `remove` / `reload`——修改注册表（落盘到
    `installed.json`），`install` 还会把源码物化到 `plugins/managed/<id>/`。
  - **query（读模型）**：`list` / `get` / `summaries` / `info`——只读
    `PluginRecord` 的派生快照（`PluginSummary` / `PluginInfo`）。无副作用。
  - **runtime projection（runtime 投影，非 service facade）**：
    `pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers`——从
    `records` 推导的**进程内派生读模型**，被 `KimiCore` 在
    `createSession` / `resumeSession` 启动时消费，用来接线 skills / MCP /
    session-start。它们**不是** daemon / SDK 的 `*Service` facade，而是
    runtime 内部的投影——因此**留在 runtime 层**，不进 `services/`。
- **落点**：`#/plugin`（`packages/agent-core/src/plugin/`），即 runtime
  模块（与 `src/session/` / `src/skill/` / `src/agent/` 同级）。契约
  `IPluginService` + 实现 `PluginService`（= `PluginManager` +
  `_serviceBrand` + `unwrap` 迁移桥）见 `src/plugin/manager.ts`（
  `PluginManager` `:35`，`IPluginService` `:284`，`PluginService` `:292`）。
- **wire methods（留在 `KimiCore`）**：`KimiCore` 上的 7 个 CoreAPI plugin
  方法（`core-impl.ts:755-817`）是 **wire protocol**——它们是 CoreAPI 的
  JSON-RPC 表面，本身只做 `await this.pluginsReady` +
  `assertPluginsLoaded()` + 委托给 `this.plugins` + 错误码映射（reload 失败
  → `PLUGIN_LOAD_FAILED`，info 未找到 → `PLUGIN_NOT_FOUND`）。它们**不是**
  plugin domain 的业务逻辑，而是 wire 表面，因此**留在 `KimiCore`**。

**M4.9 结论：不移动、不拆分、不抽取。** plugin domain 已经在 `#/plugin`
（runtime）完整抽取，边界干净；`KimiCore` 上的 7 个方法是 wire protocol，
留在 `KimiCore`。把它搬到 `services/plugin/` 会强制 `rpc/core-impl.ts`（
runtime）→ `services/` 的反向 import，**违反 M0.1 fence**（见
[依赖方向与边界](#依赖方向与边界)）。

接口 / 实现落点见 `packages/agent-core/src/plugin/manager.ts` 的
`PluginManager`（35 行）/ `IPluginService`（284 行）/ `PluginService`
（292 行），以及 `packages/agent-core/src/plugin/index.ts`（再导出，6–7
行）。注册表持久化见 `src/plugin/store.ts`（`readInstalled` /
`writeInstalled`）；派生类型见 `src/plugin/types.ts`（`PluginSummary` 99
行 / `PluginInfo` 114 行 / `ReloadSummary` 131 行 /
`EnabledPluginSessionStart` 126 行 / `PluginMcpServerInfo` 50 行）。wire
表面见 `packages/agent-core/src/rpc/core-impl.ts`（7 个方法 755–817 行，
`assertPluginsLoaded` 819 行，`this.plugins` 字段 157 行、构造 205 行、
ready 信号 210–212 行）。本文只确认边界；代码已在 `#/plugin`，无需变更。

## 第一性原理

### 1. plugin 是一个完整的 runtime 聚合，不是 “挂在 services/ 顶层的 facade”

plugin domain 拥有**自己的真相 + 自己的生命周期 + 自己的派生投影**：

- **真相**：`kimiHomeDir` 下的插件文件（每个插件物化到
  `plugins/managed/<id>/`）+ 注册表索引（`installed.json`，由
  `store.ts` 读写）+ 进程内 `records: Map<string, PluginRecord>`
  （`manager.ts:37`）。`load()` / `reload()` 从 `installed.json` 重建
  `records`；`install` / `setEnabled` / `setMcpServerEnabled` / `remove`
  改 `records` 后 `persist()` 回 `installed.json`。
- **生命周期写入（command）**：`install(source)` 解析 source
  （local-path / zip-url / github）→ 下载 / 拷贝 → `parseManifest` →
  物化到 `plugins/managed/<id>/` → 登记 record → persist；`setEnabled` /
  `setMcpServerEnabled` / `remove` 改 record + persist；`reload` 从磁盘
  重建整份 `records` 并返回 `ReloadSummary`（added / removed / errors）。
- **读模型（query）**：`list` / `get` 返回 `PluginRecord`；
  `summaries` / `info` 把 record 投影成对外的 `PluginSummary` /
  `PluginInfo`（含 `displayName` / `version` / `state` /
  `skillCount` / `mcpServerCount` / `enabledMcpServerCount` /
  `hasErrors` / `mcpServers` / `diagnostics` 等派生字段）。
- **runtime 投影（被 core runtime 消费）**：`pluginSkillRoots`（启
  用插件的 skill 根目录，喂给 skill discovery）、`enabledSessionStarts`
  （启用插件声明的 session-start skill，喂给 session 启动注入）、
  `enabledMcpServers`（启用插件声明的 MCP 服务器，经
  `withPluginMcpRuntime` 注入 `KIMI_CODE_HOME` / `KIMI_PLUGIN_ROOT` 环境
  + `node` fallback 重写）。

这四类关注点**共享同一份 `records` Map 与同一个 `kimiHomeDir` 真相**，是
同一个聚合的不同面，不是多个 domain。

### 2. command / query / runtime projection 各就其位，但共享同一份 record

plugin domain 的方法可以按 service-skill 的角色清晰归类：

- **command**：`install` / `setEnabled` / `setMcpServerEnabled` / `remove`
  / `reload` 是 plugin 注册表的**唯一写入入口**。它们改 `records` 并
  `persist()` 到 `installed.json`；`install` 额外物化文件。
- **query**：`list` / `get` / `summaries` / `info` 只读 `records`，无
  副作用。
- **runtime projection**：`pluginSkillRoots` / `enabledSessionStarts` /
  `enabledMcpServers` 是**从 `records` 推导的派生读模型**，被 core
  runtime 在 session 启动时消费。

三者共用同一份 `records`（`manager.ts:37`），但**业务方法互不调用**：
command 不调 query / projection 的业务方法；projection 不调 command。
它们通过共享的 `PluginRecord` 协作，符合 service-skill 的 “command /
query / runtime 角色不互相调用业务方法”。

### 3. runtime projection 留在 runtime，不进 `services/`

`pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers` 看起来
像 “给上层用的读模型”，但它们**不是** daemon / SDK 的 `*Service`
facade：

- 它们是**进程内派生读模型**，从 `records` 直接推导，不经 JSON 序列化、
  不经 RPC、不经 daemon。
- 它们的**唯一消费者是 `KimiCore`**（runtime）——`createSession` /
  `resumeSession` 在 session 启动时调用 `this.plugins.enabledSessionStarts()`
  （`core-impl.ts:253` / `367`）与
  `this.mergePluginMcpConfig(...)` → `this.plugins.enabledMcpServers()`
  （`core-impl.ts:872`），把派生数据接进 `Session` 构造。
- 它们不属于 “经 daemon / SDK 对外暴露” 的表面；对外暴露给 daemon / SDK
  的是 `KimiCore` 上的 7 个 CoreAPI wire 方法（见下一节），不是这三个
  projection。

按 service-skill 的 M1.1 规则（“被 runtime aggregate 直接消费的
repository / index / 派生读模型，**留在 runtime 层**，因为 runtime 不能
反向 import `services/`”），这三个 projection 与它们的 owner
`PluginManager` **必须留在 runtime**。

### 4. `KimiCore` 上的 7 个 CoreAPI plugin 方法是 wire protocol，留在 `KimiCore`

`KimiCore` 上有 7 个 CoreAPI plugin 方法（`core-impl.ts:755-817`）：

| CoreAPI 方法 | 行 | 行为 |
|---|---|---|
| `installPlugin` | 755 | `await pluginsReady` + `assertPluginsLoaded` → `this.plugins.install(source)` → 在 `summaries()` 里找到对应 `PluginSummary` 返回 |
| `listPlugins` | 762 | `await pluginsReady` + `assertPluginsLoaded` → `this.plugins.summaries()` |
| `setPluginEnabled` | 768 | `await pluginsReady` + `assertPluginsLoaded` → `this.plugins.setEnabled(id, enabled)` |
| `setPluginMcpServerEnabled` | 774 | `await pluginsReady` + `assertPluginsLoaded` → `this.plugins.setMcpServerEnabled(id, server, enabled)` |
| `removePlugin` | 784 | `await pluginsReady` + `assertPluginsLoaded` → `this.plugins.remove(id)` |
| `reloadPlugins` | 790 | `this.plugins.reload()`，失败时把 error 记入 `pluginsLoadError` 并抛 `KimiError(PLUGIN_LOAD_FAILED)`（**不**调 `assertPluginsLoaded`——reload 是恢复路径） |
| `getPluginInfo` | 805 | `await pluginsReady` + `assertPluginsLoaded` → `this.plugins.info(id)`，未找到抛 `KimiError(PLUGIN_NOT_FOUND)` |

它们**不是** plugin domain 的业务逻辑——业务逻辑全在 `#/plugin` 的
`PluginManager`。它们是 **CoreAPI 的 wire 表面**，职责只有三件：

1. **就绪门控**：`await this.pluginsReady`（`core-impl.ts:210-212`，
   由 `this.plugins.load()` 驱动）+ `assertPluginsLoaded()`（
   `core-impl.ts:819`，把 `load` 时捕获的 `pluginsLoadError` 以
   `PLUGIN_LOAD_FAILED` 抛出）——保证 wire 调用前插件已加载。
2. **委托**：直接转发到 `this.plugins.<method>`。
3. **错误码映射**：把 runtime 异常投影成 CoreAPI 错误码（reload →
   `PLUGIN_LOAD_FAILED`；info 未找到 → `PLUGIN_NOT_FOUND`），这是
   **wire 层职责**（CoreAPI 协议语义），不是 plugin domain 的业务规则。

wire 表面属于 `KimiCore`（CoreAPI 的实现体），不拆、不迁。把错误码映射
留在 `KimiCore` 也是对的：`PLUGIN_LOAD_FAILED` / `PLUGIN_NOT_FOUND` 是
CoreAPI 协议错误码，由 wire 层拥有。

### 5. 把 plugin 搬到 `services/` 会强制 runtime→services 反向 import

`KimiCore`（`rpc/core-impl.ts`）**直接持有** `this.plugins: IPluginService`
（字段 `core-impl.ts:157`），并在构造里 `new PluginService({ kimiHomeDir })`
（`core-impl.ts:205`），还在 session 启动路径里同步调用
`this.plugins.enabledSessionStarts()` / `enabledMcpServers()`
（`core-impl.ts:253, 367, 872`）。

如果把 plugin domain 搬到 `services/plugin/`，那么 `rpc/core-impl.ts` 必须
`import { PluginService, type IPluginService } from
'@moonshot-ai/agent-core/services/plugin'`（或相对 `../services/plugin/...`）。
这是一条 **runtime（`rpc/`）→ `services/` 的反向 import**，直接违反
service-skill 的依赖方向规则，并被 M0.1 fence 当场拦截——
`packages/agent-core/test/dependency-direction.test.ts` 的 `RUNTIME_DIRS`
包含 `rpc`（`:24`），它会扫描 `rpc/**` 并把任何解析进 `src/services` 的
specifier 判为违规（`:64-74`）。

因此：**plugin domain 不能进 `services/`**。它留在 `#/plugin`（runtime），
由 `KimiCore` 直接消费，依赖方向合法（runtime 内部同级模块互引）。

## Service 拆分概览

| Service / 角色 | 一句话职责 | 角色 | Domain |
|---|---|---|---|
| `IPluginService`（`manager.ts:284`） | plugin 聚合 facade：`install` / `setEnabled` / `setMcpServerEnabled` / `remove` / `reload`（command）+ `list` / `get` / `summaries` / `info`（query）+ `pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers`（runtime projection）。DI 装饰器 `createDecorator('pluginService')`（`manager.ts:290`） | command + query + runtime projection（facade） | plugin |
| `PluginService`（`manager.ts:292`） | `PluginManager` + `_serviceBrand` + `unwrap()` 迁移桥；构造签名 `PluginManagerOptions`（`kimiHomeDir`） | command + query + runtime projection（impl） | plugin |
| `PluginManager`（`manager.ts:35`） | plugin 真相 owner：`records: Map<id, PluginRecord>` + `kimiHomeDir`；install / enable / disable / remove / reload / load + 三类投影 | command + query + runtime projection（impl） | plugin |
| `store.ts`（`readInstalled` / `writeInstalled`） | 注册表 `installed.json` 持久化（版本化 `InstalledFile`） | persistence（非 service） | plugin |
| `manifest.ts`（`parseManifest`） / `source.ts`（`resolveInstallSource`） / `github-resolver.ts` / `archive.ts` | 插件清单解析 + source 解析 + github tarball 解析 + zip 下载 / 解压 | infrastructure（非 service） | plugin |
| `types.ts`（`PluginRecord` / `PluginSummary` / `PluginInfo` / `ReloadSummary` / `EnabledPluginSessionStart` / `PluginMcpServerInfo` / `normalizePluginId`） | plugin 聚合类型契约 | infrastructure（非 service） | plugin |
| `KimiCore` 7 个 plugin 方法（`core-impl.ts:755-817`）+ `assertPluginsLoaded`（`:819`） | CoreAPI wire 表面：就绪门控 + 委托 `this.plugins` + 错误码映射 | wire protocol（留在 `KimiCore`，非 service） | (CoreAPI wire) |

> 只有这些角色。**不为 plugin 拆出 `IPluginCommandService` /
> `IPluginQueryService` / `IPluginRuntimeService`**——plugin 的 command /
> query / runtime projection 已按方法语义在同一份 `records` Map 上清晰分
> 层，业务方法互不调用；为它们各抽接口只是把同一份 `records` Map 拆成三份
> 同名复制 + 管道复制。**不把 plugin 搬到 `services/plugin/`**——它会被
> runtime（`KimiCore`）直接消费，搬到 `services/` 会强制 runtime→services
> 反向 import，违反 M0.1 fence。**不把 `KimiCore` 上的 7 个 wire 方法下沉
> 到 plugin domain**——它们是 CoreAPI wire 表面（就绪门控 + 错误码映射），
> 属于 `KimiCore`，不属于 plugin 业务逻辑。

模式参考：

- query 侧对齐 [`query-service.md`](../../reference/patterns/query-service.md)
  的**只读 list / get 语义**：plugin 的 `list` / `get` / `summaries` /
  `info` 都是只读读模型入口；但它们读的是进程内 `records` Map（不是跨
  scope 的 repository），无统一分页 / search / count，所以**不套用**完整的
  `BaseQuery` + scope 便捷方法骨架。
- command 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)
  的**唯一写入入口**语义：plugin 的 `install` / `setEnabled` /
  `setMcpServerEnabled` / `remove` / `reload` 是注册表的唯一写入入口；但
  plugin 的生命周期是 install / enable / disable / remove（不是 create /
  update / archive / restore / purge / fork 族），所以**不套用**完整的
  `ICommandService` 生命周期骨架。
- runtime 侧对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)
  描述的 “由进程内对象 / 事件流推导的活状态” 的 owner 精神：plugin 的
  `pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers` 是从
  进程内 `records` 推导的派生读模型，被 core runtime 直接消费；但它**不
  是** daemon / SDK 的 runtime facade（无 per-id 活状态订阅、无事件流投
  递），所以**不抽出**独立的 `IPluginRuntimeService`，而是作为
  `IPluginService` 上的 projection 方法留在 runtime。

## 统一的插件流

plugin domain 的统一流分两条：**生命周期流**（command / query，经 wire 暴
露给 daemon / SDK）和**会话启动投影流**（runtime projection，被 `KimiCore`
内部消费）。

### 生命周期流（daemon / SDK → wire → plugin domain）

```text
daemon / SDK
  → CoreAPI (JSON-RPC wire)
    → KimiCore.installPlugin / listPlugins / setPluginEnabled /
       setPluginMcpServerEnabled / removePlugin / reloadPlugins / getPluginInfo
       (core-impl.ts:755-817 — await pluginsReady + assertPluginsLoaded + 错误码映射)
      → this.plugins.<method>  (IPluginService)
        → PluginManager 改 records Map + persist() → installed.json
          (install 额外物化到 plugins/managed/<id>/)
```

- 读路径（`listPlugins` / `getPluginInfo`）：wire → `this.plugins.summaries()`
  / `info(id)` → 从 `records` 投影 `PluginSummary` / `PluginInfo` 返回。
- 写路径（`installPlugin` / `setPluginEnabled` /
  `setPluginMcpServerEnabled` / `removePlugin`）：wire →
  `this.plugins.<command>` → 改 `records` + `persist()`。
- 重载路径（`reloadPlugins`）：wire → `this.plugins.reload()` → 从
  `installed.json` 重建整份 `records`，返回 `ReloadSummary`；失败时
  `KimiCore` 把 error 记入 `pluginsLoadError` 并抛 `PLUGIN_LOAD_FAILED`
  （`core-impl.ts:790-803`）。

### 会话启动投影流（KimiCore 内部 → plugin domain → Session）

```text
KimiCore.createSession / resumeSession
  → await this.pluginsReady
  → this.plugins.enabledSessionStarts()      (core-impl.ts:253 / 367)
     → EnabledPluginSessionStart[]  (pluginId + skillName)
     → 注入 Session 的 session-start skill
  → this.mergePluginMcpConfig(callerMcp)
     → this.plugins.enabledMcpServers()      (core-impl.ts:872)
        → Record<runtimeName, McpServerConfig>  (经 withPluginMcpRuntime 注入 env)
     → merge 进 SessionMcpConfig → MCP 连接
  → (skill discovery 路径) this.plugins.pluginSkillRoots()
     → SkillRoot[] → skill discovery
```

这条流**完全在 runtime 内部**——`KimiCore`（runtime）直接消费
`IPluginService`（runtime）的 projection，不经 `services/`、不经 RPC、不
经 daemon。这正是 plugin domain 必须留在 runtime 的根本原因。

## 关键场景

### S1：安装插件（local-path）

1. daemon / SDK → `KimiCore.installPlugin({ source: '/abs/path' })`。
2. wire：`await pluginsReady` + `assertPluginsLoaded`。
3. `this.plugins.install(source)`：`resolveInstallSource` → `local-path` →
   `normalizeInstallRoot`（必须绝对路径 + 存在 + 是目录）→ `parseManifest`
   → `copyPluginToManagedRoot`（物化到 `plugins/managed/<id>/`）→
   `recordFrom` → `records.set(id, record)` → `persist()`。
4. wire 从 `this.plugins.summaries()` 找到对应 `PluginSummary` 返回。

### S2：启用 / 禁用插件

1. daemon / SDK → `KimiCore.setPluginEnabled({ id, enabled })`。
2. wire → `this.plugins.setEnabled(id, enabled)`：id 规范化 → 校验存在 →
   若状态变化则更新 record（`enabled` + `updatedAt`）+ `persist()`。
3. 下一次 session 启动时，`enabledSessionStarts()` / `enabledMcpServers()`
   会跳过被禁用的插件。

### S3：启用 / 禁用某个插件的 MCP server

1. daemon / SDK → `KimiCore.setPluginMcpServerEnabled({ id, server, enabled })`。
2. wire → `this.plugins.setMcpServerEnabled(id, server, enabled)`：校验插件
   存在 + 清单声明了该 MCP server → 更新 `record.capabilities.mcpServers[server]`
   + `persist()`。
3. 下一次 session 启动时，`enabledMcpServers()` 会据此过滤。

### S4：会话启动时注入插件 skill / MCP / session-start

1. `KimiCore.createSession` / `resumeSession`：`await pluginsReady`。
2. `this.plugins.enabledSessionStarts()` → 启用且 `state === 'ok'` 且声明了
   `manifest.sessionStart.skill` 的插件 → `EnabledPluginSessionStart[]` →
   session 启动时加载对应 skill。
3. `this.plugins.enabledMcpServers()` → 启用且 `state === 'ok'` 的插件声明
   的 MCP server（经 `isMcpServerEnabled` 过滤 + `withPluginMcpRuntime` 注入
   `KIMI_CODE_HOME` / `KIMI_PLUGIN_ROOT` env + native-binary `node`
   fallback 重写）→ merge 进 `SessionMcpConfig`。
4. skill discovery 路径：`this.plugins.pluginSkillRoots()` → 启用插件声明
   的 skill 目录 → 喂给 `discoverSkills`。

### S5：重载插件（恢复路径）

1. daemon / SDK → `KimiCore.reloadPlugins({})`。
2. wire **不**调 `assertPluginsLoaded`（reload 本身就是从磁盘恢复的路径）。
3. `this.plugins.reload()`：从 `installed.json` 重建 `records`，逐个
   `materialize`，失败项记入 `ReloadSummary.errors`，返回 `{ added, removed,
   errors }`。
4. wire：成功则清 `pluginsLoadError`；失败则记入 `pluginsLoadError` 并抛
   `KimiError(PLUGIN_LOAD_FAILED)`。

### S6：插件加载失败时的降级

1. `KimiCore` 构造：`this.pluginsReady = this.plugins.load().catch(e =>
   this.pluginsLoadError = e)`（`core-impl.ts:210-212`）——**捕获而非吞
   掉**错误。
2. mutator / 显式 `/plugins` 读（`installPlugin` / `listPlugins` /
   `setPluginEnabled` / `setPluginMcpServerEnabled` / `removePlugin` /
   `getPluginInfo`）调 `assertPluginsLoaded()` → 抛 `PLUGIN_LOAD_FAILED`，
   让用户看到问题。
3. `createSession` / `resumeSession` `await pluginsReady` 后直接读投影
   （不 assert）→ 静默降级（无 plugin skill、无 session-start 注入），保证
   harness 仍能启动。`reloadPlugins` 成功后清 `pluginsLoadError`。

## 派生交互映射

| 对外动作 | CoreAPI wire 方法 | plugin domain 方法 | 真相 / 副作用 |
|---|---|---|---|
| 安装插件 | `installPlugin` (`:755`) | `PluginManager.install` (`manager.ts:60`) | 物化文件到 `plugins/managed/<id>/` + 改 `records` + `persist()` |
| 列出插件 | `listPlugins` (`:762`) | `PluginManager.summaries` (`manager.ts:243`) | 只读 `records` → `PluginSummary[]` |
| 启用 / 禁用插件 | `setPluginEnabled` (`:768`) | `PluginManager.setEnabled` (`manager.ts:140`) | 改 `records` + `persist()` |
| 启用 / 禁用插件 MCP server | `setPluginMcpServerEnabled` (`:774`) | `PluginManager.setMcpServerEnabled` (`manager.ts:150`) | 改 `records.capabilities` + `persist()` |
| 卸载插件 | `removePlugin` (`:784`) | `PluginManager.remove` (`manager.ts:173`) | 改 `records` + `persist()` |
| 重载插件 | `reloadPlugins` (`:790`) | `PluginManager.reload` (`manager.ts:181`) | 从 `installed.json` 重建 `records`；失败抛 `PLUGIN_LOAD_FAILED` |
| 查询插件详情 | `getPluginInfo` (`:805`) | `PluginManager.info` (`manager.ts:247`) | 只读 `records` → `PluginInfo`；未找到抛 `PLUGIN_NOT_FOUND` |
| （内部）会话启动注入 | — | `PluginManager.enabledSessionStarts` (`manager.ts:216`) | 只读 `records` → `EnabledPluginSessionStart[]` |
| （内部）会话启动 MCP | — | `PluginManager.enabledMcpServers` (`manager.ts:227`) | 只读 `records` → `Record<runtimeName, McpServerConfig>` |
| （内部）skill discovery | — | `PluginManager.pluginSkillRoots` (`manager.ts:201`) | 只读 `records` → `SkillRoot[]` |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service，标注实际落点）：

```text
Runtime / Aggregate (in-process, #/plugin = src/plugin/)
  IPluginService / PluginService / PluginManager   (plugin command + query + runtime projection)
  store.ts (installed.json persistence) / manifest.ts / source.ts / github-resolver.ts / archive.ts
  types.ts (PluginRecord / PluginSummary / PluginInfo / ReloadSummary / EnabledPluginSessionStart / PluginMcpServerInfo)

Runtime / CoreAPI wire (in-process, src/rpc/)
  KimiCore.installPlugin / listPlugins / setPluginEnabled / setPluginMcpServerEnabled /
    removePlugin / reloadPlugins / getPluginInfo   (core-impl.ts:755-817 — wire protocol)
  KimiCore.assertPluginsLoaded                     (core-impl.ts:819 — 就绪门控)
  KimiCore (this.plugins field :157, construction :205, ready signal :210-212)
  KimiCore.createSession / resumeSession           (消费 enabledSessionStarts + enabledMcpServers)

Persistence / Truth
  kimiHomeDir/plugins/managed/<id>/                (物化的插件文件)
  kimiHomeDir/.../installed.json                   (注册表索引，store.ts 读写)
  records: Map<id, PluginRecord>                   (进程内注册表，PluginManager 持有)

Transport (above agent-core)
  CoreAPI (JSON-RPC)                               (7 个 plugin 方法经 KimiCore → SDK)
```

依赖关系：

```text
IPluginService.install/setEnabled/setMcpServerEnabled/remove → records Map + store.persist (command → 真相)
IPluginService.reload              → store.readInstalled + materialize + records Map (command → 重建真相)
IPluginService.list/get/summaries/info → records Map                              (query → 只读)
IPluginService.enabledSessionStarts/enabledMcpServers/pluginSkillRoots → records Map (runtime projection → 只读派生)
KimiCore.installPlugin/listPlugins/... → await pluginsReady + assertPluginsLoaded + this.plugins.<method> (wire → plugin)
KimiCore.createSession/resumeSession   → await pluginsReady + this.plugins.enabledSessionStarts/enabledMcpServers (runtime → plugin projection)
store.ts (readInstalled/writeInstalled) → installed.json                          (persistence → 磁盘)
parseManifest / resolveInstallSource / resolveGithubSource / downloadZip / extractZip → 文件 / 网络 (infrastructure)
```

禁止的边界：

```text
#/plugin/**                      → services/**                       (plugin 是 runtime；不得反向 import services/)
rpc/core-impl.ts                 → services/plugin/**                (若 plugin 搬到 services/，core-impl 会违反 M0.1 fence)
services/**                      → (持有 plugin 真相)                (plugin 真相在 #/plugin + kimiHomeDir，不在 services/)
KimiCore (wire)                  → (在 wire 里实现 plugin 业务规则)   (业务逻辑在 PluginManager；wire 只门控 + 委托 + 错误码映射)
PluginManager (command)          → enabledSessionStarts/enabledMcpServers/pluginSkillRoots 业务方法 (command 不调 projection 业务方法；共享 records 协作)
PluginManager (projection)       → install/setEnabled/remove          (projection 不回调 command)
getPluginInfo (wire)             → (未找到时返回 undefined)           (wire 必须把 “未找到” 映射成 PLUGIN_NOT_FOUND)
reloadPlugins (wire)             → (失败时静默吞错)                   (wire 必须把失败映射成 PLUGIN_LOAD_FAILED + 记 pluginsLoadError)
```

关键不变量：

- plugin domain **物理隔离在 `#/plugin`（`src/plugin/`）**，与
  `src/session/` / `src/skill/` / `src/agent/` 同级，是 runtime 模块。
  `src/services/` 下**没有** `plugin/` 目录（已确认）。
- `KimiCore` 经 `#/plugin`（bare package subpath）import
  `PluginService` / `IPluginService`（`core-impl.ts:6`）——这是 runtime
  内部同级模块互引，**不**经过 `services/`，依赖方向合法。
- plugin 的真相是 `kimiHomeDir` 下的插件文件 + `installed.json` + 进程内
  `records` Map，三者同源；`services/` 不持有 plugin 真相。
- `KimiCore` 上的 7 个 plugin 方法是 wire protocol：就绪门控（
  `await pluginsReady` + `assertPluginsLoaded`）+ 委托 `this.plugins` +
  错误码映射（`PLUGIN_LOAD_FAILED` / `PLUGIN_NOT_FOUND`）。它们**不**实现
  plugin 业务规则。
- command / query / runtime projection 共用 `records` Map，但业务方法互不
  调用，符合 “角色不互相调用业务方法”。
- `reloadPlugins` 是恢复路径，**不**调 `assertPluginsLoaded`；其余 6 个
  wire 方法都 `await pluginsReady` + `assertPluginsLoaded`（mutator / 显式
  读把加载错误暴露给用户；`createSession` / `resumeSession` 静默降级）。
- M0.1 fence（`dependency-direction.test.ts`）的 `RUNTIME_DIRS` 包含 `rpc`
  （`:24`）：任何 `rpc/**` → `src/services` 的 import 都会被拦截（
  `:64-74`）。这把 “plugin 不能进 `services/`” 变成了可执行的硬约束。

## 决策记录

- **DR1：plugin 是一个独立 domain，留在 `#/plugin`（runtime），不进
  `services/`。** plugin domain 拥有自己的真相（`kimiHomeDir` 插件文件 +
  `installed.json` + `records` Map）、生命周期（install / enable / disable
  / remove / reload）、读模型（list / get / summaries / info）与 runtime
  投影（skill roots / session-starts / MCP servers）。它被 `KimiCore`
  （runtime，`rpc/core-impl.ts`）**直接消费**——`this.plugins` 字段（
  `core-impl.ts:157`）、构造（`core-impl.ts:205`）、session 启动投影调用
  （`core-impl.ts:253, 367, 872`）。按 service-skill M1.1 规则
  （runtime-consumed domain 留在 runtime），plugin **必须**留在
  `#/plugin`。搬到 `services/plugin/` 会强制 `rpc/core-impl.ts` →
  `services/` 的反向 import，违反 M0.1 fence（
  `dependency-direction.test.ts:24` 扫描 `rpc`）。
- **DR2：plugin 是 command + query + runtime projection 三角色聚合，共用
  同一份 `records` Map。** `install` / `setEnabled` / `setMcpServerEnabled`
  / `remove` / `reload` = command（注册表写入 + `persist()`）；`list` /
  `get` / `summaries` / `info` = query（只读 `PluginRecord` 投影）；
  `pluginSkillRoots` / `enabledSessionStarts` / `enabledMcpServers` =
  runtime projection（被 core runtime 消费的派生读模型）。三者业务方法互不
  调用，经共享 `records` 协作。
- **DR3：`KimiCore` 上的 7 个 plugin 方法是 wire protocol，留在
  `KimiCore`。** 它们（`core-impl.ts:755-817`）不是 plugin 业务逻辑，而是
  CoreAPI wire 表面：就绪门控（`await pluginsReady` +
  `assertPluginsLoaded`）+ 委托 `this.plugins` + 错误码映射（reload →
  `PLUGIN_LOAD_FAILED`，info 未找到 → `PLUGIN_NOT_FOUND`）。错误码是
  CoreAPI 协议语义，由 wire 层拥有；业务规则全在 `PluginManager`。
- **DR4：`reloadPlugins` 不调 `assertPluginsLoaded` 不构成 muddle。**
  reload 是**恢复路径**——它从 `installed.json` 重建 `records`，本身就是在
  加载失败时重新尝试的入口。其余 6 个 wire 方法（mutator / 显式读）调
  `assertPluginsLoaded` 把加载错误暴露给用户；`createSession` /
  `resumeSession` `await pluginsReady` 后直接读投影以静默降级。三层语义各
  就其位，不需要统一。
- **DR5：不为 plugin 拆 `IPluginCommandService` / `IPluginQueryService` /
  `IPluginRuntimeService`。** plugin 的 command / query / runtime
  projection 已按方法语义在同一份 `records` Map 上清晰分层，业务方法互不
  调用。再抽三层接口只是把同一份 `records` Map 拆成三份同名复制 + 管道复
  制，不带来新契约。projection 是 `IPluginService` 上的方法（留在
  runtime），不是独立的 `IPluginRuntimeService` facade（无 per-id 活状态
  订阅、无事件流投递）。
- **DR6：不把 `KimiCore` 的 7 个 wire 方法下沉到 plugin domain。** 把
  wire 方法搬进 `PluginManager` 会把 CoreAPI 协议错误码（
  `PLUGIN_LOAD_FAILED` / `PLUGIN_NOT_FOUND`）和就绪门控（
  `pluginsReady` / `assertPluginsLoaded`）带进 plugin domain，污染聚合
  的业务纯净性。wire 表面属于 `KimiCore`（CoreAPI 实现体），plugin domain
  只负责业务。
- **DR7：不需要改名。** `plugin` / `IPluginService` / `PluginService` /
  `PluginManager` 的命名已精确反映其职责（plugin = 插件生命周期 + 注册表
  + 会话启动投影）。`PluginManager`（业务 owner）+ `PluginService`（DI
  facade + `_serviceBrand` + `unwrap` 迁移桥）的分层与 service-skill 对
  “manager + service” 形状的容忍一致。
- **DR8：不需要移动、拆分或抽取。** plugin domain 已物理隔离在 `#/plugin`
  （runtime），`KimiCore` 的 7 个 wire 方法已正确留在 `KimiCore`，
  `services/` 下无 `plugin/` 目录，无 god 残留（plugin 不知道 config /
  session / mcp 等其他 domain，只被它们在 session 启动时消费投影），M0.1
  fence 干净。M4.9 结论：**保持现状**，仅在本概念定稿中固化边界——这是
  一次**边界确认 + 概念定稿**，不是代码抽取。
