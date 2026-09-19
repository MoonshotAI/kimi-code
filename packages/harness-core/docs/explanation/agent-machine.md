# Agent 状态机

机器在 `packages/agent-core/src/agent-machine/`，store-free。`AgentUnit` 创建机器、翻译写回、对外暴露命令。机器不认识 ports、不认识 journal。`setConfig` / `setCredentialProvider` / `setRequester` 只改下次 `generate`，不进这台机器。

三台嵌套机器：

```text
agent
 ├── idle.{ready | waiting | gating}
 ├── running.{active | aborting}   invoke turn
 └── closing → disposed

turn
 ├── gating          useBeforeStep
 ├── streaming.requesting   invoke llmActor
 ├── preparingTools  useBeforeToolBatch → useBeforeTool → useToolPermission（全批决策完才 spawn）
 ├── acting.{running | aborting}  等本步 tool
 ├── draining        向 agent 要 notify / reminder
 ├── compacting      悬停等 context reset，落账后回 gating 续跑
     → gating | done | failed | aborted

tool
 ├── starting        预置 result（denied 裁决）→ finishing
 ├── executing       execute + detach
 └── finishing       useAfterTool
     → succeeded | failed | aborted
```

XState 时序（entry 拦不住 invoke、onDone 是转移）见 [lifecycle-model](lifecycle-model.md)。这里只讲产品语义。

## 队列的目的

`submit` 等到 `prompt.submitted` 才返回（命令已被接收），不写 journal，也不等 `turn.ended`。机器用三个袋子把「用户想说的话」和「正在跑的 turn」拆开：

| 袋子 | 谁放进去 | 目的 |
|---|---|---|
| `queue` | `submit` | 追踪的用户 prompt。占一个用户回合，可 `cancel` / `steer`。idle 时才取出队头、写入 history、开 turn |
| `notifications` | `notify`、`steer`、后台 tool 完成 | 不占 prompt 队列。下一轮 `turn.drain` 整批发进 history |
| `reminders` | `remind(message, meta?)` | 纯追加，机器不去重；关联与「只发一次」由调用方用 `meta.key` 自行管理。同样等到 drain 才进 history |

queue 存在是因为用户输入必须能排队、能撤、能并，而且不能堵住当前 LLM / tool。活着的 queue 在机器 context；`AgentUnit.submit` 目前不写 `input.submitted`，所以投影里的 queue 跨重启是空的。

`steer` 是「把还没开跑的若干 queue 项收成一条 notification」。`cancel` 只删还在 queue 里的；已经 `running` 的那条要用 `abort`。

## Agent：何时开回合

根状态 `idle` / `running` / `closing`。`idle` 里再分：

| 子状态 | 含义 |
|---|---|
| `ready` | 没事做，或马上要走 always |
| `waiting` | 没有待处理 prompt，但有后台 tool（`detach` 出去的） |

`ready` / `waiting` 的 always：`notifications` 或 `queue` 非空且未 pause → 进入 `running`。drain 在转移时同步完成——notifications 并入 history，queue 头取出为 `drainedEntry`（**不进 history**，gate 过后才落）；queue 其余项留在队列。

`input.submit` 进 queue（追踪的用户输入）。`input.notify` 进 notifications（不占 prompt 队列）。`input.remind` 追加进 reminders（机器不去重，调用方用 meta 自行关联）。`input.steer` 把若干 queued prompt 合成一条 notification。`input.cancel` 按 `promptId` 从 queue 删除——只能删还在排队的；已经 drain 进 turn 的那条要用 `abort`。这些在 idle 和 running 都能收。

`input.pause` 只立 `paused`；running 的 turn 执行相时同时 `turn.pause`。`input.continue` 清 pause；若 history 停在半截 tool chain（最后一条是 tool，或 assistant 带 toolCalls）且没有 pending，会直接再进 `running`。

`input.close`（卸载）进 `closing`，abort scope 与 turn tools，然后 `disposed`。

## Running：一个 turn

进入 `running` **立即发 `turn.started`**（`activeTurnId = turnId`，`entry` 为 drain 出的原始 prompt），随后按顺序：

- `gating`：`drainedEntry` 存在且装了 `promptGate` 才 invoke gate（否则直通）。gate 通过 → 把（可能被 gate 改写的）prompt 并入 `messages`、发 `turn.prompt_committed`、spawn turn actor 进 `active`；gate 拦截或抛错 → **原始 prompt 同样并入 `messages` 落盘**（对齐 v2 UserPromptSubmit 语义：被拦截的 prompt 进 context，后续 turn 可见），发 `prompt.blocked`（payload 不变），并合成 `turn.done`（`failed` 结局）回 `idle`。gating 期间 `input.abort` → 发 `turn.aborting`/`agent.aborted` 并合成 `turn.done`（`aborted` 结局）回 `idle`；`input.pause` 只立标志，gate 通过 spawn 后补 `turn.pause`。
- `active`：turn actor 实际跑（输入是 commit 后的 `messages`；`config` / 凭证 / 传输活读命令面上的值）。turn 完成（`xstate.done.actor.turn`）→ 回 `idle` 并发 `turn.done`。
- 离开 `running` 时 abort/stop 本 turn 的 tool actor 与 turn actor，`turnId += 1`

turn 内部一步是「LLM →（可选）工具 → drain」。

**gating**：有 `onBeforeStep`（含 Feature 的 `useBeforeStep`）就先跑。hook 返回 `{ compact: true }` 决策（compaction 超预算）则进 `compacting`，不杀 turn。

**streaming.requesting**：调 `runLlmRequest`。policy（resolver / recovery / retry / media）在 actor 里，turn 没有 retrying 状态。流式事件原样转给 agent。`llm.done` 时：

- 已把这一条 assistant **写入 turn history**，再发给父机（同一对象）
- 有 toolCalls → `acting`，否则 → `done`

**acting**：向 agent 发 `turn.spawn_tools`。agent 为每个 call spawn `toolActor`。tool `done` / `failed` / `aborted` / `detached` 记入 outcomes；齐了就 `draining`。`detach` 把 actor 从 turnTools 挪到 `background`，turn 只收一条 ack 文案，真正完成以后当 notification 回来。

**draining**：向 agent 发 `turn.drain`。agent **必回** `agent.notify`（没有 pending 也回空数组），并 emit `turn.drained`。然后：

- pause → turn `done`
- 超过 `maxSteps` → `failed`（`TurnFailure.reason = 'max_steps'`；notify 带入的消息先入 history 再失败）
- 否则回到 `gating` 开下一步（steps 恒递增，notify 带入消息不重置）

**compacting**：两个入口——gating 决策 `{ compact: true }`（budget）与 `llm.failed.remote` 且 `error.kind === 'context_overflow'`（overflow，该失败被吸收不再外发）。入口向 agent 发 `turn.compaction_requested { reason, history }`（agent 补 `turnId` 后 emit），然后悬停等 `turn.compaction_finished`：携 `history` 则整体替换现有 history、`toolCallIds` 重播种、清空本轮 produced 累积器，回 `gating` 原地续跑（budget 复检自然通过、overflow 重发失败请求）；携 `error` 则 turn `failed`。`turn.abort` → `aborted`。压缩只发生在 step 边界，`acting`（工具在飞）不进。

turn 的 `produced`（终局交给 agent 追加进 `messages` 的部分）是累积器：llm / salvaged assistant、tool 结果、drain 进 history 的 notify 逐条记，reset 时清零——reset 前产生的条目随旧 history 一起丢弃。

turn 结束（`done` / `failed` / `aborted`）后 agent 回到 `idle`，并 emit `turn.done`（终局由 `outcome` 区分）。

## Tool

决策相在 turn 的 `preparingTools`：`useBeforeToolBatch` 先对整批裁决（denied 则全批逐 call 否决），随后每个 call 依次过 `useBeforeTool`（可改 `toolCall`，或 `denied` 带一条假结果）与 `useToolPermission`；per-call 并行、链内顺序。全批 before 跑完后才发 `turn.spawn_tools`（携 decisions）统一进入执行——没有任何 tool 会在兄弟 call 的 before 未完成前开跑。tool actor 是纯执行机：spawn 时 decision 已折成最终 `toolCall` 与可选的预置 `result`（denied），`starting` 按有无预置 `result` 分流（有则直接进 `finishing`），`executing` 调 `tool.execute`；`onUpdate` → `tool.update`，`detach(text)` → `tool.detached`。`finishing` 跑 `useAfterTool`（deny 路径也跑）。abort 落在 preflight 期间时整批合成 aborted 结局。未知工具名由 `bindAgentLogics` 收成文本结果，不抛。

## AgentUnit 怎么把机器变成 journal

`useMachine({ fire: false })`。节点不转发 streaming。`bindAgentLog` 听机器，往 `AgentStore.dispatch`：

| 机器事件 | 写入 |
|---|---|
| `llm.done` | 立刻 `message.appended`（这一步的 assistant） |
| `turn.prompt_committed` | 立刻 `message.appended`（本轮的 prompt，gate 通过后；被拦截时落原始消息） |
| `turn.drained` | 把 turn history 里新出现的 tool / drain 消息 `message.appended` |
| `turn.started` | 先写 `turn.started`（`turnId` / `queueItemId`），再把本轮 drain 进的 notifications 补成 `message.appended` |
| `turn.done` | `turn.ended`（`outcome` / `errorMessage`） |

`store.onCommit` 之后 `node.fire(entry.event)`。所以 `session.on('message.appended')` 看到的是已落盘对象。一个 turn 可以有多条 `message.appended`，不是整 turn 一条。journal 上的 turn 区间序列为 `turn.started` →（prompt 的 `message.appended`，gate 过后）→ 各步产物。

`agent.submit` / `notify` / `remind` / `cancel` / `steer` / `abort` / `pause` / `continue` 是 XState `send` 的同步封装：先订对应 `emit`，再 `send`（同步派发），把回执事件同步返回；actor 未运行（done / stopped / unmounted）时返回 `undefined`。`submit` **不**写 `input.submitted`。投影里的 queue 字段因此跨重启是空的；活着的 queue 在机器 context 里。并发 `submit` 用 entry 对象身份匹配回执；`steer` 用请求的 `ids`。每一条命令路径都必须 `emit`，否则回执为 `undefined`。

`agent.on('turn.done')` 会等到这次 dispatch 链 `settled` 再回调，避免 UI 先于 journal。`agent.wait(type, { match, timeoutMs, signal })` 是 `on` 的 Promise 化：匹配到即 resolve（`turn.done` 同样等 settled），`timeoutMs` 超时或 `signal` 中止即 reject 并自动清理订阅。

`agent.run(message, { meta, timeoutMs, signal, onStarted, abortAsOutcome })` 是 `submit` + `wait` 的复合命令，**前置要求 agent 空闲**——机器须处 `idle`、未 pause、queue 与 notifications 皆空，否则以 `AgentRunError`（`code: 'busy'`）reject（排队语义用 `submit`）。由于 turn 在 `submit` 的同步宏步内即开跑（gating 在 turn 内），`submit` 返回后 `activeTurnId` 即本次 turnId——没有启动竞态，此约束下 run 期间出现的唯一 turn 必属本次调用。自动分配 `promptId`（`meta.promptId` 可覆盖），拿到 turnId 后回调 `onStarted`，随后按 `turnId` 匹配 `turn.done` 与按 `promptId` 匹配 `prompt.blocked` 竞速。turn 真实收场（含机器侧 aborted）即 resolve `{ turnId, branchId, outcome, messages }`；prompt 被 gate 拦截以 `AgentRunError`（`code: 'blocked'`）reject（turn 同步以 `failed` 收尾，原始消息已落 history）；提交时 actor 未运行以 `code: 'not_running'` reject。外部 `signal` 中止或超时则 reject（归一化为 Error 的中止原因），并同步善后 `abort(reason)`。`abortAsOutcome: true` 时外部中止/超时不再 reject（善后照常），返回类型变为 `AgentRunOutcome`——`outcome` 恒在（值级 `{ type: 'aborted', reason }`），`turnId`/`branchId`/`messages` 仅 turn 真正跑完时才存在（调用时 signal 已中止则三者缺席）；工具执行器等只关心 outcome 的消费方用这条重载。

`agent.retry({ meta, timeoutMs, signal, onStarted, abortAsOutcome })` 是「无新输入续跑」的 `run` 变体：提交一条空 content 的 user 消息，`meta.origin` 恒由框架写为 `{ kind: 'retry' }`（覆盖传入值），返回类型与两条重载规则和 `run` 相同。子代理 resume 重跑等「不给新信息、让它继续产出」的场景用这条命令，调用方不再自行构造空消息与 origin。

## 相关文档

- 事件字段 → [events](../reference/events.md)
- 报文 → [HistoryMessage 与 Delta](../reference/history-message.md)
- 跑一个 turn → [01](../how-to-guides/01-run-a-turn.md)
- XState 钩子时序 → [lifecycle-model](lifecycle-model.md)
