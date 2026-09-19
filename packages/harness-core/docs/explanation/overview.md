# Harness 总览

`@moonshot-ai/harness-core` 在 `@moonshot-ai/agent-core` 上实现产品能力。它不是第二套 kernel、Store 或 LLM。宿主同时依赖两个包：

- agent-core：`mountApp`、Unit / Store / LLM / agent-machine、`createFeature`、`waitFor`、`createMedia`、`providerCatalog`
- harness-core：`SessionSpace`、产品 Feature 名单、HTTP Feature

```text
kimi-code / 其它宿主
        │
        ▼
  harness-core          agent-core
  mountApp        →     AppUnit → SessionUnit → AgentUnit
  features/*            createFeature / 贡献 hook
  host/session-space    stores/ + store/
  feature-http          agent-machine / llm / kernel
```

## 产品树

三层 Unit，各层一个 Feature slot：

| 节点 | 职责 | 打开方式 |
|---|---|---|
| App | 活 session 表、运行时装卸 Feature、解析 App 级 token | `mountApp` |
| Session | catalog 之外的活容器：agent 表、session journal、blobs、Interaction | `createOpenedSession` |
| Agent | 一台 store-free 机器 + 一份 agent journal；slot ready 后 `actor.start()` | `session.create` 或 `provideSession` 的 agent 模板 |

Feature 不是第四棵树。`createFeature('name', { app?, session?, agent? })` 的 slot 挂进对应产品节点，卸载随节点撤回。

## 两套事件面

这是读后续文档时必须先立住的边界：

| 面 | 从哪来 | 怎么订 | 落不落盘 |
|---|---|---|---|
| 节点事件 | Store `onCommit` 后 `node.fire`，以及 Feature `useFire` | `app.on` / `session.on`，可带 `on(feature, type)` | agent / session journal 里的已提交事件会落盘；Interaction 的 `fire` 是现场事件 |
| 机器事件 | XState `emit` / 转发 | `agent.on` | 不落盘。`AgentUnit` 把其中一部分译成 journal 事件 |

对外 UI / CLI / HTTP 默认只消费节点事件。要看 streaming delta、retry、tool 中间态，才订 `agent.on`。

## 写与读的入口

- 绑 generate：`agent.setConfig` / `setCredentialProvider` / `setRequester`（不进机器、不落盘；Feature 用 `useAgent()` 上的同名方法）
- 写回合：`agent.submit` / `notify` / `remind` / `steer` / `cancel` / `abort` / `pause` / `continue`（步骤见 [01](../how-to-guides/01-run-a-turn.md)）
- 写 Feature 状态：Feature 自己 `useAgentStore().dispatch` 或 `useSessionStore().dispatch`，事件进同一份 journal，`decodeAgent` 不认识的 type 原样留下
- 读 facade：`handle.resolve(TodoRef)`，不要 `node.resolve`，不要 `featureHost.get`
- 读活表：`app.get(sessionId)` / `session.get(agentId)` 是同步活表，不是 catalog ensure-open

## 相关文档

- 外部操作 → [01](../how-to-guides/01-run-a-turn.md)
- 写 Feature → [feature-model](feature-model.md) · [02](../how-to-guides/02-add-todo-feature.md) · [08](../how-to-guides/08-develop-feature.md)
- 状态机与事件 → [agent-machine](agent-machine.md) · [events](../reference/events.md)
