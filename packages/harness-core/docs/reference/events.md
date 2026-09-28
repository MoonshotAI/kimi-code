# 事件

两套面，按载荷选订阅 API：

| 面 | 订阅 | 载荷类型 | 何时出现 |
|---|---|---|---|
| 节点 | `app.on` / `session.on` / `app.wait` / `session.wait` | 已提交的 journal 事件，或 Feature `fire` | `store.onCommit` 之后，或 `useFire()` |
| 机器 | `agent.on` | `AgentEmitted` | 机器 `emit` / 转发，不落盘 |

`on(type, handler)` 的开放字符串仍是 `RuntimeEvent`。带 Feature 泛型：`on(feature, type)`；`on(feature, '*')` 只收 `featureName.` 前缀。`wait` 是 `on` 的 Promise 对偶，overload 相同，只等之后发生的事件，卸载时拒绝。

## 节点：agent journal（`AgentLogEvent`）

`packages/agent-core/src/stores/agent.ts`。`decodeAgent` 认识这四个；其它 type 留给 Feature。

| type | 字段 | 谁写 |
|---|---|---|
| `message.appended` | `message: HistoryMessage` | `llm.done` 立刻写 assistant；`turn.drained` 再写本步 tool / drain |
| `turn.started` | `turnId`，`queueItemId?` | 进入 `running` |
| `turn.ended` | `turnId`，`outcome: 'done' \| 'failed' \| 'aborted'`，`errorMessage?` | turn 终态 |
| `input.submitted` | `entry: UserEntry` | 投影认识，当前 `AgentUnit.submit` **不写** |

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

`packages/agent-core/src/stores/session.ts`。

| type | 字段 | 谁写 |
|---|---|---|
| `agent.opened` | `agentId`，`branch`，`features?`，`source?` | `SessionStores.open` 首次登记 |
| `agent.closed` | `agentId` | `SessionStores.close` |
| `agent.switched` | `agentId`，`branch`，`reason?`，`stats?` | `undo` / `switchBranch` |
| `session.meta_updated` | `meta` | `app.open` 写 catalog 记录；`app.updateSession` |

## 节点：Feature

| type | 所有者 | 是否落盘 |
|---|---|---|
| `interaction.requested` | `interaction`，字段 `interaction` | 否，`useFire` |
| `interaction.resolved` | `interaction`，字段 `id` / `response` / `interaction` | 否 |
| `todo.updated` | todo 投影，字段 `todos` / `lastWriteTurn` | 是，agent journal |
| `compaction.started` | compaction，`agentId` / `reason` / `instruction?` | 是，session journal |
| `compaction.completed` | `agentId` / `branch` | 是 |
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
| `turn.started` | `turnId` / `branchId` / `queueItemId?` / `entry?` |
| `step.started` | `step`，每个 LLM 请求一次 |
| `turn.spawn_tools` | `toolCalls` |
| `turn.drained` | `messages`：本步 drain 进 history 的 notify / reminder |
| `turn.aborting` | 已发 abort，还在等 turn 收尾 |
| `turn.done` | `messages`（整段 history）/ `branchId` |
| `turn.failed` | `failure: TurnFailure`（`max_steps` 或 `{ reason: 'error', error }`） |
| `turn.aborted` | 用户 / scope abort |
| `prompt.blocked` | `reason: 'gate' \| 'error'` |
| `prompt.submitted` | `entry`，`submit` 的接收回执 |
| `prompt.notified` | `entry`，`notify` 的接收回执 |
| `prompt.reminded` | `key` / `entry`，`remind` 的接收回执 |
| `prompt.cancelled` | `id` / `cancelled`，没命中 queue 也发（`cancelled: false`） |
| `prompt.steered` | `ids`（请求的）/ `queueItemIds` / `entries`；空命中也发 |
| `agent.paused` / `agent.continued` | `pause` / `continue` 的接收回执 |
| `agent.aborted` | `abort` 的接收回执；idle / 已在 aborting 也发 |
| `agent.failed` | 机器级失败 |

`agent.on('turn.done'|'turn.failed'|'turn.aborted')` 会等到 journal 这次写入链结束。

### LLM

| type | 要点 |
|---|---|
| `llm.sent` | 请求已发出 |
| `llm.streaming.headers` | `headers` |
| `llm.streaming.part` | `part`，增量，**不**进节点事件 |
| `llm.streaming.usage` | `usage` |
| `llm.streaming.finish` | `finish` |
| `llm.streaming.message_id` | `messageId` |
| `llm.done` | 机器侧带完整 `entry: AssistantEntry`（已进 turn history） |
| `llm.aborted` | 流被 abort，可能带 salvage message |
| `llm.failed.syntax` | 本地编解码 / 空响应 |
| `llm.failed.remote` | 远端错误，`rawError?` |
| `llm.retrying` | `failedAttempt` / `nextAttempt` / `delayMs` / `error` |
| `llm.recovering` | `strategy` / `action` / `error` |

### Tool

| type | 要点 |
|---|---|
| `tool.update` | `toolCallId` / `update: { key, text, percent? }` |
| `tool.detached` | 转后台，`text` 是 ack |
| `tool.done` | `result: ToolResult` |
| `tool.failed` | `error` |
| `tool.aborted` | abort |

后台 tool 的 `tool.done` / `tool.failed` 会再变成一条 `source: 'async-tool'` 的 notification，下一回合 drain 进 history。

## 机器输入（只给 `send`，不是订阅面）

`input.submit` / `notify` / `remind` / `steer` / `cancel` / `abort` / `pause` / `continue` / `close`。宿主用 `AgentCommands` 的同名方法：方法内部先订回执再 `send`（同步派发），同步把上表对应回执 `return` 出来，type 由命令面封装；actor 未运行（done / stopped / unmounted）时返回 `undefined`。`setConfig` / `setCredentialProvider` / `setRequester` 也在命令面上，但不进机器，仍是同步。

## 相关文档

- 状态机走位 → [agent-machine](../explanation/agent-machine.md)
- 报文 → [HistoryMessage 与 Delta](history-message.md)
- 命令与两个 `on` → [01](../how-to-guides/01-run-a-turn.md)
- 写一个会自动压上下文的 Feature → [03](../how-to-guides/03-listen-and-trigger.md)
- Feature 如何 `fire` → [08](../how-to-guides/08-develop-feature.md)
