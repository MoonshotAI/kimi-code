# 事件

两套面，按载荷选订阅 API：

| 面 | 订阅 | 载荷类型 | 何时出现 |
|---|---|---|---|
| 节点 | `app.on` / `session.on` / `app.wait` / `session.wait` | 已提交的 journal 事件，或 Feature `fire` | `store.onCommit` 之后，或 `useFire()` |
| 机器 | `agent.on` | `AgentEmitted` | 机器 `emit` / 转发，不落盘 |

`on(type, handler)` 的开放字符串仍是 `RuntimeEvent`。带 Feature 泛型：`on(feature, type)`；`on(feature, '*')` 只收 `featureName.` 前缀。`wait` 是 `on` 的 Promise 对偶，overload 相同，只等之后发生的事件，卸载时拒绝。

## 节点：agent journal（`AgentLogEvent`）

`packages/agent-core/src/stores/agent.ts`。`decodeAgent` 认识这五个；其它 type 留给 Feature。

| type | 字段 | 谁写 |
|---|---|---|
| `message.appended` | `message: HistoryMessage` | `turn.started` 后先落本轮 drain 进的 notify；prompt 经 gate 后随 `turn.prompt_committed` 落（被拦截时落原始消息）；`llm.done` 立刻写 assistant；`turn.drained` 再写本步 tool / drain |
| `turn.started` | `turnId`，`queueItemId?` | 进入 `running`，是本轮第一条 journal 记录 |
| `turn.ended` | `turnId`，`outcome: 'done' \| 'failed' \| 'aborted'`，`errorMessage?` | turn 终态 |
| `input.submitted` | `entry: UserEntry` | 投影认识，当前 `AgentUnit.submit` **不写** |
| `context.reset` | `messages: HistoryMessage[]`，`reason?`，`instruction?`，`stats?` | 机器消费 `input.context_reset` 后 emit，AgentUnit 写这一条。fold 语义「整段替换 history」：reset 前记录留在 journal，其后的 `message.appended` 续写在 seed 之后；queue / turnIndex 不动 |

一个 turn 可以有多条 `message.appended`。think 与 text 在同一条 assistant 上。

等回合结束用 `session.wait`：

```ts
const ended = session.wait('turn.ended');
agent.submit(message);
const event = await ended;
if (event['outcome'] !== 'done') {
  throw new Error(String(event['errorMessage'] ?? event['outcome']));
}
```

## 节点：session journal（`SessionEvent`）

`packages/agent-core/src/stores/session.ts`。session journal 只记 durable 事实，每条 commit 经 SessionUnit 的 `onCommit → node.fire` 桥上节点面（与 agent journal 同一机制），下列事件在 `session.on` / `app.on` 都能收到。

| type | 字段 | 谁写 |
|---|---|---|
| `session.created` | `from?`（fork 来源 sessionId）；经 `EventContext` 带 `sessionId` | `app.open` 在 catalog 记录新建时（startup 与 fork；resume / live 复用不发；`app.create({ stores })` 低层路径不经此） |
| `agent.created` | `agentId`，`branch`，`features?`，`source?` | `SessionStores.open` 首次登记（一次性；旧 journal 的 `agent.opened` 记录按此折叠） |
| `agent.switched` | `agentId`，`branch`，`reason?`，`stats?` | `undo` / `switchBranch` |
| `session.meta_updated` | `meta`（patch，折叠浅合并） | `app.open` 写 catalog 记录；`app.updateSession`；main agent `turn.ended` 时 SessionUnit 落 `{ lastTurn }`（重开 / 换分支后随 `session.create` 校正） |

live 生命周期是单独的现场事件（不落盘）：`session.create` / `session.fork` 在 agent 挂好 ready 后 fire `agent.opened { agentId, source?, reopened? }`——首次创建 `reopened` 缺省，roster 已有登记的重开带 `reopened: true`（resume / 重挂，source 从 roster 取）；`session.close` 在实际 live 关闭后 fire `agent.closed { agentId }`。子代理身份的生命周期以这组事件为准（配 roster source 判定创建者与 profile）。`agent.created` 是登记事实（commit 时点，早于 ready）；要「agent 可用了」订 `agent.opened`。

`app.delete(sessionId)` 删除会话（live 先 close、再 `space.delete` 清持久数据，未知 id 抛 `SessionSpaceError('not-found')`），完成后在 app 节点 fire `session.deleted { sessionId }`（不落盘，live 与 cold 删除都发）——会话级删除的唯一通知通道，feature-http WS 端点经 `useOnApp` 订阅并广播给全部连接。

## 节点：Feature

| type | 所有者 | 是否落盘 |
|---|---|---|
| `interaction.requested` | `interaction`，字段 `interaction` | 否，`useFire` |
| `interaction.resolved` | `interaction`，字段 `id` / `response` / `interaction` | 否 |
| `todo.updated` | todo 投影，字段 `todos` / `lastWriteTurn` | 是，agent journal |
| `compaction.started` | compaction，`agentId` / `reason` / `instruction?` | 是，session journal |
| `compaction.completed` | `agentId` | 是 |
| `compaction.cancelled` | `agentId` / `cause` / `errorMessage?` | 是 |
| `compaction.blocked` | 机器事件，经 `onEvent` 回调 | 否 |

```ts
session.on(interaction, 'interaction.requested', (event) => {
  session.resolve(InteractionRef).respond(event.interaction.id, response);
});
```

迟到订阅者先 `findAll({ resolved: false })` 补齐在订阅之前发出的请求，再开始听新事件。

## 机器：`AgentEmitted`（`agent.on`）

### 回合

| type | 要点 |
|---|---|
| `turn.started` | `turnId` / `branchId` / `queueItemId?` / `entry?`（原始提交，gate 前）；进入 `running` 立即发，先于 prompt 落盘与 gate |
| `turn.prompt_committed` | `turnId` / `entry`（gate 通过后，可能被改写；被拦截时为原始 entry）；同时刻落 `message.appended` |
| `step.started` | `step`，每个 LLM 请求一次 |
| `turn.spawn_tools` | `toolCalls` |
| `turn.drained` | `messages`：本步 drain 进 history 的 notify / reminder |
| `turn.aborting` | 已发 abort，还在等 turn 收尾 |
| `turn.compaction_requested` | `turnId` / `reason: 'budget' \| 'overflow'` / `history`（turn 内存历史）；turn 进 `compacting` 悬停，等调用方经 `contextReset` 回应 |
| `turn.done` | `turnId` / `outcome: TurnOutcome`（`done`，或 `failed` 带 `failure: TurnFailure`——`max_steps` 或 `{ reason: 'error', error }`，或 `aborted`）/ `messages`（整段 history）/ `branchId` |
| `context.reset` | `messages`（整段新 history）/ `reason?` / `instruction?` / `stats?`；`input.context_reset` 落账回执，AgentUnit 据此写 agent journal 单条 `context.reset` |
| `prompt.blocked` | `reason: 'gate' \| 'error'`；turn 已 `turn.started`，原始 prompt 已落 history，turn 随即以 `failed` 收尾 |
| `prompt.submitted` | `entry`，`submit` 的接收回执 |
| `prompt.notified` | `entry`，`notify` 的接收回执 |
| `prompt.reminded` | `entry`，`remind` 的接收回执 |
| `prompt.cancelled` | `id` / `cancelled`，没命中 queue 也发（`cancelled: false`） |
| `prompt.steered` | `ids`（请求的）/ `queueItemIds` / `entries`；空命中也发 |
| `agent.paused` / `agent.continued` | `pause` / `continue` 的接收回执 |
| `agent.aborted` | `abort` 的接收回执；idle / 已在 aborting 也发 |
| `agent.failed` | 机器级失败 |

`agent.on('turn.done')` 会等到 journal 这次写入链结束；`agent.wait(type, { match, timeoutMs, signal })` 是同语义的 Promise 化，超时或中止即 reject。

### LLM

| type | 要点 |
|---|---|
| `llm.started` | 一次 `runLlmRequest` 开始（policy 循环入口） |
| `llm.streaming.headers` | `headers` |
| `llm.streaming.part` | `part`，增量，**不**进节点事件 |
| `llm.streaming.usage` | `usage` |
| `llm.streaming.finish` | `finish` |
| `llm.streaming.message_id` | `messageId` |
| `llm.notice` | `notice { source, code, message, data? }`：resolver / encode 的旁路提示（如 store-ref resolver 的 `media-budget-exceeded`） |
| `llm.retrying` | `reason: 'backoff'`（`failedAttempt` / `nextAttempt` / `maxAttempts` / `delayMs` / `error`）或 `reason: 'recovery'`（`strategy` / `action` / `error`） |
| `llm.done` | turn 级：带完整 `entry: AssistantEntry`（已进 turn history） |
| `llm.ended` | `outcome`：只在 failed / aborted 时外发（done 被 turn 译成 `llm.done`；`context_overflow` 失败被吸收进 `compacting` 不外发）。failed 带 `error` / `rawError?`；aborted 可能带 salvage `message` |

### Tool

| type | 要点 |
|---|---|
| `tool.update` | `toolCallId` / `update: { key, text, percent? }` |
| `tool.detached` | 转后台，`text` 是 ack，`toolCall` 是最终（before 改写后）调用 |
| `tool.done` | `outcome: ToolOutput`——`succeeded { result }` / `failed { error }` / `aborted { reason? }` |

后台 tool 的 `tool.done`（含 aborted）会再变成一条 `source: 'async-tool'` 的 notification，下一回合 drain 进 history。

## 机器输入（只给 `send`，不是订阅面）

`input.submit` / `notify` / `remind` / `steer` / `cancel` / `abort` / `abort_tool` / `pause` / `continue` / `context_reset` / `close`。宿主用 `AgentCommands` 的同名方法：方法内部先订回执再 `send`（同步派发），同步把上表对应回执 `return` 出来，type 由命令面封装；actor 未运行（done / stopped / unmounted）时返回 `undefined`。例外是 `abortTool`——无回执（fire-and-forget），结果经 `tool.done` 的 `aborted` outcome（带 `reason`）体现。`contextReset({ messages, … })` 以 `context.reset` emit 为回执（idle 时只替换机器 `messages`；running 时同时转发 `turn.compaction_finished` 给悬停在 `compacting` 的 turn），携 `error` 回应失败时无回执、直接送 turn 失败收场。`setModel` / `setEndpoint` / `setRequester` 也在命令面上，但不进机器，仍是同步。

## 相关文档

- 状态机走位 → [agent-machine](../explanation/agent-machine.md)
- 事件直接消费还是以状态提供 → [event-consumption](../explanation/event-consumption.md)
- 报文 → [HistoryMessage 与 Delta](history-message.md)
- 命令与两个 `on` → [01](../how-to-guides/01-run-a-turn.md)
- 写一个会自动压上下文的 Feature → [03](../how-to-guides/03-listen-and-trigger.md)
- Feature 如何 `fire` → [08](../how-to-guides/08-develop-feature.md)
