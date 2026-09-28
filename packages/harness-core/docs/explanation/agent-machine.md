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
 ├── acting.{running | aborting}  等本步 tool
 └── draining        向 agent 要 notify / reminder
     → gating | done | failed | aborted

tool
 ├── preparing       useBeforeTool
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
| `reminders` | `remind(key)` | 按 key 覆盖。同样等到 drain 才进 history |

queue 存在是因为用户输入必须能排队、能撤、能并，而且不能堵住当前 LLM / tool。活着的 queue 在机器 context；`AgentUnit.submit` 目前不写 `input.submitted`，所以投影里的 queue 跨重启是空的。

`steer` 是「把还没开跑的若干 queue 项收成一条 notification」。`cancel` 只删还在 queue 里的；已经 `running` 的那条要用 `abort`。

## Agent：何时开回合

根状态 `idle` / `running` / `closing`。`idle` 里再分：

| 子状态 | 含义 |
|---|---|
| `ready` | 没事做，或马上要走 always |
| `gating` | 队列头有 user prompt，且装了 `promptGate`，先跑 gate |
| `waiting` | 没有待处理 prompt，但有后台 tool（`detach` 出去的） |

`ready` 的 always：

1. 有 gate 且 queue 非空且未 pause → `gating`
2. `notifications` 或 `queue` 非空且未 pause → 进入 `running`，并把 pending 提交进 history
3. 只有后台 tool → `waiting`

`gating` 通过则同样 commit pending 再进 `running`；block / 抛错发 `prompt.blocked` 并丢掉队头，回到 `ready`。

`input.submit` 进 queue（追踪的用户输入）。`input.notify` 进 notifications（不占 prompt 队列）。`input.remind` 按 key 覆盖 reminder。`input.steer` 把若干 queued prompt 合成一条 notification。`input.cancel` 按 `promptId` 从 queue 删除。这些在 idle 和 running 都能收。

`input.pause` 只立 `paused`；running 时同时 `turn.pause`。`input.continue` 清 pause；若 history 停在半截 tool chain（最后一条是 tool，或 assistant 带 toolCalls）且没有 pending，会直接再进 `running`。

`input.close`（卸载）进 `closing`，abort scope 与 turn tools，然后 `disposed`。

## Running：一个 turn

进入 `running` 时：

- `activeTurnId = turnId`，发机器事件 `turn.started`
- invoke `turnActor`，输入是当前 `messages`；`config` / 凭证 / 传输活读命令面上的值
- 离开时 abort/stop 本 turn 的 tool actor，`turnId += 1`

turn 内部一步是「LLM →（可选）工具 → drain」。

**gating**：有 `onBeforeStep`（含 Feature 的 `useBeforeStep`）就先跑。compaction 在这里超预算会抛错，turn 直接 `failed`。

**streaming.requesting**：调 `runLlmRequest`。policy（resolver / recovery / retry / media）在 actor 里，turn 没有 retrying 状态。流式事件原样转给 agent。`llm.done` 时：

- 已把这一条 assistant **写入 turn history**，再发给父机（同一对象）
- 有 toolCalls → `acting`，否则 → `done`

**acting**：向 agent 发 `turn.spawn_tools`。agent 为每个 call spawn `toolActor`。tool `done` / `failed` / `aborted` / `detached` 记入 outcomes；齐了就 `draining`。`detach` 把 actor 从 turnTools 挪到 `background`，turn 只收一条 ack 文案，真正完成以后当 notification 回来。

**draining**：向 agent 发 `turn.drain`。agent **必回** `agent.notify`（没有 pending 也回空数组），并 emit `turn.drained`。然后：

- pause → turn `done`
- 空 notify 且超过 `maxSteps` → `failed`（`TurnFailure.reason = 'max_steps'`）
- 否则回到 `gating` 开下一步（有 notify 则 steps 重置为 1）

turn 结束（`done` / `failed` / `aborted`）后 agent 回到 `idle`，并 emit `turn.done` | `turn.failed` | `turn.aborted`。

## Tool

`preparing` 跑 `useBeforeTool`：可改 `toolCall`，或 `denied` 带一条假结果。`executing` 调 `tool.execute`；`onUpdate` → `tool.update`，`detach(text)` → `tool.detached`。`finishing` 跑 `useAfterTool`（deny 路径也跑）。未知工具名由 `bindAgentLogics` 收成文本结果，不抛。

## AgentUnit 怎么把机器变成 journal

`useMachine({ fire: false })`。节点不转发 streaming。`bindAgentLog` 听机器，往 `AgentStore.dispatch`：

| 机器事件 | 写入 |
|---|---|
| `llm.done` | 立刻 `message.appended`（这一步的 assistant） |
| `turn.drained` | 把 turn history 里新出现的 tool / drain 消息 `message.appended` |
| `turn.started` | `turn.started`（`turnId` / `queueItemId`） |
| `turn.done` / `failed` / `aborted` | `turn.ended`（`outcome` / `errorMessage`） |

`store.onCommit` 之后 `node.fire(entry.event)`。所以 `session.on('message.appended')` 看到的是已落盘对象。一个 turn 可以有多条 `message.appended`，不是整 turn 一条。

`agent.submit` / `notify` / `remind` / `cancel` / `steer` / `abort` / `pause` / `continue` 是 XState `send` 的同步封装：先订对应 `emit`，再 `send`（同步派发），把回执事件同步返回；actor 未运行（done / stopped / unmounted）时返回 `undefined`。`submit` **不**写 `input.submitted`。投影里的 queue 字段因此跨重启是空的；活着的 queue 在机器 context 里。并发 `submit` 用 entry 对象身份匹配回执；`steer` 用请求的 `ids`。每一条命令路径都必须 `emit`，否则回执为 `undefined`。

`agent.on('turn.done'|'turn.failed'|'turn.aborted')` 会等到这次 dispatch 链 `settled` 再回调，避免 UI 先于 journal。

## 相关文档

- 事件字段 → [events](../reference/events.md)
- 报文 → [HistoryMessage 与 Delta](../reference/history-message.md)
- 跑一个 turn → [01](../how-to-guides/01-run-a-turn.md)
- XState 钩子时序 → [lifecycle-model](lifecycle-model.md)
