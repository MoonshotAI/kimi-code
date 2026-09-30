# 事件消费模型

一个事件该被外部直接消费，还是该以状态形式提供？这不是风格问题，由事件本身的性质唯一确定。本文给出三种消费模型、四个判别维度，以及它们在本架构事件面上的落法。

## 三种消费模型

**1. 内容流（append-only log）——消费者要事件本身。** 事件载荷就是产品内容（消息文本、工具调用、流式增量），丢一条就是丢内容，无法从任何状态重算；"状态"（完整 transcript）只是事件流的重放结果。消费者处理的是**经过**，不是**当前**。协议形态：事件流 + offset 续传（断线从 seq N 重放，不需要快照对账）。例：`message.appended`、`turn.*`、`step.*`、`shell.output`。

**2. 实体集状态（entity-set）——消费者要"当前这个集合"。** 事件有价值的部分是造成的那个结果（roster 多了一条），不是事件本身；且丢一条消费者的模型就永久发散、无法自愈。协议形态：快照 + 变更通知（K8s list-watch 是教科书形态：先 LIST 拿全量，再 WATCH 拿增量，事件带 revision 供对账）。事件只当"去重读状态"的触发器，raw 事件流反而是次品。例：roster（有几个 agent）、session catalog、`session.meta_updated` 的 title / metadata。

**3. 派生状态（computed projection）——消费者要一个算出来的小视图。** 关心的是跨事件计算的结果，不是任何单条事件。协议形态：当前值 + 变更通知；内部可以用事件驱动计算，对外只暴露状态读。例：`session.status()` 的 `busy` / `mainTurnActive` / `lastTurnReason`。

判别三问：事件载荷本身是不是用户要消费的内容？消费者渲染"经过"还是查询"当前"？关心的是"集合里有什么"还是"算出来是什么"？

## 四个判别维度

**① 时间信号是否必要（沿 / 电平）。** 检验：连续两次同类变化、中间状态恰好不变时，第二次发生是否仍各自有意义？两个 turn 背靠背，`busy` 电平不变，但两次 `turn.ended` 各自都要驱动结算与收尾——沿是必要的，必须事件递送；title A→B→C，消费者只显示当前值，B 这次"发生"毫无意义——电平足够。注意沿不能伪装成电平：`busy: false→true` 看似能推出 `turn.started`，但只在每次变化必达且中间态不塌缩时成立。

**② fold 的形状（一维覆盖 / 二维追加）。** 检验：旧事件会不会被新事件"作废"？title B 一到 title A 就死、`agent.switched` 覆盖登记的 branch——时间维塌缩，投影是物化视图，断线恢复用快照对账；`message.appended` 第 1 条在第 100 条之后仍是活内容——实体维 × 时间维都活，投影就是日志本身，恢复必须 offset 重放。中间态如 `todo.updated`：内容型载荷 + 一维折叠（每条自包含、漏一条下一条自愈），所以上网毫无争议。

**③ 源头还是镜像。** 事件是事实的权威源头，还是某个上游状态的派生镜像？镜像事件永远滞后、永远可能与源头不一致——**事实广播，镜像只以状态查询的形式提供**。`agent.created` 是源头（登记动作即事实）；`busy` 是镜像，所以不落任何事件，`session.status()` 从活机器现读。

**④ 幂等与顺序敏感。** 追加型事件顺序即语义，通道要恰好一次 + seq 检测；状态型通知天然幂等，重读即愈，at-least-once 即可。可靠性预算只该花在二维追加上。

## 落到本架构

| | turn / message / step | roster / meta | busy / lastTurnReason |
|---|---|---|---|
| 沿必要？ | 必要（每次发生都算数） | 不必要 | 不必要 |
| fold 形状 | 二维追加 | 一维覆盖（per key） | 一维归并 |
| 源头 / 镜像 | 源头 | 源头 | 镜像 → 状态查询 |
| 漏一条 | 少内容 | 模型发散 | 下条自愈 |
| 协议 | 事件流 + offset | 快照 + 通知 | 状态读 + 通知 |

- agent journal 是内容流：AgentUnit 的 `onCommit → node.fire` blanket 桥天然无损，WS 原样转发，TUI 直接渲染。
- session journal 只留 durable 事实（`session.created` / `agent.created` / `agent.switched` / `session.meta_updated` patch）：同构桥上节点面，但消费者保持实体集姿态——收到通知读折叠值 / 快照，不逐条累加。
- 瞬态运行时切片不落 journal：work fold 账（`agent.turn_started` 等镜像事件）已删，`status()` 现读活机器 snapshot。
- `agent.created` 四个维度全在右列：它的正确形态是"快照服务 + 对账触发器"，永远不会是消费主通道。

自检口诀：**漏了这条事件会怎样？** 少一段内容 → 事件流；模型永久错 → 状态 + 触发；下次重算 → 派生状态 + 通知。

## 相关文档

- 事件清单与字段 → [events](../reference/events.md)
- Store 模型（事实与投影） → [store-model](store-model.md)
- 两套事件面 → [overview](overview.md)
