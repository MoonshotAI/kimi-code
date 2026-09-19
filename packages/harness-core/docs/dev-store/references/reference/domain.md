# domain：领域投影与事件解码

源码：`doing/refact-237-09-16-human-domain-features/packages/agent-core-v2/src/store-v2/domain.ts`

连接 store-v2 内核与 237 真实事件的适配层。事件统一表示为 `DomainRecord`（扁平 `{ type, time?, ... }`，即 wire record 形状）。

## 两套事件词汇，拒绝交叉解码

- **v2 Event2**（class 实例）：`ContextAppendMessage`、`ContextClear`、`TurnStarted`、`TurnEnded`、`ToolsUpdateStore`、`UsageRecord`。`decodeV2(record)` 按 `type`/`aliases` 找到 class 并经 `event2FromRecord` 还原。
- **human plain event**（factory + zod）：`inputSubmitted`、`inputCancelled`、`queueDrained`、`messageAppended`、`turnStarted`、`turnEnded`、`stateUpdated`。`decodeHuman(record)` 要求无 `agentId` 字段（v2 事件带 `agentId`，借此拒绝交叉），再经 factory schema 校验。
- 两边都有 `turn.started`，payload 与语义不同：互相喂会被显式拒绝（`Not a human plain event` / `Invalid v2 event`）。同一 store 内核可以服务两套词汇，但**不要混用**。

## 现成 projection

| 工厂 | 状态 | 消费事件 |
|---|---|---|
| `conversation<C>()` | `readonly ContextMessage[]` | `ContextAppendMessage`（追加）、`ContextClear`（清空） |
| `todos<C>()` | `readonly TodoItem[]` | `ToolsUpdateStore` 且 `key === 'todo'` |
| `usage<C>()` | `UsageState`（byModel 累计） | `UsageRecord`；复用生产代码 `usageKey` 的 fold（immer） |
| `turns<C>()` | `TurnIndex<C>`（`{ turns: { turnId, start, end? }[], nextTurnId }`） | `TurnStarted`/`TurnEnded`，start/end 记录 cursor |
| `human<C>()` | `HumanState<C>`（`{ history, queue, todo, turnIndex }`） | human 事件；内部复用真实 `historySlice`/`queueSlice`/`todoSlice` reducer |

要点：

- `usage()` 的 fold 来自 `#/agent/usage/usageOps` 的生产实现，不是重写；reducer 内的 effect/checkpoint 能力被显式禁用（重放语义）。
- `human()` 的 turnIndex 与 `turns()` 同构，但消费 human 的 `turnStarted`/`turnEnded`。
- 典型组合见 [composition](composition.md)：context/todo 包 `withHistory`，usage/turns 不包。

## fixture（实验数据，待拆分）

`fixtureAgentId` / `fixtureModel` / `fixtureTime`、`turnEvents(turnId)`（v2 两个 turn 各 6 条事件，经真实 constructor + `serialize()` 生成）、`humanTurnEvents(turnId)`（human 两个 turn，含 submit/cancel/drain/todo/usage 覆盖）。这些是实验 fixture，**不是产品 API**；真实消费者落地时应拆到测试侧。
