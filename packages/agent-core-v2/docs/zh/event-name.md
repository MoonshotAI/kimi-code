# 状态机命名规范

agent-core-v2 各 XState 状态机中状态、事件、action、guard、被 invoke actor 的命名约定。源自 XState 官方命名指导（Stately《State Machines — What's in a name?》）与消息驱动架构惯例（命令用祈使动词、事件用过去分词），并结合本仓库 actor 树的语义做了调整。

## 事件：三类

按**接收方拿事件做什么**分类，而不是按是否携带 payload。

1. **命令 —— 动词原形**。要求接收方做事。例：`input.submit`、`input.steer`、`input.abort`、`input.remind`、`tool.abort`、`turn.abort`、`turn.drain`、`turn.notify`、`turn.spawn_tools`、`context.reset`。
2. **事实 —— 过去分词**。报告某事已发生，通常驱动转移或父级记账。例：`llm.sent`、`llm.done`、`llm.failed.syntax`、`llm.failed.remote`、`llm.retrying`、`llm.recovering`、`tool.done`、`tool.failed`、`tool.aborted`、`tool.detached`、`turn.reminders_consumed`、`todo.used`。emitted 事件天然是事实：`turn.started`、`turn.done`、`turn.failed`、`turn.aborted`、`turn.aborting`、`agent.created`、`agent.forked`、`agent.switched`、`agent.stopped`、`agent.failed`、`usage.updated`。
3. **数据流 —— 名词（即数据名）**。把一份流式数据送达，接收方累积或转发。归入 `streaming` 子命名空间：`llm.streaming.part`、`llm.streaming.headers`、`llm.streaming.usage`、`llm.streaming.finish`、`llm.streaming.message_id`；另有 `tool.update`、`usage.record`。

判别示例：`llm.streaming.finish` 携带完成元数据喂给累加器（数据流，名词），而 `llm.done` 是无 payload 的流终止哨兵、驱动转移（事实，过去分词）。

## 拼写

- `dot.case` 命名空间：`<域>.<名>` —— `llm.*`、`tool.*`、`turn.*`、`input.*`、`agent.*`、`usage.*`、`context.*`、`todo.*`、`cron.*`、`goal.*`、`reminder.*`、`dateChange.*`、`interaction.*`、`runtime.*`。
- 多词段用 `snake_case`：`turn.spawn_tools`、`turn.reminders_consumed`、`llm.streaming.message_id`。段内禁止 kebab-case 与 camelCase。
- 数据流事件归入 `streaming` 子命名空间：类别在事件名上直接可读，且一条通配声明（`'llm.streaming.*'`）即可处理或转发整组。
- 保留前缀，用户事件不得占用：`xstate.*`（框架内置）与 `@xstate.*`（inspection 事件）。

## 状态、action、guard、actor

- **状态**：名词、形容词或动名词 —— `idle`、`running`、`active`、`thinking`、`acting`、`draining`、`preparing`、`executing`、`finishing`、`succeeded`、`failed`、`aborted`。
- **命名 action**：动词短语 —— `forwardToParent`、`spawnTurnTools`、`abortTurnTools`。
- **命名 guard**：形容词、过去分词或布尔短语 —— `isLoggedIn` 风格。
- **被 invoke 的 actor**：名词短语 —— `requestActor`、`executeActor`、`preparingActor`、`finishingActor`、`cronEffects`。

## 一致性

同类元素全库只用一种风格。新增事件时先定类别（命令 / 事实 / 数据流），再按上述规则拼写；向已有 `streaming` 子命名空间的事件族新增数据流事件时，放入该命名空间。
