# 产品投影

源码：`packages/agent-core/src/stores/agent.ts`、`stores/session.ts`。没有 v2 `Event2` class、没有 `decodeV2` / `decodeHuman`、没有 `conversation()` / `human()` 工厂。journal 记录就是领域事件。

## Agent：`agent<C>()` / `decodeAgent`

状态 `AgentLogState`：`history` / `queue` / `notifications` / `reminders` / `turnIndex`。

| 事件 | reduce |
|---|---|
| `message.appended` | `history` 追加 |
| `input.submitted` | `queue` 追加（当前 Unit 不写这条） |
| `turn.started` / `turn.ended` | `turnIndex` 记 start/end cursor，`nextTurnId` |

`notifications` / `reminders` 投影目前恒为空数组，不 fold。todo 的 stale nudge 只活在当前进程。

`decodeAgent` 遇到带 `agentId` 的记录抛错（那是 session 事件）。不认识的 type 返回 `undefined`，`agent()` 原样跳过——Feature 用 `fold` 自己认。

`openAgentStore(journal)` = `openStore({ journal, projection: agent() })`。

## Session：`session<C>()` / `decodeSession`

状态：`roster.agents`（agentId → branch 名 + `features?` + `source?` 创建者标记）、`sessionMeta.value`。

| 事件 | reduce |
|---|---|
| `agent.opened` / `agent.switched` | 登记 branch（switched 保留 features/source） |
| `agent.closed` | 保留 roster 条目 |
| `session.meta_updated` | 覆盖 `sessionMeta` |

catalog（title / workspaceId）在 `SessionSpace`，旁路 `meta.json`。活 session 的同一份记录也会 `dispatch` 进 session journal。

## Feature 投影

跟 agent journal 共用一条日志，例如 todo 的 `todos` 投影认 `todo.updated` 与 `turn.started`。compaction 把 `compaction.started|completed|cancelled` 写进 **session** journal，不改 `sessionTypes`。

组合：需要 undo 视图的投影再包 `withHistory`；累计事实（usage 若改成 fold）默认读完整历史。见 [composition](composition.md)。

## 相关文档

- 事件字段 → [events](events.md)
- Store 模型 → [store-model](../explanation/store-model.md)
- Feature 怎么 fold → [02](../how-to-guides/02-add-todo-feature.md) · [08](../how-to-guides/08-develop-feature.md)
