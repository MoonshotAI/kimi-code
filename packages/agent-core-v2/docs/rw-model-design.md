# 统一读写模型设计（提案稿）

> 目标：为 agent-core-v2 定义一套**唯一**的读写模型，统一 view、topic、写 operation、
> 订阅方式，消解回环、定义方式不一致、事件可见性混乱等问题。本文基于对
> agent-core-v2 / server-v2 / TUI（apps/kimi-code）三方现状的完整调研，
> 所有断言均有 file:line 证据。
>
> 阅读顺序：§1 问题 → §2 概念模型（核心） → §3–§6 各原语规范 → §7 订阅协议 →
> §8 回环控制 → §9 迁移路径。附录 A 是"现有机制 → 新模型"的逐条映射。
>
> **更新注**：本文档撰写时，`todo.set` / `turn.launch` / `context.splice` 仍是
> agent-core-v2 的 wire record 类型。后续的重构（v1 vocabulary 对齐）已删除这三个
> replay-only / pre-alignment 类型，统一改用 v1 的 `tools.update_store`
> （`key: 'todo'`）、`turn.prompt`、`context.append_message` 等。本文档中涉及这些
> 类型的示例与映射，按上述替换理解。

---

## 0. 硬约束：持久层冻结，只统一接口

本设计**不改变任何落盘产物**：

- `wire.jsonl` 的路径推导（`sha256(agentHomedir)[0:16]`、scope `'wire'`，
  `wireRecordService.ts:66, 359-361`）不变；
- **每 agent 一个物理日志文件**的布局不变；
- `PersistedWireRecord` 的数据结构（record 类型字符串、字段、`metadata`
  信封、`time` 戳）不变，已存在的 18 个域的 record 形状逐字节兼容；
- `protocol_version` / 迁移链（1.0→1.5）机制不变，本设计**不引入新的
  日志格式迁移**；
- fork 的实现（appendLogStore 层过滤复制 + 插入 `metadata`/`forked`）不变；
- server-v2 的 SessionEventJournal（第二本 journal）与 `{seq, epoch}` 线上
  语义不变。

统一发生在**进程内 API 面**：写入口、读模型、订阅、相位、类型注册表。
所有涉及存储布局的进一步收敛（session 单日志、seq 落盘、journal 合一）
移入附录 C 作为远期可选项，不在本期范围。

---

## 1. 现状与问题

### 1.1 现状一句话

核心已经是一个**半成品事件溯源系统**：每个 agent 一条 wire record 追加流
（`wireRecordService.ts`），上面有统一门面 `IAgentRecordService`
（append / signal / define / defineView），但：

- 声明式 view 只迁移了 2 个（contextMemory、contextSize），其余 ~12 个域仍是
  "append 记录 + 手写私有状态 + live/resume 两份 apply + 手动通知"；
- 同一事实最多有 **4 种表达**：wire record（`goal.update`）、AgentEvent signal
  （`goal.updated`）、replay 记录（`goal_updated`）、getter snapshot（`getGoal()`）；
- 事件机制 **6 种并存**：Emitter、OrderedHookSlot、ViewHandle.onChange、
  IEventService（无类型）、AsyncEventQueue、裸回调/Promise；
- 每个会话有 **两本追加日志、两套序号**：agent wire log（核心）+
  SessionEventJournal（server-v2 边缘，`sessionEventBroadcaster.ts:1-25`）。

### 1.2 问题清单（设计必须逐条回答）

**写路径**
- W1 命令实现三风格并存：append+独立 apply（多数域）/ append 即 fold
  （contextMemory）/ append 后复用 resume 函数（turn，`turnService.ts:57-83`）。
- W2 `define` facet 合并语义注释与代码相反（"first writer wins" vs 实际后者覆盖，
  `recordService.ts:139-146`）；dispose 只注销 resumer 不清 facets，与 `defineView`
  的完整清理不对称。
- W3 Session 域借 main agent 的 wire 写（todo/cron），main 缺失时**静默丢写**
  （`sessionTodoService.ts:99-100`），且要 `as never` 绕过类型。
- W4 fork 直接在 appendLogStore 层改写 wire log，绕过全部写模型
  （`sessionLifecycleService.ts:303-337`）。
- W5 restore 期 append 在 wireRecord 层被静默吞掉（`wireRecordService.ts:81`），
  但 recordService 仍然 foldViews、仍然跑 facet——"进内存不进磁盘"完全隐式。

**读路径**
- R1 手写读模型 ~12 处（goal/usage/plan/swarm/permission*/turn/task/todo…），
  live 与 resume 两份 apply 靠人肉保持一致。
- R2 replay 读模型双通道：声明式 `toReplay` + 命令式 `push/patchLast/removeLastMessages`；
  boundary 判定逻辑两处重复（`recordService.ts:55-64` vs `contextMemoryService.ts:137`）。
- R3 `plan.status()` 读模型内嵌文件 IO；`sessionActivity.status()` 纯轮询无事件。
- R4 `messageLegacy` 靠"replay 非空信 replay，否则信 view"的启发式选择读模型
  （`messageLegacyService.ts:100-116`）。
- R5 `captureLiveRecords` 是无人使用的死开关；`IQueryStore` 有契约无实现。

**事件可见性**
- V1 `task.started/terminated` 在 WireRecordMap 和 AgentEvent 双注册，写路径
  append+signal 同名两连发（`taskService.ts:796-807`）；`toLive` facet 全库仅
  permissionMode 一处使用。
- V2 `agent.status.updated` 是"多域共写的散装快照事件"：plan/swarm/usage/
  contextSize/profile 各自手动拼不同字段。
- V3 resume 期 signal 靠 `emitLive` 隐式压制（skill/swarm）——"这个 signal 发不发
  得出去"取决于调用时相位，调用点看不出来。
- V4 `IEventService` payload 无类型、事件名裸字符串、同一事件两处发布者。
- V5 `prompt.submitted` 协议里存在但无人发；`AsyncEmitter/handleVetos` 是死代码。

**回环与相位**
- L1 订阅者回写链真实存在且无统一约束：turn.onEnded→goal 续跑→再 launch turn；
  loop.afterStep→steer flush→splice；onContextOverflow→compaction→splice→
  可能再 overflow（靠显式计数器截断，`fullCompactionService.ts:100-105`）。
- L2 `foldViews` 同步 fire change、无重入保护（`recordService.ts:282-295`）：
  onChange 处理器若 append 会无检测地重入。
- L3 restore 正确性依赖三重隐式契约：DI 构造顺序 + hook 注册顺序 +
  "resumer 先于 hooks"；`doResume` 需手动预热 contextMemory
  （`sessionLifecycleService.ts:158-162`）。
- L4 相位规则（restoring / postRestoring / live）在 append/signal/push/hook
  四条通道上各不相同，没有一处集中定义。

**消费端（server-v2 / TUI）反推的需求**
- C1 server 需要：seq/epoch 水位、durable/volatile 二分、断线 backfill、
  snapshot-at-watermark（`snapshot.ts:1-14`）。这些今天全部在边缘重新发明
  （第二本 journal + InFlightTurnTracker 在边缘重建流式状态）。
- C2 TUI 需要按实体订阅（transcript/toolCall/todo/运行状态/用量/模式/goal/
  后台任务/子 agent/pending interactions），而不是自己从 44 种事件里 join；
  TUI 适配层 ~4000 行，大量"补状态"hack（终态三方对账、入参反推 todo、
  回放逆向工程、/tasks 轮询）。
- C3 TUI 需要"历史回放 = 同一读模型冷启动 + seq 无缝接续"；今天回放与实时是
  两套独立代码，靠时间近似衔接，会丢窗口事件。
- C4 写需要回声（renameSession 客户端自合成事件；v2 路由手发
  `event.session.created` 三遍，`sessions.ts:260,503,619`）；乐观 UI 需要
  确认/失败语义。
- C5 protocol 已定义 durable seq + `VOLATILE_EVENT_TYPES`
  （`protocol/src/events.ts:1475-1503`）但核心与 TUI 均未采用——分类应上移到定义处。
- C6 **冷读必须先完整 resume**：v1 读消息历史触发整套 resume（snapshot p99
  5s+ 的根因）；v2 的 GET 会隐式创建 main agent（`tasks.ts:282`、`tools.ts:218`）
  ——读有副作用，且"句柄不在就没有读模型"。
- C7 session 聚合读模型缺失：`toWireSession` 一半字段是假值
  （status/usage/message_count，`sessions.ts:737-756`）；session status 在
  v1 有三重独立计算。
- C8 **wire 类型双份 + lossy 手写投影**：Goal/Usage/Task/PermissionRule 在
  core 与 protocol 逐字段重复；PermissionRule 无映射代码、wire 恒 `[]`；
  question multi 答案被 `join(',')`；43 个 wire 事件中 8 个在 v2 无发射点。
- C9 in-flight 流式状态在边缘折叠（InFlightTurnTracker），且显式丢弃
  subagent 事件（`inFlightTurnTracker.ts:15-17`）——"每 agent 一条流"与
  "每 session 一个 cursor"的张力未解决。
- C10 pending approval/question 在 v1 是内存悬挂 Promise，掉电即失；v2 收进
  interaction 服务但仍非持久事实。

---

## 2. 概念模型

模型 = **5 个原语 + 1 个流结构 + 1 个相位机**。所有现有机制都映射进来
（附录 A），不在这 5 类里的机制一律淘汰或降级为实现细节。

```
                         ┌────────────────────────────────────────┐
   Command ──commit──▶   │  Stream（session 逻辑流，进程内 seq；      │
  （决策，只在 live）      │  物理仍为 per-agent wire.jsonl，见 §0）   │
                         │  fact | signal 两类条目                  │
                         └──────┬─────────────────┬───────────────┘
                                │ fold（同步）      │ 统一订阅（边缘照旧 journal）
                                ▼                  ▼
                             View 图            订阅者（server/TUI）
                          （纯函数折叠）           snapshot + since(seq)
                                │
                                ▼ onChange（队列化派发）
                             Effect（live-only，只能发 Command）
```

### 2.1 五个原语

| 原语 | 一句话定义 | 回答的问题 | 对应成熟系统 |
|---|---|---|---|
| **Fact** | 已发生的、持久化的、可回放的事实 | "什么改变了状态" | ES 的 event、Kafka 的 record |
| **Command** | 验证 + 决策，产出 0..n 个 Fact；自身无状态、不回放 | "谁决定改变" | CQRS 的 command、Redux 的 action creator |
| **View** | Fact 流上的纯函数折叠，唯一的状态载体 | "状态是什么" | Redux reducer+selector、Kafka Streams 的 KTable |
| **Signal** | 类型化、注册制的易失事件，永不持久化、不参与折叠 | "过程进行到哪了" | CDP 的 streaming event、protocol 的 volatile |
| **Effect** | 订阅 Fact/View 变化、只能通过 Command 回写的策略 | "事实引发什么后续" | ES 的 process manager / saga |
| **Hook**（保留，不变） | 写操作内的有序参与/否决 | "谁能拦截这次操作" | koa middleware、VS Code participant |

判词（替代 service-design.md §4 的扩展）：

> - "这件事**已经发生**且 resume 后必须还在" → **Fact**（commit）。
> - "我要**决定**是否让它发生、怎么发生" → **Command**（service 方法）。
> - "我要知道**现在的状态**" → **View**（get/onChange），绝不再手写私有字段。
> - "这只是**进行中的进度**，断线丢了也无所谓" → **Signal**。
> - "事实发生后**系统要接着做**某事" → **Effect**（live-only）。
> - "这次操作执行**过程中**我要参与/否决" → **Hook**（不变）。

### 2.2 流结构（Stream / Topic）——逻辑流，物理布局不变（§0）

- **逻辑上每个 Session 一条流，按 `agentId` 分区**；**物理上仍是每 agent 一个
  wire.jsonl**，session 流是各 agent 日志的进程内缝合视图。写 API 按分区路由到
  对应 agent 的物理日志，读/订阅方只面对逻辑流。
- **session 级事实（`todo.set`、`cron.*`）物理上继续落 main agent 的
  wire.jsonl**（数据兼容，record 形状不变），但接口上收进
  `sessionStream.commit(fact)`：类型安全（消灭 `as never`）、main 不存在时
  **抛错或显式排队**而不是静默丢写（W3 的接口层解法；物理归位是附录 C 远期项）。
- **seq 是进程内的逻辑序号**：session 流上单调递增，**不落盘**（数据结构冻结）。
  它用于 view 版本号、写回声、进程内订阅游标；跨重启的持久游标仍由 server 的
  SessionEventJournal 承担（现状不变）。核心保证：转发给边缘的事件顺序 =
  逻辑 seq 顺序，因此边缘 journal 的 seq 与核心逻辑 seq 单调一致。
- fork 保持现实现（复制 main 的 wire log）；接口上表达为
  `stream.forkInto(target)`，实现仍走 appendLogStore（W4 的接口层收口：
  唯一入口，不再散落在 sessionLifecycle 里手写）。
- App scope 一条逻辑流（config/model catalog/session 生命周期），取代
  `IEventService`（V4）——App 流本就无持久化，纯接口替换。
- **Topic = 流上的类型化过滤视角**，不是独立机制。订阅方用
  `subscribe({types?, agentId?, sinceSeq})` 表达，服务端不为每个 topic 建通道。

### 2.3 相位机（唯一的一处定义）

```
replaying ──(日志折叠完)──▶ ready ──(首个 live commit)──▶ live
```

| 相位 | commit(fact) | View fold | View onChange | Signal | Effect |
|---|---|---|---|---|---|
| replaying | **抛错**（编程错误） | ✅（静默） | ❌ | **抛错** | ❌ 不运行 |
| ready→live | ✅ | ✅ | ✅（队列化） | ✅ | ✅ |

对比现状：restore 期 append 被静默吞（W5）、signal 被隐式压制（V3）、四条通道
各有各的相位规则（L4）。新模型里**相位规则只在 commit/emit/fold/effect 四个入口
各写一次**，且违规是响声（throw）不是静默。

> 今天"resume 里合法地想写"的场景（goal 的 fork reminder 每次 restore 重新
> 生成）改由 **context injector**（已存在的 `IAgentContextInjectorService`）或
> ready 相位的一次性 Effect 承担——派生内容本来就不该伪装成回放副作用。
> `postRestoring` 窗口取消：task 磁盘对账、cron 启动等归入 ready 时刻的
> 一次性 Effect。

---

## 3. 类型系统：单一注册表 + 定义处声明可见性

### 3.1 一个注册表，两类条目

保留 declaration-merging 开放注册表模式（与 ErrorCodes/FlagRegistry/config
sections 一致），但把 `WireRecordMap`（18 个增补点）、`AgentEvent`（protocol 44
种）、`AgentReplayRecordPayload`（7 种）三套宇宙合并为一个 `EventMap`，每个条目
在**定义处**声明它是 fact 还是 signal：

```ts
// 域内声明（declaration merging，与今天相同的写法）
declare module '#/stream' {
  interface EventMap {
    'todo.set': Fact<{ todos: readonly TodoItem[] }, { scope: 'session' }>;
    'goal.update': Fact<GoalPatch, { scope: 'agent'; blobs?: BlobSelector }>;
    'assistant.delta': Signal<{ turnId: number; text: string }>;
    'tool.progress': Signal<ToolProgress>;
  }
}
```

- **可见性是类型属性，不是调用点决策**（解决 V1/V3）：`commit()` 只接受 Fact
  条目，`emit()` 只接受 Signal 条目，用错了编译不过。`task.started` 双注册、
  append+signal 两连发的写法从类型上消失。
- **数据兼容**（§0）：Fact 条目的类型字符串与 payload 形状 = 现有
  `WireRecordMap` 条目，逐字节不变；Signal 条目 = 现有 volatile `AgentEvent`。
  合并只发生在类型注册表层面，不产生新的落盘/线上形状。
- protocol 的 `VOLATILE_EVENT_TYPES` 从这个注册表**生成**（signal 即 volatile），
  分类只此一处（C5）。
- `blobs`（大内容 offload）仍是 Fact 定义的属性，随条目声明。
- **线上协议（AgentEvent）本期不变**：Fact → AgentEvent 的投影保留，但从
  "散落在各域的 toLive facet / 手动 signal"收敛为 Fact 定义处的唯一
  `live(payload): AgentEvent | undefined` 声明。`agent.status.updated` 这类
  多域共写事件（V2）由各相关 view 的 onChange 统一驱动一个投影器发出，
  不再各域手拼。wire 类型单源化（C8，protocol schema 从 EventMap/view 类型
  生成）是方向性目标，放在附录 C 远期项，本期只做"投影函数与类型同处声明、
  禁止路由层手写投影"。

> 兼容注：v1 协议消费者（messageLegacy/sessionLegacy）保留为边缘的翻译层，
> 从新 Envelope 流翻译到旧 shape，不再反向影响核心模型。

### 3.2 与 contract 生成的关系

`gen-contract-types.mjs` 剥实现、留接口的方向不变：`EventMap`、View 输出类型、
Command 接口就是 contract 面；`defineFact/defineView/defineEffect` 的注册调用
发生在实现类构造器中，会被剥除。若共享折叠代码给客户端（§7.3），view 的纯函数
部分单独放 `viewDefs/`（无 DI 依赖），可被 contract 打包。

---

## 4. 写路径规范

### 4.1 Command：决策与状态分离

```ts
// 唯一合法形态（W1 三风格 → 一风格）
setTodos(todos: TodoItem[]): void {
  // 1. 验证/决策（可读 view、可跑 hook、可有副作用补偿逻辑）
  const next = normalize(todos);
  // 2. 产出事实（0..n 个）
  this.stream.commit({ type: 'todo.set', todos: next });
  // 3. 没有第 3 步：不改私有字段、不手动 fire —— 状态由 view 折叠，通知由 view 发
}
```

规则：
- **Command 不持有可折叠状态**。所有"resume 后必须还在"的状态在 view 里。
  service 私有字段只允许装真正的运行时资源（进程句柄、定时器、连接）。
- **Command 不在 replay 中运行**（相位机保证）。resume 复用 live 命令的 hack
  消失：replay 只折叠 fact。
- 需要"先答应再补偿"的命令（plan.enter 失败后 cancel）就是两次 commit——
  补偿也是事实，天然可回放。
- `define()` 的 facet 机制退役：`resume` → view fold；`toLive` → 定义处
  redact；`toReplay` → transcript view（§5.3）；`blobs` → Fact 定义属性。
  W2 的合并/dispose 语义问题随 API 一起消失。

### 4.2 写回声与因果（C4）

`commit()` 返回 `{ seq }`。RPC 写接口把它透传给客户端，乐观 UI 用
"本地暂挂 → 收到 ≤seq 的确认即落定"的标准 rebase 模式（Replicache 的
mutation-id 思路的最简版）。`renameSession` 这类"写无回声"从此不可能——
写就是 commit，commit 必然出现在流里。

---

## 5. 读路径规范：View 三层

### 5.1 状态 View（迁移 R1 的 ~12 个域）

现有 `View<TState, TPayload, TOutput>`（`record.ts:57-68`）已经是正确形态，
推广为唯一状态载体，并补三件事：

1. **版本号**：`ViewHandle.get()` 返回 `{ value, seq }`——值与水位一致，
   snapshot 路由不再需要"drain queue 再读"的舞蹈（`snapshot.ts:10-14`）。
2. **派生组合**：`derive(view A, view B, f)` 只读组合器（同步、纯函数），
   替代 `sessionActivity.status()` 式的跨服务现拼轮询（R3）、
   `permissionGate.data()` 式的手工拼装。组合器不新建折叠状态，只做缓存+
   变更传播（等价 Redux reselect / VS Code derived observable）。
3. **禁止 IO**：view 输出必须纯内存。`plan.status()` 读文件 → 拆成
   "planFilePath 状态 view" + 调用方自己读文件（或 Effect 缓存文件内容为 view）。

`agent.status.updated`（V2）退役：它的每个字段来自某个 view，订阅方直接订
对应 view / 对应 topic，不再有"多域共写的散装快照事件"。

### 5.2 跨 scope View

Session 级 view（todo、后台任务表、pending interactions、sessionActivity）
折叠 session 分区 + 需要的 agent 分区。TUI 要的"后台任务表带终态"（C2）在这里
成为一等 view：折叠 `task.started/terminated` + `subagent.*` fact，终态对账
逻辑从 TUI 的 50 行注释搬进一个纯函数。

### 5.3 Transcript View（替代 replay builder，解决 R2/R4/C3）

UI 历史（今天的 `AgentReplayRecord[]`）就是一个折叠：
`transcript = fold(facts)`，输出结构化的
`Turn[] → Step[] → (Message | ToolCall{call,result,progress?})`。

- 双通道（toReplay + push/patchLast）消失；fullCompaction 的 patchLast 补写
  变成 fold 里对 `full_compaction.complete` 的常规 case。
- boundary/裁剪逻辑（partial resume 的 range/segment/frozen）成为 fold 的
  参数化初始条件，只写一处。
- messageLegacy 的"replay 或 view"启发式消失：冷启动与热读取是同一个 view。
- TUI 的 resume：`GET snapshot` 拿 `{ transcript.get(), seq }` →
  `subscribe(sinceSeq)` 接续。回放与实时一套代码（C3）。

### 5.4 流式增量的归宿（TUI 需求 §4）

Signal 不折叠进持久 view，但**规范其形态**：流式文本 signal 携带
`{ turnId, stepId, cumulative: string }`（累计文本）或定期 checkpoint，
配合 fact 上的 finalize 边界（`turn.step.completed` 等已是 fact）。
TUI 的 50ms 节流、相位切换 finalize 由"cumulative + 边界 fact"天然支持，
乱序/丢失的容忍度大幅提高（丢 signal 只丢中间帧，边界由 fact 保证）。

### 5.5 Ephemeral View（收编 InFlightTurnTracker，解决 C9）

第四类 view：**折叠 fact + signal、只活在 live 相位**的视图（重启/resume 后
从空态重建，不参与回放）。声明方式与状态 view 相同，多一个
`ephemeral: true` 标记。用途：

- `inFlightTurn`：今天 server 边缘的 `InFlightTurnTracker`（只跟 main、
  丢弃 subagent）成为核心标准 ephemeral view，按 agentId 分区折叠——
  subagent 的张力消失，因为 session 只有一个 seq（§2.2）；
- TUI 的 `streamingPhase`：从"客户端猜测的派生状态"变成核心 ephemeral view
  的字段。

snapshot 包含 ephemeral view 的当前值（与 seq 一致），所以断线重建不丢
进行中状态；但它们不写日志、不回放——这就是"volatile 流可折叠"的规范答案。

### 5.6 冷读与物化（解决 C6/C7）

view 是纯 fold，因此**天然支持冷读**：不实例化 agent/session scope，直接
`foldOffline(log, viewDef)` 即可得到任意 view 的值。规范两个消费面：

- **冷读 API**：`readView(sessionId, name)`——句柄在（热）读内存，句柄不在
  （冷）从日志折叠，读语义一致；**读永不触发 resume、永不创建 agent**
  （消灭 GET 建 main agent、读消息触发整套 resume）。
- **session 聚合视图**：`sessionSummary`（status/usage/messageCount/lastSeq/
  title）定义为跨分区 fold——正是 `toWireSession` 今天造假的字段。
  `ISessionIndex` 的列表条目从"目录树即索引"升级为该 view 的磁盘物化
  （`IQueryStore` 契约在此落地：projector = view fold，checkpoint = seq），
  列表页不再打开每个 session 的日志。

---

## 6. 事件机制收敛

| 现机制 | 去向 |
|---|---|
| `Emitter`（28 处） | View.onChange 覆盖状态类；仅保留给真正的运行时资源事件（进程输出、fs watch） |
| `OrderedHookSlot`（24 slot） | **保留原样**——它服务写路径的参与/否决（tool 执行、prompt 构建、loop 步进），与读模型正交 |
| `ViewHandle.onChange` | 保留，通知派发队列化（§8） |
| `IEventService` | 并入 App 流（类型化 fact/signal） |
| `AsyncEventQueue` | 保留为 LLM 流适配的内部实现细节；删兼容 re-export |
| `AsyncEmitter`/`handleVetos` | 删（死代码，能力已由 HookSlot 承担） |
| 裸回调（onUpdate 等） | 工具执行进度改发 Signal；RPC 反向调用（审批/提问）保留 |

`wireRecord.hooks.onRestoredRecord / onResumeEnded` 退役：restore 编排收进
相位机（fold 全部 → ready 一次性 Effect），L3 的三重隐式顺序契约消失。

---

## 7. 订阅协议（server 与 TUI 的统一消费面）

### 7.1 进程内订阅面（线协议本期不变）

```
核心暴露（进程内）：
  sessionStream.subscribe({ sinceSeq?, types?, agentId? })
    → AsyncIterable<{ seq, time, agentId, kind: 'fact'|'signal', type, payload }>
  readView(sessionId, name) → { value, seq }        // 冷热一致，见 §5.6
```

- **seq 是核心的进程内逻辑序号**（§2.2）：commit/emit 时分配、单调、不落盘。
  view 版本号、写回声、Effect 因果标记都引用它。
- **server-v2 广播器保留现职**（journal、持久 `{seq, epoch}`、backfill、
  resync，线上协议零改动），但消费源从"逐 agent 订阅 `record.on` + 生命周期
  追补"（`sessionEventBroadcaster.ts:256-275`）换成**一次订阅 session 逻辑流**：
  agent 增删、agentId/sessionId 附加、durable/volatile 分类（来自注册表）
  都由核心做完。边缘的 seq 与核心逻辑 seq 单调一致，snapshot 的
  "drain queue 后原子读"简化为"读 view 的 `{value, seq}`"。
- 断线重连/epoch/resync 语义完全沿用现协议（`ResyncReason` 不变）。
- journal 合一（删除边缘第二本账，C1 的彻底解）依赖 seq 落盘，属于附录 C
  远期项；本期 C1 的接口层收益是：边缘不再自己发明分类、缝合与一致性舞蹈。

### 7.2 server-v2 变薄

边缘保留 journal/seq/epoch/backfill（§0、§7.1），其余变薄：鉴权、连接管理、
统一流直通（durable/volatile 分类、agent 缝合、投影都由核心做完）、
REST 读路由 = `readView()` 的透传（热/冷一致，§5.6）。snapshot 路由从
"跨 6 个服务现拼 + drain queue 保一致"（`sessionLegacyService.ts:278-300`、
`snapshot.ts:10-14`）变成"读若干 view 的 `{value, seq}`"。写路由 = Command
的透传（actionMap 的 `resource:action` allowlist 模式保留，它已经证明
"命令 = Service 方法"可行）；路由层手发事件（C4）被"写即 commit、commit
必在流里"取代。pending approval/question 升格为持久 fact +
`pendingInteractions` view（C10）：审批请求/决议都是事实，掉电不失，
且 wire 投影不再靠 `as ApprovalRequest` 断言。

### 7.3 客户端读模型（可选进阶）

view 定义是无依赖纯函数（§3.2），可经 contract 包共享给 node-sdk/TUI：
客户端 `fold(snapshot, envelopes)` 增量维护同一批 view。TUI 的 4000 行适配层
中"join 事件重建状态"的部分（终态对账、todo 反推、streamingPhase 猜测）由
共享 fold 取代。这一步不阻塞核心重构，可后置。

---

## 8. 回环控制

三条机制，全部集中在 stream 实现里：

1. **提交队列**：`commit()` 同步折叠所有 view，但 **onChange 通知入队**，
   当前 commit 栈退出后按序派发（等价 VS Code observable 的事务、Redux 的
   dispatch-in-reducer 禁令）。onChange 处理器里再 commit → 入队排后，
   不重入折叠（解决 L2）。同一 microtask 内多次变更可合并（views 天然支持
   equals 去重）。
2. **Effect 注册制**：订阅者回写（L1 的 goal 续跑、swarm 自动退出、steer
   flush、overflow→compaction）显式注册为
   `defineEffect(name, { on: [...types] | view, run(ctx) })`：
   - 只在 live 相位运行（替代 4 处手写 restoring guard）；
   - 只能调 Command（不能直接 commit 裸 fact，保证决策逻辑不被绕过）；
   - Effect 产生的 fact 带 `cause: { effect, seq }` 因果标记，日志里
     回环可审计；同一 Effect 对同一 cause 链的触发深度设上限（默认 1），
     overflow→compaction→overflow 这类循环从"每处手写计数器"变成声明
     `maxCauseDepth`。
3. **相位机**（§2.3）：replay 期 commit/emit 抛错，Effect 不运行——回环
   在回放路径上物理不存在。

---

## 9. 迁移路径（每步独立可交付，不破坏现有消费者）

1. **P0 止血**（不改架构）：修 `define` 合并/dispose 语义（W2）；restore 期
   append 从静默吞改为 assert/log（W5 显形）；删死代码（AsyncEmitter、
   兼容 re-export、captureLiveRecords）。
2. **P1 注册表合一**：EventMap + Fact/Signal 二分 + `commit/emit` 新 API
   （旧 append/signal 作为别名过渡）；`VOLATILE_EVENT_TYPES` 改为生成。
3. **P2 view 化推平**：按依赖序迁移 12 个手写域到 view（goal 最复杂放最后）；
   引入 `derive` 组合器，改造 sessionActivity/permissionGate。
4. **P3 transcript view**：以 fold 重写 replay builder，双通道退役；
   messageLegacy 改读 transcript view。
5. **P4 相位机 + Effect**：收编 onRestoredRecord/onResumeEnded/postRestoring；
   四处 restoring guard、goal silent 抑制改 Effect/队列；pending interaction
   持久 fact 化 + ephemeral `inFlightTurn` view（server tracker 退役的前置）。
6. **P5 逻辑流与订阅面**：session 逻辑流（缝合现有 per-agent wire.jsonl，
   物理布局不变）；进程内逻辑 seq；`sessionStream.commit` 收编 todo/cron 借道
   写；`forkInto` 收口 fork；server-v2 broadcaster 改为消费统一流（线上协议
   不变）；`readView` 冷读 + `sessionSummary` 物化（新增索引文件，不触碰
   wire.jsonl）。
7. **P6（可选）**：共享 view 折叠到客户端；TUI 适配层瘦身；wire 类型单源化
   收尾（protocol schema 从 EventMap/view 类型生成）。

存储层的进一步收敛（附录 C）全部不在本期：P1–P5 均不产生新的日志格式或
迁移器。

P1–P4 在核心内部完成，对 server/TUI 完全透明；P5 需要 server-v2 配合一次
协议升级（Envelope 字段不变，seq 语义从边缘改核心）。

---

## 10. 与成熟系统的对照（控制复杂度的锚点)

| 借鉴 | 采纳的原语 | 明确不采纳的 |
|---|---|---|
| Event Sourcing / CQRS | fact 即真相、command/query 分离、projection、process manager | 聚合根/仓储层——scope 容器已承担边界 |
| Redux / Elm | 纯 fold、selector 组合、dispatch 队列 | 全局单 store——按 scope 分流 |
| Kafka | 分区日志、offset 即 seq、consumer 自带游标 | broker/consumer group——单机进程内不需要 |
| Replicache / LiveStore | 客户端共享 fold、mutation 回声 rebase | CRDT 合并——单写者（核心）无并发写 |
| VS Code | Emitter 风格 API、observable 事务式派发、contract/impl 分离 | — |
| CDP / LSP | domain 事件 + snapshot-then-stream、volatile 分类 | — |
| XState | 显式相位机 | 层级状态机——只有 3 个相位，不值得 |

复杂度预算：新模型的**机制数从 6+4（事件×相位）降到 5+1+3**
（原语×流×相位），且每个问题（W/R/V/L/C 共 21 条）都能指出由哪个机制消解
（附录 A）。

---

## 附录 A：问题 → 机制映射

| 问题 | 消解机制 |
|---|---|
| W1 三风格命令 | §4.1 唯一 Command 形态 |
| W2 define 语义 | §4.1 facet 退役（P0 先修复） |
| W3 借 main wire | §2.2 sessionStream 类型化接口（物理仍落 main wire，缺 main 时响声） |
| W4 fork 绕写模型 | §2.2 forkInto 唯一入口（实现不变） |
| W5 静默吞 append | §2.3 replay 期 commit 抛错 |
| R1 手写读模型 | §5.1 状态 view 推平 |
| R2 replay 双通道 | §5.3 transcript view |
| R3 读模型带 IO/轮询 | §5.1 禁 IO + derive 组合器 |
| R4 replay-or-view 启发式 | §5.3 冷热同源 |
| R5 死开关/空契约 | P0 删除；IQueryStore 待 P5 后按需实现为磁盘物化 view |
| V1 双注册两连发 | §3.1 Fact/Signal 二分，类型强制 |
| V2 散装快照事件 | §5.1 按 view 订阅 |
| V3 隐式压制 | §2.3 相位规则响声化 |
| V4 无类型总线 | §2.2 App 流 + EventMap |
| V5 死代码 | P0 删除 |
| L1 订阅者回写 | §8.2 Effect 注册制 + 因果深度 |
| L2 同步 fire 重入 | §8.1 提交队列 |
| L3 restore 顺序契约 | §2.3 相位机收编 |
| L4 相位规则分散 | §2.3 唯一定义处 |
| C1 两本 journal | §7.1 边缘改消费统一流（journal 合一 → 附录 C） |
| C2 按实体订阅 | §5 view 体系 + §7.1 types 过滤 |
| C3 回放=冷启动 | §5.3 + §7.1 snapshot/sinceSeq |
| C4 写回声/路由手发事件 | §4.2 commit 返回 seq + §7.2 |
| C5 volatile 分类分散 | §3.1 注册表生成 |
| C6 冷读需 resume/读有副作用 | §5.6 readView 冷热一致 |
| C7 session 聚合假值 | §5.6 sessionSummary 物化 view |
| C8 wire 类型双份 | §3.1 单源化 |
| C9 in-flight 边缘折叠/subagent 丢弃 | §5.5 ephemeral view + §2.2 单 seq |
| C10 pending interaction 掉电即失 | §7.2 持久 fact 化 |

## 附录 B：开放问题

1. session 逻辑流的缝合序：多 agent 并发 commit 时逻辑 seq 的分配点
   （建议：session 级单调计数器，commit 队列内分配，天然全序）；
   sub-agent 高频写是否需要独立背压。
2. Signal 是否需要背压/合帧策略下沉到核心（今天 TUI 自己 50ms 节流）——
   建议核心提供 per-type 合帧提示（`coalesce: 'replace' | 'append'`），
   边缘执行。
3. goal 域状态大（预算/心跳/续跑），view 化后 fold 性能与 fact 粒度需要
   专门设计（可能拆多个子 view）。
4. `sessionSummary` 物化索引的存储位置与失效策略（新文件，不碰 wire.jsonl；
   建议 seq checkpoint + 日志 mtime 双校验）。

## 附录 C：远期存储层收敛（本期明确不做）

以下项都依赖打破 §0 的冻结约束，留待接口统一稳定后单独立项：

1. **session 单日志分区**（物理合并 per-agent wire.jsonl，todo/cron 归位
   session 分区），需要 v1.6 迁移器；收益：fork 语义更准、缝合层消失。
2. **seq 落盘**（日志偏移即持久水位），之后才能删除 server 的
   SessionEventJournal（C1 的彻底解）与边缘 tail。
3. **wire 类型单源化收尾**：protocol zod schema 从 EventMap/view 输出类型
   生成，消灭 Goal/Usage/Task/PermissionRule 双份定义。
4. v1.5 迁移器已内置 mini 回放机；若未来做 1/2 项，迁移应一次性偿还，
   避免继续在迁移器里堆语义。

## 附录 D：接口与场景代码示例

> 示例遵循仓库现有习惯：contract 文件放接口 + `createDecorator`，实现类构造器
> 里做运行时注册（可被 `gen-contract-types` 剥离），类型注册表用 declaration
> merging。所有示例均满足 §0 冻结约束：不新增落盘格式。

### D.0 核心接口（`#/stream` contract）

```ts
// ---- 类型注册表：两类条目，可见性即类型属性（§3.1） ----
export interface FactMap {}    // 各域增补：'todo.set' → payload 形状（= 现 WireRecordMap，逐字节兼容）
export interface SignalMap {}  // 各域增补：'assistant.delta' → payload 形状（= 现 volatile AgentEvent）
export interface ViewMap {}    // 各域增补：view 名 → 输出类型（沿用现 record.ts:47）

export type Fact<K extends keyof FactMap = keyof FactMap> =
  { [T in K]: { readonly type: T; readonly time?: number } & Readonly<FactMap[T]> }[K];
export type Signal<K extends keyof SignalMap = keyof SignalMap> =
  { [T in K]: { readonly type: T } & Readonly<SignalMap[T]> }[K];

/** 提交回执：进程内逻辑 seq（不落盘，§2.2），写回声 / 乐观 UI 用（§4.2）。 */
export interface CommitReceipt { readonly seq: number }

/** Fact 的定义处声明（取代 define() 的 facets，§4.1）。 */
export interface FactOptions<K extends keyof FactMap> {
  /** 唯一的 live 投影（取代散落的 toLive/手动 signal，V1/V2）。undefined = 不广播。 */
  readonly live?: (fact: Fact<K>) => AgentEvent | undefined;
  /** 大内容 offload 选择器（沿用现 blobs 语义）。 */
  readonly blobs?: WireRecordBlobSelector<Fact<K>>;
}

export interface View<TState, TPayload, TOutput = TState> {
  readonly init: TState;
  select(fact: Fact): TPayload | undefined;          // 过滤 + 提取
  reduce(state: TState, payload: TPayload, fact: Fact): TState;  // 纯函数
  derive?(state: TState): TOutput;
  equals?(a: TOutput, b: TOutput): boolean;
  /** true = 折叠 Signal、只活在 live 相位、进 snapshot 不回放（§5.5）。 */
  readonly ephemeral?: boolean;
  selectSignal?(signal: Signal): TPayload | undefined;  // 仅 ephemeral view 可声明
}

export interface ViewHandle<T> {
  /** 值与水位一致读（§5.1），snapshot 不再需要 drain-queue 舞蹈。 */
  get(): { readonly value: T; readonly seq: number };
  onChange(h: (c: { old: T; new: T; seq: number }) => void): IDisposable; // 队列化派发（§8.1）
}

export interface EffectContext {
  readonly cause: { readonly type: string; readonly seq: number; readonly depth: number };
}
export interface EffectSpec {
  readonly on: readonly (keyof FactMap)[];   // 或 { view: keyof ViewMap }
  /** 因果深度上限：Effect 引发的 fact 再触发本 Effect 的最大链深（§8.2），默认 1。 */
  readonly maxCauseDepth?: number;
  run(fact: Fact, ctx: EffectContext): void | Promise<void>;  // 只能调 Command，不能裸 commit
}

export type StreamPhase = 'replaying' | 'ready' | 'live';

/** Agent 分区（物理 = 该 agent 的 wire.jsonl，不变）。 */
export interface IAgentStream {
  readonly _serviceBrand: undefined;
  readonly phase: StreamPhase;

  commit<K extends keyof FactMap>(fact: Fact<K>): CommitReceipt;   // replaying 期抛错（§2.3）
  emit<K extends keyof SignalMap>(signal: Signal<K>): void;        // replaying 期抛错

  defineFact<K extends keyof FactMap>(type: K, opts?: FactOptions<K>): IDisposable;
  defineView<K extends keyof ViewMap>(name: K, view: View<any, any, ViewMap[K]>): IDisposable;
  view<K extends keyof ViewMap>(name: K): ViewHandle<ViewMap[K]>;
  defineEffect(name: string, spec: EffectSpec): IDisposable;
  /** ready 时刻一次性回调（取代 onResumeEnded/postRestoring，L3/L4）。 */
  onReady(fn: () => void | Promise<void>): IDisposable;
}
export const IAgentStream = createDecorator<IAgentStream>('agentStream');

/** Session 逻辑流：各 agent 分区的缝合视图 + session 级事实（§2.2）。 */
export interface ISessionStream {
  readonly _serviceBrand: undefined;
  /** session 级 fact：物理落 main agent wire（数据兼容）；main 缺失时抛错，不再静默丢（W3）。 */
  commit<K extends keyof FactMap>(fact: Fact<K>): CommitReceipt;
  defineView<K extends keyof ViewMap>(name: K, view: View<any, any, ViewMap[K]>): IDisposable;
  view<K extends keyof ViewMap>(name: K): ViewHandle<ViewMap[K]>;
  /** 统一订阅面（§7.1）：server 广播器唯一消费入口，agent 缝合/分类由核心做完。 */
  subscribe(opts: {
    sinceSeq?: number;
    types?: readonly string[];
    agentId?: string;
  }, handler: (e: {
    seq: number; time: number; agentId: string;
    kind: 'fact' | 'signal'; event: AgentEvent;   // 线上形状不变（§0）
  }) => void): IDisposable;
  /** fork 唯一入口（W4）；实现仍是 appendLogStore 层复制，不变。 */
  forkInto(targetSessionId: string): Promise<void>;
}
```

### D.1 场景：todo 域重写（三重记账 → Command + View）

今天：`setTodos` 改私有字段 + `append`（`as never`）+ 手动 fire；resume 另有一份
只改字段不通知的 resumer（`sessionTodoService.ts:84-113`）。重写后：

```ts
// ---- 类型声明（payload 与现 wire.jsonl 中的 todo.set 逐字节相同） ----
declare module '#/stream' {
  interface FactMap { 'todo.set': { todos: readonly TodoItem[] } }
  interface ViewMap { todo: readonly TodoItem[] }
}

// ---- view：live 与 resume 唯一的一份状态逻辑 ----
const todoView: View<readonly TodoItem[], readonly TodoItem[]> = {
  init: [],
  select: (f) => (f.type === 'todo.set' ? f.todos : undefined),
  reduce: (_state, todos) => todos,
};

export class SessionTodoService extends Disposable implements ISessionTodoService {
  constructor(@ISessionStream private readonly stream: ISessionStream) {
    super();
    this._register(stream.defineView('todo', todoView));
  }

  /** Command：验证 + commit，没有第三步（§4.1）。 */
  setTodos(todos: readonly TodoItem[]): CommitReceipt {
    const next = todos.map(({ title, status }) => ({ title, status }));
    return this.stream.commit({ type: 'todo.set', todos: next });
    // 不改私有字段（状态在 view）；不 fire（通知由 view.onChange）；
    // main agent 缺失 → commit 抛错（今天是静默丢写）；
    // resume 后 todo 自动就位（view 回放折叠），不需要 resumer。
  }

  getTodos(): readonly TodoItem[] {
    return this.stream.view('todo').get().value;
  }
}
```

### D.2 场景：goal 状态与 live 投影（四种表达 → 一种）

今天 goal 有四套词汇：`goal.update` record、`goal.updated` signal、
`goal_updated` replay 记录、`getGoal()` getter。重写后只剩 fact + view：

```ts
declare module '#/stream' {
  interface FactMap {
    'goal.create': { goal: GoalInit }
    'goal.update': { patch: GoalPatch }        // 增量事实，形状不变
    'goal.clear': {}
  }
  interface ViewMap { goal: GoalSnapshot | null }
}

export class AgentGoalService extends Disposable implements IAgentGoalService {
  constructor(@IAgentStream private readonly stream: IAgentStream) {
    super();
    // live 投影在定义处声明一次：取代手动 signal('goal.updated')（V3 的响声化也在此：
    // replay 期根本不会走到投影，无需隐式压制）
    this._register(stream.defineFact('goal.update', {
      live: (f) => ({ type: 'goal.updated', patch: f.patch }),
    }));
    this._register(stream.defineView('goal', goalView));  // fold 见下
  }

  /** 高频预算更新：silent 抑制不再需要——view.equals 去重 + 通知队列合帧（§8.1）。 */
  recordTokenUsage(usage: TokenUsage): void {
    this.stream.commit({ type: 'goal.update', patch: { usage } });
  }

  getGoal(): GoalSnapshot | null {
    return this.stream.view('goal').get().value;
  }
}

const goalView: View<GoalState, GoalFold, GoalSnapshot | null> = {
  init: EMPTY_GOAL_STATE,
  select: (f) =>
    f.type === 'goal.create' ? { kind: 'create', goal: f.goal }
    : f.type === 'goal.update' ? { kind: 'patch', patch: f.patch }
    : f.type === 'goal.clear' ? { kind: 'clear' }
    : undefined,
  reduce: applyGoalFold,          // 原 restoreUpdate/appendStatusUpdate 两份平行逻辑合一（R1）
  derive: toSnapshot,
  equals: goalSnapshotEquals,     // 预算微变不触发通知（取代 silent 标志）
};
```

### D.3 场景：派生组合 view（替代轮询式 sessionActivity）

```ts
declare module '#/stream' {
  interface ViewMap {
    pendingInteractions: readonly PendingInteraction[]
    activeTurns: ReadonlyMap<string /* agentId */, ActiveTurnInfo>
    sessionActivity: SessionStatus   // 派生，无自有折叠状态
  }
}

// derive：只读组合器（§5.1），同步纯函数 + 变更传播；无轮询、无跨服务现拼
sessionStream.defineView('sessionActivity', deriveViews(
  ['pendingInteractions', 'activeTurns'],
  (pending, turns): SessionStatus => {
    if (pending.some((p) => p.kind === 'approval')) return 'awaiting_approval';
    if (pending.some((p) => p.kind === 'question')) return 'awaiting_question';
    if (turns.size > 0) return 'running';
    return 'idle';
  },
));
```

### D.4 场景：ephemeral view `inFlightTurn`（收编边缘 InFlightTurnTracker）

```ts
declare module '#/stream' {
  interface SignalMap {
    'assistant.delta': { turnId: number; stepId: number; cumulative: string }  // 累计文本（§5.4）
    'tool.progress': { toolCallId: string; channel: 'stdout' | 'stderr'; chunk: string }
  }
  interface ViewMap { inFlightTurn: InFlightTurn | null }
}

const inFlightTurnView: View<InFlightState, InFlightFold, InFlightTurn | null> = {
  ephemeral: true,                       // 折叠 signal、live-only、进 snapshot 不回放（§5.5）
  init: NO_TURN,
  select: (f) =>                          // fact 提供边界
    f.type === 'turn.launch' ? { kind: 'start', turnId: f.turnId }
    : undefined,
  selectSignal: (s) =>                    // signal 提供进行中内容
    s.type === 'assistant.delta' ? { kind: 'text', ...s }
    : s.type === 'tool.progress' ? { kind: 'tool', ...s }
    : undefined,
  reduce: foldInFlight,                   // 原边缘 tracker 逻辑搬进核心，subagent 不再被丢弃（C9）
  derive: (st) => st.turn,
};
```

### D.5 场景：Effect（订阅者回写的唯一合法形态）

```ts
// swarm 自动退出：今天挂在 turn.hooks.onEnded 里直接写（L1）
export class AgentSwarmService extends Disposable {
  constructor(@IAgentStream private readonly stream: IAgentStream) {
    super();
    this._register(stream.defineEffect('swarm-auto-exit', {
      on: ['turn.ended'],                // 只在 live 相位运行；replay 期物理不存在（§8.3）
      run: () => {
        if (this.isActive()) this.exit();   // 只能调 Command——exit() 内部 commit
      },
    }));
  }
}

// overflow → compaction：手写 consecutiveOverflowCompactions 计数器 → 声明式深度上限
stream.defineEffect('overflow-compaction', {
  on: ['turn.step.overflowed'],
  maxCauseDepth: 2,                      // compaction 引发的再 overflow 最多续 2 层，超限自动停
  run: (fact, ctx) => fullCompaction.begin({ cause: ctx.cause }),
});
```

### D.6 场景：resume / 回放 / 局部回放（相位机 + transcript view）

```ts
// 恢复编排（原 doResume 的手动预热、resumer/hook 三重顺序契约 → 一个流程，L3）
async function resumeAgent(stream: AgentStreamImpl): Promise<void> {
  await stream.replay();
  // 内部：读既有 wire.jsonl（路径/格式/迁移链不变，§0）→ 逐条 fold 进所有 view
  // （静默，无 onChange、无 Effect、无广播）→ 期间任何 commit/emit 直接抛错（W5 响声化）
  await stream.markReady();
  // 触发 onReady 一次性回调：task 磁盘对账、cron 启动、goal normalize
  // （原 postRestoring 窗口 / onResumeEnded hooks 全部收编于此）
}

// transcript view：UI 历史 = fold（替代 replay builder 双通道，R2/R4）
declare module '#/stream' {
  interface ViewMap { transcript: readonly TranscriptTurn[] }
}
// 局部回放：原 range/segment/frozen 机制 → fold 的参数化初始条件，只写一处
stream.defineView('transcript', transcriptView({ range: { start: 120 } }));

// RPC 的 resumeSession 返回值（形状兼容现 ResumeSessionResult）：
const { value: replay, seq } = stream.view('transcript').get();
return { replay, seq };   // seq 给客户端做订阅接续水位（C3）
```

### D.7 场景：server-v2 消费面（广播器换源 + snapshot + 写回声）

```ts
// 广播器：原"逐 agent 订阅 record.on + onDidCreate/onDidDispose 追补"→ 一次订阅
const sub = sessionStream.subscribe({ sinceSeq: 0 }, ({ seq, kind, event }) => {
  // durable/volatile 已由注册表分类（kind），agentId/sessionId 已缝合；
  // journal/epoch/backfill/resync 照旧（§0），边缘 seq 与核心逻辑 seq 单调一致
  broadcaster.dispatch(seq, kind, event);
});

// snapshot 路由：跨 6 服务现拼 + drain queue → 读 view 的 {value, seq}（C6/C7）
app.get('/sessions/:id/snapshot', async (req, reply) => {
  const transcript = await readView(req.params.id, 'transcript'); // 冷热一致：句柄不在则离线折叠，
  const activity   = await readView(req.params.id, 'sessionActivity'); // 永不触发 resume/建 agent
  const inFlight   = await readView(req.params.id, 'inFlightTurn');
  reply.send({ as_of_seq: transcript.seq, messages: transcript.value,
               status: activity.value, in_flight_turn: inFlight.value });
});

// 写路由：写即 commit，commit 必在流里——路由手发 event.session.created 三遍的问题消失（C4）
app.post('/sessions/:id/todos', async (req, reply) => {
  const { seq } = todoService.setTodos(req.body.todos);
  reply.send({ seq });   // 客户端乐观 UI 的确认水位：收到 ≤seq 的回声即落定
});
```

### D.8 场景：TUI 消费（回放 = 冷启动 + seq 接续）

```ts
// 今天：SessionReplayRenderer 逆向工程 LLM 上下文 + 时间近似衔接实时流（C3）
// 重写后：
const snap = await api.snapshot(sessionId);          // { as_of_seq, views... }
renderTranscript(snap.messages);                     // 与 live 同构的结构化数据
ws.subscribe({ sessionId, sinceSeq: snap.as_of_seq }); // 无缝接续，不丢窗口事件

// 乐观写：
const pending = optimisticApply(localState, input);
const { seq } = await api.setTodos(sessionId, input);
pending.confirmWhen((echo) => echo.seq >= seq);      // 写回声 rebase（§4.2）
```
