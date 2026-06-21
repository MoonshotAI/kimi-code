# Task Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

> 范围说明：ROADMAP M4.6 把 `task` / `background` / `cron` / `goal` 放在同一个
> step 里确认边界。它们名字都带 “task”，但**不是同一个 domain**——本文先
> 把它们拆清楚，再分别确认 query / command / runtime / 持久化各自落在哪
> 一层。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一的 task 生命周期流](#统一的-task-生命周期流)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里，标题里的 “task” 实际上是**三个独立的 aggregate**，共享同一个
“后台/异步工作单元”的直觉，但真相、生命周期、副作用、对外入口都不同：

- **background task aggregate（后台任务）**：由 agent 进程内启动、可查询 / 取消
  的异步任务（bash / subagent / question）。
  - **query + command（facade）**：`services/task/` 的 `ITaskService`——
    `list` / `get`（只读查询 + 协议形状适配）+ `cancel`（取消命令）。这是
    background task aggregate 对 daemon / SDK 的**唯一 facade**。
  - **runtime（运行时）**：`agent/background/` 的 `BackgroundManager`——注册 /
    启动 / 停止 / 输出捕获 / 持久化 / 重启 reconcile。它持有活的 `ManagedTask`
    状态，是 background task aggregate 的**运行时真相**。
  - **persistence（持久化）**：`agent/background/persist.ts` 的
    `BackgroundTaskPersistence`——`<sessionDir>/tasks/<id>.json` +
    `output.log`，被 runtime 直接消费，不是顶层 `*Service`。
- **cron aggregate（定时任务）**：按 cron 表达式周期 / 一次性触发的调度任务。
  - **runtime**：`agent/cron/` 的 `CronManager`——`SessionCronStore` + 调度器
    tick 循环 + fire 处理（`steer` + telemetry）+ 持久化 + start/stop。
  - **store / scheduler / persist**：`tools/cron/`（`session-store.ts` /
    `scheduler.ts` / `persist.ts` / `clock.ts`）——被 runtime 包装的下层
    contract，不是 `services/` facade。
  - **query / command**：cron **没有 `services/` facade**。它的“写”（create /
    delete）由模型工具 `tools/cron/cron-create.ts` / `cron-delete.ts` 触发；
    它的“读”（list / next-fire）由 `CronList` 工具 + `CronManager.getNextFireTime`
    提供。入口在 **tool / slash 层**，不在 daemon/SDK `services/` 层。
- **goal aggregate（目标模式）**：每个 agent 至多一个的“持续目标”，由记录日志
  重建，驱动 continuation turn。
  - **runtime**：`agent/goal/` 的 `GoalMode`——durable 状态机（active / paused /
    blocked / complete）+ 生命周期（create / pause / resume / cancel /
    markBlocked / markComplete）+ 预算记账。
  - **truth（真相）**：agent 记录日志（`goal.create` / `goal.update` /
    `goal.clear` / `forked`），经 `restoreCreate` / `restoreUpdate` /
    `restoreClear` / `restoreForked` 重建；持久化经 `IRecordsService.logRecord`。
    真相在 records / replay 层，不在 `GoalMode` 内存里。
  - **query / command**：goal **没有 `services/` facade**。命令经 CoreAPI
    （`rpc-controller.ts` 的 `createGoal` / `getGoal` / `pauseGoal` /
    `resumeGoal` / `cancelGoal`）+ 模型工具 `UpdateGoal` + `/goal` slash 触发；
    查询经 CoreAPI `getGoal` + 工具提供。

**三者不是同一个 domain，也不需要进一步拆分。** 边界当前就是干净的：

- `services/task`（facade）只做**只读查询 + 取消命令 + 协议形状适配**，不持有
  运行时状态、不注册 / 停止任务、不直接读 `BackgroundManager` 的 `tasks` map。
  它经 `coreApi()`（in-process CoreAPI）派发到 runtime，对 runtime 的直接
  import 只有 `import type { BackgroundTaskInfo }`（type-only）。
- `agent/background`（runtime）只做**后台任务运行时**，不表达 SDK 的
  `BackgroundTask` 形状、不做 snake_case / ISO 适配、不解析 session 存在性。
- `agent/cron` + `tools/cron`（runtime + store / scheduler）只做**定时调度**，
  不暴露 daemon/SDK `services/` 形状；入口在 tool / slash。
- `agent/goal`（runtime）+ records / replay（truth）只做**目标模式**，不暴露
  `services/` facade；入口在 CoreAPI / 工具 / slash。

**关系一句话：background task 是一个 aggregate，`services/task` 是它的
daemon/SDK facade、`agent/background` 是它的 runtime、`agent/background/persist`
是它的持久化；cron 与 goal 是另外两个 aggregate，二者都是 runtime-only（无
`services/` facade），分别由 tool / slash 与 CoreAPI / 工具 / slash 驱动。三者
共享 “异步工作单元” 的直觉但不共享真相、不共享生命周期、不应合并。**

接口 / 实现落点见 `services/task/task.ts` 的 `ITaskService`（daemon/SDK query +
command facade）、`services/task/taskService.ts` 的 `TaskService`（facade 实现）、
`agent/background/index.ts` 的 `BackgroundManager` / `IBackgroundService`
（background runtime）、`agent/background/persist.ts` 的 `BackgroundTaskPersistence`
（持久化 contract）、`agent/cron/manager.ts` 的 `CronManager` / `ICronService`
（cron runtime）、`tools/cron/`（cron store / scheduler / persist）、
`agent/goal/index.ts` 的 `GoalMode` / `IGoalService`（goal runtime）、
`agent/factory.ts`（三者的 per-agent DI 注册）、`agent/rpc-controller.ts`
（goal 的 CoreAPI 暴露）。本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. “task” 这个词指代三个不同的 aggregate，不是单一 domain

“task” 在代码里同时指三件生命周期 / 真相 / 副作用完全不同的事：

- **background task（后台任务）**：agent 进程内启动的异步子任务（bash 命令、
  subagent、question 工具派生的 flow）。真相是 runtime 内存里的 `ManagedTask`
  map + 磁盘 `<sessionDir>/tasks/<id>.json` + `output.log`。生命周期由
  `BackgroundManager` 拥有（register → run → settle / stop → persist → reconcile）。
- **cron job（定时任务）**：按 cron 表达式触发的调度条目。真相是
  `SessionCronStore`（内存）+ `<sessionDir>/cron/<id>.json`（磁盘镜像）。
  生命周期由 `CronManager` 拥有（add → scheduler tick → fire → steer → 持久化
  cursor / remove）。
- **goal（目标）**：每个 agent 至多一个的持续目标，驱动 continuation turn。
  真相是 agent 记录日志（event-sourced），`GoalMode` 内存状态是从 records 重建
  的投影。生命周期由 `GoalMode` 拥有（create → pause / resume → complete /
  cancel / blocked）。

因此它们不是 “一个 task domain 的三个角色”，而是**三个 aggregate**。把它们
合并成一个 domain 会混淆三种完全不同的真相与生命周期；把它们各自拆成
command / query / runtime 子 service 也没有新契约可拆（见 DR 系列）。

### 2. `services/task` 是 background-task aggregate 的 SDK facade，不是独立 aggregate

`ITaskService`（`services/task/task.ts:142`）的三个方法——`list` / `get` /
`cancel`——全部围绕 background task：

- 数据来自 `coreApi().getBackground({sessionId, agentId})`（即 in-process
  `BackgroundManager.list` 的 RPC 投影），不是独立的 task store。
- `cancel` 经 `coreApi().stopBackground(...)` 派发到 in-process
  `BackgroundManager.stop`。
- `toProtocolTask`（`task.ts:103`）把 runtime 的 `BackgroundTaskInfo`
  （camelCase + ms 时间戳 + agent-core literal 集）适配成协议
  `BackgroundTask`（snake_case + ISO + spec literal 集）。

所以 `services/task` 不是 “第四个 aggregate”，它是 **background-task
aggregate 在 daemon / SDK 边界的 query + command facade**——和
`services/skill` 是 skill aggregate 的 facade、`agent/skill` 是其 runtime 是
同一模式（见 `skill.md`）。区别在于：skill facade 背后有 `SessionSkillRegistry`
这个独立 truth；background task 的 truth 直接住在 runtime 的 `ManagedTask`
map + 磁盘 persist 里，没有独立 registry 层。

### 3. 命令 / 查询 / 运行时 / 持久化 各就其位（按 aggregate 列角色）

按 service-skill 的角色表，三个 aggregate 实际用到的角色如下：

| Aggregate | Query | Command | Runtime | Persistence / Truth |
|---|---|---|---|---|
| background task | `ITaskService.list` / `get`（facade） | `ITaskService.cancel`（facade） | `BackgroundManager`（`agent/background`） | `BackgroundTaskPersistence`（runtime 持有，磁盘 mirror） |
| cron | `CronList` 工具 / `getNextFireTime`（tool 层） | `CronCreate` / `CronDelete` 工具（tool 层） | `CronManager`（`agent/cron`）+ `CronScheduler`（`tools/cron`） | `SessionCronStore` + `createCronPersistStore`（`tools/cron`） |
| goal | `getGoal` CoreAPI / 工具 | CoreAPI（create/pause/resume/cancel）+ `UpdateGoal` 工具 + `/goal` slash | `GoalMode`（`agent/goal`） | agent 记录日志（`IRecordsService` / `IReplayService`） |

按 [Domain decomposition](../../../../../packages/agent-core/src/services/AGENTS.md)
的规范：“不是每个 domain 都需要五件套，仅当某角色有明确 owner 且契约非空时才
引入”。

- **background task 的 query / command 已经是单 facade。** `ITaskService`
  只有 `list` / `get`（读）+ `cancel`（写）三个方法，scope 固定为单 session，
  无分页 / search / count（`TaskListQuery` 只有一个可选 `status`）。它**就是**
  background task aggregate 在 SDK 边界的 query + command 角色。再拆
  `ITaskQueryService` / `ITaskCommandService` 不会引入新契约，只是把同一个
  薄适配器上的方法换个接口名，并被迫复制 `_requireSession` / `_getAllRaw` /
  `coreApi()` 派发管道。
- **background task 的 runtime 是 `BackgroundManager`，不是 facade。**
  `BackgroundManager` 持有活的 `ManagedTask` map，拥有注册 / 启动 / 停止 /
  输出捕获 / 持久化 / reconcile；它从不暴露在 SDK 边界，facade 只经 CoreAPI
  读它的投影。这是 [`runtime-service.md`](../../reference/patterns/runtime-service.md)
  描述的“由进程内对象推导的活状态”的 owner。
- **background task 的 persistence 是 runtime 持有的 contract，不是顶层
  service。** `BackgroundTaskPersistence` 由 `BackgroundManager` 在构造时注入
  （`agent/factory.ts:51` 的 `backgroundPersistence`），由 runtime 直接调
  `writeTask` / `appendTaskOutput` / `listTasks`。按 AGENTS.md “被 runtime
  aggregate 直接消费的 repository 住在 runtime 层”，它住在 `agent/background/`
  而不是 `services/`，也不是 `*Service` DI 单例。
- **cron / goal 没有 `services/` facade，是 runtime-only aggregate。** 它们
  的 query / command 入口在 tool / slash / CoreAPI 层，不在 daemon/SDK
  `services/` 层。这不是缺失，而是它们本来就没有 REST/SDK 形状需要适配——
  cron 的 create / delete / list 是模型工具，`/cron` 是 slash；goal 的
  create / pause / resume / cancel 是 CoreAPI + `UpdateGoal` 工具 + `/goal`
  slash。

### 4. `services/task` 的 query + command 共用 `ITaskService` 不构成 muddle

`list` / `get`（query）与 `cancel`（command）共用一个 `ITaskService` 接口，
但这是同一个薄 SDK 适配器上的三个独立方法：

- 实现互不调用：`TaskService.list`（`taskService.ts:41`）/ `get`（`:51`）/
  `cancel`（`:84`）各自经 `_getAllRaw`（`:115`）取 runtime 投影，互不调用
  对方的业务方法。
- 共享的只是“session 存在性校验 + CoreAPI 派发”这条管道：`_requireSession`
  （`:108`）/ `coreApi()`（`:137`）。这条管道是 SDK 适配器的基础设施，不是
  query 或 command 的业务逻辑。
- AGENTS.md 的 “command / query 角色不互相调用业务方法” 针对的是**实现耦合**，
  不是**接口同址**。`ITaskService` 的三个方法满足这条规则。

真正的角色分离（query+command facade vs runtime impl vs persistence
contract）已经按文件 / 层物理分离，没有重叠或渗漏（见 DR7）。

### 5. cron / goal 是 tool / slash / CoreAPI 驱动的 runtime-only aggregate

cron 与 goal 都没有 `services/<domain>/` facade，这不是遗漏：

- **cron**：`CronManager`（`agent/cron/manager.ts:97`）包装 `tools/cron/` 的
  `SessionCronStore` + `CronScheduler`。create / delete 由模型工具
  `tools/cron/cron-create.ts` / `cron-delete.ts` 调 `manager.addTask` /
  `removeTasks`；list / next-fire 由 `CronList` 工具读 store +
  `manager.getNextFireTime`；`/cron` slash 也走工具层。daemon/SDK 没有 cron
  的 REST 端点，`rpc-controller.ts` 也不暴露 cron。
- **goal**：`GoalMode`（`agent/goal/index.ts:223`）是 durable 状态机。命令经
  CoreAPI（`agent/rpc-controller.ts:170-174` 的 `createGoal` / `getGoal` /
  `pauseGoal` / `resumeGoal` / `cancelGoal`）+ 模型工具 `UpdateGoal`（触发
  `markComplete` / `markBlocked`）+ `/goal` slash；查询经 CoreAPI `getGoal`
  + 工具。同样没有 `services/goal/` facade。

把 cron / goal 包一层 `services/` facade 不会带来新契约——它们没有需要适配
成协议形状的 SDK 读模型，也没有 daemon 直接消费的命令入口。它们的对外入口
已经落在 tool / slash / CoreAPI，且这些入口直接消费 per-agent runtime
（`ICronService` / `IGoalService`），不需要再经一层 `services/` 适配。

### 6. facade 不直接 import runtime impl；经 CoreAPI 单向连接（type-only 例外）

`services/task` 对 `agent/background` 的唯一引用是 type-only：

```ts
// services/task/task.ts:42
import type { BackgroundTaskInfo } from '../../agent/background';
```

运行时数据全部经 CoreAPI 流动：

- `list` / `get`：`coreApi().getBackground({sessionId, agentId, activeOnly, limit})`
  → in-process `BackgroundManager.list`（`taskService.ts:115-127`）。
- `cancel`：`coreApi().stopBackground({sessionId, agentId, taskId, reason})`
  → in-process `BackgroundManager.stop`（`taskService.ts:98-103`）。
- `get(withOutput)`：`coreApi().getBackgroundOutput({sessionId, agentId, taskId, tail})`
  → in-process `BackgroundManager.readOutput`（`taskService.ts:67-72`）。

所以 facade 不持有 runtime 的活状态、不调 runtime 的方法、不 import runtime
的实现类；它只借用 `BackgroundTaskInfo` 这个**类型**来做协议形状适配。这条
边界是“是否需要拆分 / 合并”的硬指标：只要 facade 不混入 runtime 状态、
runtime 不混入 SDK 形状，两类关注点就是清晰的。

## Service 拆分概览

| Service / 角色 | 一句话职责 | 角色 | Aggregate |
|---|---|---|---|
| `ITaskService` | daemon/SDK background task facade：`list` / `get`（query）+ `cancel`（command） | query + command（facade） | background task |
| `TaskService` | `ITaskService` 实现：session 解析 + `toProtocolTask` 适配 + `coreApi()` 派发 + 错误码翻译 | query + command（impl） | background task |
| `IBackgroundService` / `BackgroundService` | `BackgroundManager` 的 per-agent DI 桥（`unwrap()` 取裸 manager） | runtime（DI 桥） | background task |
| `BackgroundManager` | background task 运行时：register / start / stop / settle / output / persist / reconcile | runtime（impl） | background task |
| `BackgroundTaskPersistence` | background task 持久化：`<sessionDir>/tasks/<id>.json` + `output.log` | persistence（runtime 持有） | background task |
| `BackgroundTask`（task.ts） | 具体任务抽象（`AgentBackgroundTask` / `ProcessBackgroundTask` / `QuestionBackgroundTask`） | runtime（任务实现） | background task |
| `ICronService` / `CronService` | `CronManager` 的 per-agent DI 桥 | runtime（DI 桥） | cron |
| `CronManager` | cron 运行时：store + scheduler + fire（steer + telemetry）+ persist + start/stop | runtime（impl） | cron |
| `SessionCronStore` | cron 内存真相：add / remove / list / adopt / markFired | store / truth（runtime 持有） | cron |
| `CronScheduler`（`tools/cron/scheduler.ts`） | cron tick 循环 + jitter + fire 回调 | scheduler（runtime 持有） | cron |
| `createCronPersistStore`（`tools/cron/persist.ts`） | cron 磁盘镜像：`<sessionDir>/cron/<id>.json` | persistence（runtime 持有） | cron |
| `CronCreate` / `CronDelete` / `CronList`（`tools/cron/cron-*.ts`） | cron 的模型工具入口（create / delete / list） | query + command（tool 层） | cron |
| `IGoalService` / `GoalService` | `GoalMode` 的 per-agent DI 桥 | runtime（DI 桥） | goal |
| `GoalMode` | goal 运行时：durable 状态机 + 生命周期 + 预算记账 | runtime（impl） | goal |
| `IRecordsService` / `IReplayService` | goal 的真相层：记录日志 + 重建投影 | truth（records / replay） | goal |
| `UpdateGoal` 工具 + `/goal` slash + `rpc-controller` goal CoreAPI | goal 的命令入口（tool / slash / CoreAPI 层） | command（tool / slash / CoreAPI 层） | goal |

> 只有这些角色。**不引入 `ITaskQueryService` / `TaskQueryService` 或
> `ITaskCommandService` / `TaskCommandService`**——`ITaskService` 的
> `list` / `get` / `cancel` 已经是单 facade 上的三个独立方法，再拆一层只是
> 同名复制 + 管道复制。
> **不为 cron / goal 引入 `services/cron` / `services/goal` facade**——它们
> 没有需要适配成协议形状的 SDK 读模型，对外入口已经在 tool / slash / CoreAPI
> 层，且直接消费 per-agent runtime，再加一层 `services/` 适配不带来新契约。
> **不引入独立的 background task registry**——background task 的真相直接住在
> `BackgroundManager` 的 `ManagedTask` map + `BackgroundTaskPersistence` 磁盘
> mirror 里，没有 skill 那种“跨层共享的 registry truth”；facade 经 CoreAPI
> 读 runtime 投影即可。
> 共享类型（`BackgroundTask` / `BackgroundTaskInfo` / `BackgroundTaskStatus` /
> `CronTask` / `GoalSnapshot` / `GoalStatus` 等）见 `@moonshot-ai/protocol`、
> `agent/background/task.ts`、`tools/cron/types.ts`、`agent/goal/index.ts`。

模式参考：

- query 侧对齐 [`query-service.md`](../../reference/patterns/query-service.md)
  的**只读 list / get 语义**：`ITaskService.list` / `get` 是 background task
  aggregate 的读模型入口；但 scope 固定为单 session、`TaskListQuery` 只有一个
  可选 `status`、无分页 / search / count，所以**不套用**完整的 `BaseQuery` +
  scope 便捷方法骨架。`ITaskService` 已把 query 角色的契约（单 scope list /
  get + 协议形状适配）一次性实现完，无需再拆。
- command 侧对齐 [`command-service.md`](../../reference/patterns/command-service.md)
  的**唯一写入入口**语义：`ITaskService.cancel` 是 background task aggregate
  对 daemon / SDK 的唯一命令入口；但它没有 create / update / archive / fork
  等生命周期族（任务 create 发生在 runtime 的 `registerTask`，由工具层触发，
  不经过 SDK facade），所以**不套用**完整的 `ICommandService` 骨架。`cancel`
  是一个动作命令，不是 “创建 / 修改 aggregate”。
- runtime 侧对齐 [`runtime-service.md`](../../reference/patterns/runtime-service.md)
  描述的“由进程内对象 / 事件流推导的活状态”的 owner：`BackgroundManager` /
  `CronManager` / `GoalMode` 各自持有自己 aggregate 的活状态，并由事件 /
  telemetry / 记录日志向外投影；它们都不是 daemon/SDK facade。

## 统一的 task 生命周期流

### background task 生命周期（runtime）

```text
工具层（Bash run_in_background / Agent subagent / Question）
  └─ BackgroundManager.registerTask(task)            // 生成 taskId，建 ManagedTask
       ├─ assertCanRegister()                        //   maxRunningTasks 闸门
       ├─ task.start({ signal, appendOutput, settle }) // 启动具体任务（process/agent/question）
       ├─ persistLive(entry)                         //   初始快照 → <sessionDir>/tasks/<id>.json
       └─ emitTaskStarted(info)                      //   background.task.started + telemetry
  …（运行中：appendOutput 经 ring buffer + outputWriteQueue → output.log）…
  ├─ 自然结束：settleTask(entry, { status })         // completed / failed / timed_out
  └─ 主动取消：BackgroundManager.stop(taskId)        // SIGTERM → 5s grace → SIGKILL → settleTask('killed')
       └─ fireTerminalEffects(entry)                 // notifyBackgroundTask + background.task.terminated + telemetry

# 重启 reconcile
BackgroundManager.loadFromDisk()                     // 磁盘记录 → ghosts map
  └─ reconcile()                                     // running ghosts → lost；emit terminated；恢复通知
```

要点：

- `BackgroundManager` 是**唯一的 background task 运行时 owner**：所有任务经
  `registerTask` 进入；facade 不自己注册 / 停止任务，只经 CoreAPI 派发。
- `BackgroundTaskPersistence` 是**唯一的持久化 owner**：`<id>.json` 状态 +
  `output.log` 完整输出；ring buffer 只是 UI / 通知的轻量 tail，不是权威输出。
- facade（`ITaskService`）只在 `list` / `get` / `cancel` 时经 CoreAPI 读
  runtime 投影，不直接触达 `tasks` map / persist。

### cron 生命周期（runtime）

```text
CronCreate 工具
  └─ CronManager.addTask(init)                       // store.add + persistEnqueue(write)
       └─ emitScheduled(task)                        // cron_scheduled telemetry

CronManager.start()                                  // scheduler.start() + bindSigusr1（手动 tick）
  └─ scheduler.tick() 周期触发
       └─ onFire(task, ctx) → handleFire(task, ctx)
            ├─ isStale(task)                         // 7 天 auto-expire 判定
            ├─ agent.turn.steer(content, CronJobOrigin) // 注入 cron_job 提醒
            ├─ emitEvent('cron.fired') + telemetry   // cron_fired
            └─ stale && recurring → removeTasks([id]) + emitDeleted(id)

# resume
CronManager.loadFromDisk()                           // <sessionDir>/cron/*.json → store.adopt
```

要点：

- `CronManager` 是**唯一的 cron 运行时 owner**：store / scheduler / persist 都
  由它编排；工具层只调 `addTask` / `removeTasks` / `getNextFireTime`。
- `SessionCronStore` 是内存真相，`createCronPersistStore` 是磁盘 mirror；两者
  都不是顶层 service，由 runtime 持有。
- cron 没有 `services/` facade；对外入口在 tool / slash 层。

### goal 生命周期（runtime + records truth）

```text
/goal create 或模型 UpdateGoal('active')
  └─ GoalMode.createGoal(input)                      // 校验 + persistState + records.logRecord('goal.create')
       └─ track('goal_created')

continuation turn 循环（status === 'active'）
  ├─ incrementTurn() / recordTokenUsage()            // 预算记账 + persistState
  └─ 预算到顶 → markBlocked({ reason })              // blocked（resumable）

用户 / 系统干预
  ├─ pauseGoal / pauseOnInterrupt / pauseActiveGoal  // paused（resumable）
  ├─ resumeGoal                                      // paused/blocked → active
  ├─ cancelGoal                                      // clearInternal（丢弃记录）
  └─ markComplete                                    // complete（transient）→ emit completion → clearInternal

# resume / replay
restoreCreate / restoreUpdate / restoreClear / restoreForked  // 从 records 重建投影
normalizeAfterReplay()                               // active → paused（重启后不能还在跑）
```

要点：

- `GoalMode` 是**唯一的 goal 运行时 owner**：状态机 + 生命周期 + 预算都在它；
  tool / slash / CoreAPI 只调它的方法。
- 真相在 **records 日志**（event-sourced）：`GoalMode` 内存状态是投影，重启经
  `restore*` 重建；`normalizeAfterReplay` 把 `active` 降级为 `paused`。
- goal 没有 `services/` facade；对外入口在 CoreAPI / 工具 / slash 层。

## 关键场景

### 场景 A：列出 session 的后台任务（纯 query）

```ts
taskService.list(sid, { status: 'running' });
```

内部解析：`TaskService.list`（`taskService.ts:41`）→ `_requireSession(sid)`
确认 session 存在 → `_getAllRaw(sid)` 经 `coreApi().getBackground({sid,
agentId:'main'})` 取 runtime 投影 → `toProtocolTask` 适配成协议
`BackgroundTask` → 按 `query.status` 过滤。无 runtime 写入、无任务注册。

### 场景 B：取消一个运行中的后台任务（command）

```ts
taskService.cancel(sid, 'process-abcd1234');
```

内部解析：`TaskService.cancel`（`taskService.ts:84`）→ `_requireSession` →
预取 runtime 投影区分 40406（不存在）/ 40904（已 terminal）→
`coreApi().stopBackground({sid, agentId:'main', taskId})` 派发到 in-process
`BackgroundManager.stop` → runtime 走 SIGTERM → grace → SIGKILL → settleTask。
facade 不自己实现停止逻辑。

### 场景 C：cron 任务到时触发（runtime fire）

```text
CronManager.start() → scheduler.tick()
  → onFire(task) → handleFire(task)
       → agent.turn.steer(cronFireXml, CronJobOrigin)
       → emit 'cron.fired' + cron_fired telemetry
```

内部解析：scheduler 读到 `SessionCronStore` 里到期的 task，调 `handleFire`
（`manager.ts:401`）；`handleFire` 经 `agent.turn.steer` 把 cron 提醒注入
turn，发 `cron.fired` 事件 + `cron_fired` telemetry；若 stale 且 recurring，
再 `removeTasks([id])` + `emitDeleted`。整个过程不经过 `services/` 层。

### 场景 D：goal 从 create 到 complete（runtime + records truth）

```ts
goalMode.createGoal({ objective: '...' });   // records.logRecord('goal.create') + track('goal_created')
// …continuation turns：incrementTurn / recordTokenUsage…
goalMode.markComplete({ reason: 'done' });   // status 'complete' → emit completion → clearInternal
```

内部解析：create 写一条 `goal.create` record 并把内存状态置 `active`；
continuation turn 期间预算记账经 `incrementTurn` / `recordTokenUsage` 更新内存
+ `records.logRecord('goal.update')`；`markComplete` 把状态置 `complete`、发
`goal.updated` completion 事件，再 `clearInternal` 丢弃记录（`complete` 不持久化）。
重启后经 `restoreCreate` / `restoreUpdate` 从 records 重建；`active` 经
`normalizeAfterReplay` 降级为 `paused`。

### 场景 E：daemon 重启后，列出 session 的后台任务（facade + reconcile）

```text
taskService.list(sid)
  → _requireSession(sid)                       // coreApi().listSessions({}) 确认存在
  → coreApi().getBackground({sid})             // in-process BackgroundManager.list
       └─ list(false) 包含 ghosts（lost）      // reconcile 后，磁盘上 running → lost
  → toProtocolTask 适配                         // lost → status failed（lossy）
```

内部解析：重启后 `BackgroundManager.loadFromDisk` + `reconcile` 把磁盘上
`running` 的任务重分类为 `lost`；facade `list` 经 CoreAPI 读到包含 ghost 的
投影，再经 `toProtocolTask`（`mapStatus` 把 `lost` 映射成协议 `failed`）返回。
facade 不知道 reconcile 细节，runtime 不知道协议形状。

### 场景 F：goal resume 后从 records 重建（truth 在 records，不在 runtime）

```text
agent resume
  → GoalMode.restoreCreate(record)             // 从 'goal.create' 重建内存状态
  → GoalMode.restoreUpdate(record) × N         // 回放 'goal.update'
  → GoalMode.normalizeAfterReplay()            // active → paused（重启后不能还在跑）
  → 用户 /goal resume → resumeGoal()           // paused → active，wallClockResumedAt 重置
```

内部解析：goal 的真相是 records 日志；runtime 内存状态只是投影。重启后先经
`restore*` 重建，再经 `normalizeAfterReplay` 把不可能还在跑的 `active` 降级为
`paused`；用户显式 `resumeGoal` 才重新激活。`GoalMode` 不自己持久化真相——它
只经 `records.logRecord` 追加 record。

## 派生交互映射

| 用户交互 | 对应 Service 方法 / 入口 | 角色 | Aggregate |
|---|---|---|---|
| 列出 session 后台任务 | `taskService.list(sid, query)` | query（facade） | background task |
| 取单个后台任务（含输出） | `taskService.get(sid, tid, { withOutput })` | query（facade） | background task |
| 取消后台任务 | `taskService.cancel(sid, tid)` | command（facade） | background task |
| BackgroundTaskInfo → 协议 BackgroundTask | `toProtocolTask(info)` | query（facade，纯函数） | background task |
| 注册后台任务 | `BackgroundManager.registerTask(task)` | runtime（impl） | background task |
| 停止后台任务 | `BackgroundManager.stop(taskId)` / `stopAll()` | runtime（impl） | background task |
| 读后台任务输出 | `BackgroundManager.getOutputSnapshot(taskId, maxBytes)` | runtime（impl） | background task |
| 持久化后台任务 | `BackgroundTaskPersistence.writeTask / appendTaskOutput / listTasks` | persistence（runtime 持有） | background task |
| 重启 reconcile 后台任务 | `BackgroundManager.loadFromDisk()` + `reconcile()` | runtime（impl） | background task |
| 创建 cron 任务 | `CronCreate` 工具 → `CronManager.addTask(init)` | command（tool → runtime） | cron |
| 删除 cron 任务 | `CronDelete` 工具 → `CronManager.removeTasks(ids)` | command（tool → runtime） | cron |
| 列出 cron 任务 | `CronList` 工具 → `SessionCronStore.list()` + `getNextFireTime` | query（tool 层） | cron |
| cron fire | `CronScheduler.tick()` → `CronManager.handleFire(task, ctx)` | runtime（impl） | cron |
| cron 持久化 | `createCronPersistStore`（`<sessionDir>/cron/<id>.json`） | persistence（runtime 持有） | cron |
| 创建 goal | `/goal create` / `UpdateGoal` → `GoalMode.createGoal(input)` | command（slash/tool → runtime） | goal |
| 暂停 / 恢复 goal | `GoalMode.pauseGoal()` / `resumeGoal()` | command（runtime） | goal |
| 取消 goal | `GoalMode.cancelGoal()` | command（runtime） | goal |
| goal 完成 / 阻塞 | `UpdateGoal('complete'/'blocked')` → `markComplete` / `markBlocked` | command（tool → runtime） | goal |
| goal CoreAPI | `rpc-controller` 的 `createGoal` / `getGoal` / `pauseGoal` / `resumeGoal` / `cancelGoal` | query + command（CoreAPI 层） | goal |
| goal 真相（records） | `IRecordsService.logRecord` + `restoreCreate/Update/Clear/Forked` | truth（records / replay） | goal |
| facade 派发（CoreAPI） | `taskService.*` 内 `coreApi().getBackground / stopBackground / getBackgroundOutput` | facade 消费 runtime（单向） | background task |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service (daemon / SDK facade)
  ITaskService                     (background task query + command — list/get 查询 / cancel 命令，
                                    BackgroundTaskInfo → 协议 BackgroundTask)

Runtime (in-process, per-agent)
  BackgroundManager / IBackgroundService   (background task runtime — register/start/stop/output/persist/reconcile)
  CronManager / ICronService               (cron runtime — store + scheduler + fire + persist + start/stop)
  GoalMode / IGoalService                  (goal runtime — durable 状态机 + 生命周期 + 预算)

Runtime-owned contracts (not top-level *Service)
  BackgroundTaskPersistence        (background task 持久化 — <sessionDir>/tasks/<id>.json + output.log)
  SessionCronStore                 (cron 内存真相)
  CronScheduler                    (cron tick 调度器)
  createCronPersistStore           (cron 磁盘镜像 — <sessionDir>/cron/<id>.json)

Domain / Policy
  BackgroundTask / BackgroundTaskInfo / BackgroundTaskStatus   (background task 抽象 + 状态)
  CronTask / CronJobOrigin                                     (cron 任务 + fire origin)
  GoalSnapshot / GoalStatus / GoalChange                       (goal 投影 + 状态 + 变更)

Infrastructure / Truth
  Agent record log (IRecordsService / IReplayService)          (goal 真相：event-sourced)
  SDK adapters (toProtocolTask)                                (BackgroundTaskInfo → 协议 BackgroundTask)
  CoreAPI handle (coreApi())                                   (task facade 经 ICoreRuntime 取 in-process
                                                                 getBackground / stopBackground / getBackgroundOutput)
  Tool / slash layer (CronCreate/CronDelete/CronList, UpdateGoal, /goal, /cron)  (cron / goal 的对外入口)
```

依赖关系：

```text
ITaskService.list/get        → CoreAPI.getBackground          (query facade → in-process runtime 投影，单向)
ITaskService.cancel          → CoreAPI.stopBackground         (command facade → in-process runtime，单向派发)
ITaskService.get(withOutput) → CoreAPI.getBackgroundOutput    (query facade → runtime 输出读取)
ITaskService                 → toProtocolTask                 (协议形状适配)
services/task/task.ts        → agent/background (type only)   (仅 BackgroundTaskInfo 类型，无运行时值)
BackgroundManager            → BackgroundTaskPersistence      (runtime 持有持久化 contract)
BackgroundManager            → Agent.emitEvent / telemetry / turn.steer  (事件 + telemetry + 通知)
CronManager                  → SessionCronStore / CronScheduler / createCronPersistStore  (runtime 持有 store/scheduler/persist)
CronManager                  → Agent.turn.steer / emitEvent / telemetry  (fire 副作用)
GoalMode                     → IRecordsService / IReplayService / IContextService  (truth 在 records/replay)
GoalMode                     → Agent.emitEvent / telemetry    (goal.updated 事件 + telemetry)
agent/factory                → BackgroundService / CronService / GoalService  (per-agent DI 注册)
agent/rpc-controller         → IGoalService                   (goal 的 CoreAPI 暴露)
tools/cron/cron-*            → ICronService                   (cron 的 tool 入口)
```

禁止的边界：

```text
ITaskService                 → BackgroundManager (value import) / registerTask / stop / reconcile  (facade 不直接触达 runtime impl；只能经 CoreAPI)
services/task/**             → agent/background/** (value import)                                (只允许 type-only import)
BackgroundManager            → ITaskService / services/task                                      (runtime impl 不回调 facade)
BackgroundTaskPersistence    → services/**                                                       (持久化 contract 不依赖 daemon facade)
CronManager                  → services/**                                                       (cron runtime 不依赖 daemon facade)
GoalMode                     → services/**                                                       (goal runtime 不依赖 daemon facade)
services/**                  → agent/cron / agent/goal (value import)                            (无 services/cron / services/goal；不允许反向补 facade)
```

关键不变量：

- facade 侧不持有 runtime 状态（无 `ManagedTask` map / `registerTask` /
  `reconcile`）；runtime 侧不持有 SDK 形状（无 `BackgroundTask` / snake_case /
  ISO 适配）。两者唯一的直接引用是 `services/task/task.ts:42` 的
  `import type { BackgroundTaskInfo }`（type-only）。
- background task 的真相在 runtime（`BackgroundManager.tasks`）+ 磁盘
  （`BackgroundTaskPersistence`）；facade 只在 `list` / `get` / `cancel` 时经
  CoreAPI 读 runtime 投影，不自己扫描磁盘、不自己注册 / 停止任务。
- facade 对 runtime 的引用仅限：经 CoreAPI 的 `getBackground` /
  `stopBackground` / `getBackgroundOutput`（in-process 派发，去序列化）；
  `services/task/` 不直接 import `agent/background/` 的实现类或 persist。
- cron 的 store / scheduler / persist 都在 `tools/cron/`，由 `CronManager`
  包装；cron 没有 `services/` facade，对外入口在 tool / slash 层。
- goal 的真相在 records 日志（event-sourced），`GoalMode` 内存状态是投影；
  goal 没有 `services/` facade，对外入口在 CoreAPI / 工具 / slash 层。
- command 副作用（事件 / telemetry / 通知 / steer）集中在各自的 runtime
  （`BackgroundManager.fireTerminalEffects` / `CronManager.handleFire` /
  `GoalMode.persistState`），REST 路由与 facade 不重新解释 runtime 语义。

## 决策记录

- **DR1：“task” 是三个 aggregate，不是一个 domain。** background task（后台
  任务）、cron（定时任务）、goal（目标模式）共享 “异步工作单元” 的直觉，但
  真相（runtime map + 磁盘 / cron store + 磁盘 / records 日志）、生命周期、
  副作用、对外入口都不同。它们不合并成一个 “task domain”，也不互相调用。
- **DR2：`services/task` 是 background-task aggregate 的 SDK facade，不是
  独立 aggregate。** `ITaskService` 的 `list` / `get` / `cancel` 全部围绕
  background task：数据来自 `coreApi().getBackground`（runtime 投影），
  `cancel` 经 `coreApi().stopBackground` 派发到 runtime，`toProtocolTask` 把
  `BackgroundTaskInfo` 适配成协议 `BackgroundTask`。它和 `services/skill` 是
  skill aggregate 的 facade 是同一模式，区别仅在于 background task 的 truth
  直接住在 runtime 里、没有独立 registry 层。
- **DR3：`list` / `get` = query，`cancel` = command（共用 `ITaskService`
  facade）。** `list` / `get` 是只读查询 + 协议形状适配；`cancel` 是取消命令
  （派发 runtime 的 `stop`）。三者 scope 固定为单 session、无分页 / search /
  count（`TaskListQuery` 只有一个可选 `status`）。它们不持有运行时状态、不
  注册 / 停止任务、不写 persist。
- **DR4：`BackgroundManager` = background task runtime。** 它持有活的
  `ManagedTask` map，拥有 register / start / stop / settle / output /
  persist / reconcile；从不暴露在 SDK 边界，facade 只经 CoreAPI 读它的投影。
  它对齐 `runtime-service.md` 描述的“由进程内对象推导的活状态”的 owner。
- **DR5：`BackgroundTaskPersistence` = runtime 持有的持久化 contract，不是
  顶层 service。** 它由 `BackgroundManager` 构造时注入（`agent/factory.ts:51`），
  由 runtime 直接调 `writeTask` / `appendTaskOutput` / `listTasks`；按
  AGENTS.md “被 runtime aggregate 直接消费的 repository 住在 runtime 层”，它
  住在 `agent/background/` 而不是 `services/`，不是 `*Service` DI 单例。
- **DR6：cron / goal 是 runtime-only aggregate，无 `services/` facade。**
  cron 的 create / delete / list 是模型工具（`tools/cron/cron-*.ts`）+ `/cron`
  slash；goal 的 create / pause / resume / cancel 是 CoreAPI
  （`rpc-controller.ts:170-174`）+ `UpdateGoal` 工具 + `/goal` slash。二者都
  没有需要适配成协议形状的 SDK 读模型，对外入口已经在 tool / slash / CoreAPI
  层且直接消费 per-agent runtime。为它们补 `services/cron` / `services/goal`
  facade 不带来新契约，反而复制派发管道。
- **DR7：`list` / `get` 与 `cancel` 共用 `ITaskService` 不构成 muddle。**
  三者是同一个薄 SDK 适配器上的独立方法，实现互不调用（`TaskService.list`
  不调 `cancel`，反之亦然），共享的只是 `_requireSession` / `_getAllRaw` /
  `coreApi()` 这条 session 解析 + CoreAPI 派发管道——这是 SDK 适配器的基础
  设施，不是 query / command 的业务逻辑。AGENTS.md 的 “command / query 角色
  不互相调用业务方法” 针对的是实现耦合，不是接口同址。共用 facade 避免了为
  三个单方法角色各复制一份 session 解析 + CoreAPI 派发管道。真正的角色分离
  （query+command facade vs runtime impl vs persistence contract）已经按文件
  / 层物理分离，没有重叠或渗漏。
- **DR8：不引入独立的 background task registry。** background task 的真相直接
  住在 `BackgroundManager.tasks` + `BackgroundTaskPersistence` 磁盘 mirror 里，
  没有 skill 那种“跨层共享的 registry truth”（`SessionSkillRegistry` 被
  facade / runtime / runtime loading 三方消费）。facade 经 CoreAPI 读 runtime
  投影即可，不需要抽一层 registry contract。
- **DR9：当前代码布局已满足边界，无需迁移。** background task：facade 在
  `services/task/`（`ITaskService` / `TaskService` / `toProtocolTask`，query +
  command），runtime 在 `agent/background/`（`BackgroundManager` /
  `IBackgroundService` / `BackgroundService` + 具体 `BackgroundTask` 实现），
  persistence 在 `agent/background/persist.ts`（`BackgroundTaskPersistence`）。
  cron：runtime 在 `agent/cron/`（`CronManager` / `ICronService` /
  `CronService`），store / scheduler / persist 在 `tools/cron/`，tool 入口在
  `tools/cron/cron-*.ts`。goal：runtime 在 `agent/goal/`（`GoalMode` /
  `IGoalService` / `GoalService`），truth 在 records / replay，CoreAPI 入口在
  `agent/rpc-controller.ts`。三者经 `agent/factory.ts` 注册为 per-agent DI
  （`BackgroundService` / `CronService` / `GoalService`）。依赖方向单向：
  `services/task` → CoreAPI → `agent/background`（type-only 直接 import）；
  `agent/cron` → `tools/cron`；`agent/goal` → records / replay / context；
  `agent/rpc-controller` / `tools/cron/*` → `IGoalService` / `ICronService`。
  三层都没有反向 import `services/task`，M0.1 fence 干净。本次只出概念定稿，
  不做代码拆分。
