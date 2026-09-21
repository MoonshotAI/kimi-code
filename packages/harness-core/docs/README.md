# Harness Core 文档

`@moonshot-ai/harness-core` 是 agent-core 之上的产品层：用 `createFeature` 装配能力，用 `mountApp` 开出可操作的实例。本文档按 [Diátaxis](https://diataxis.fr/) 组织。how-to 按编号读：1–7 是产品路径，8 起是未编进该路径的原语指南。

先读源码再写代码。导入以当前包入口为准：产品符号从 `@moonshot-ai/agent-core` / `@moonshot-ai/harness-core` 取；Unit 原语从 `@moonshot-ai/agent-core/kernel/index` 取。

## How-to guides

### 产品路径

| # | 你要做什么 | 文档 | 配套 |
|---|---|---|---|
| 1 | 最小 `mountApp` + builtin SDK + 已知模型 API，跑完一个 turn | [启动最小 App 并跑完一个 turn](how-to-guides/01-run-a-turn.md) | [HistoryMessage 与 Delta](reference/history-message.md) · [队列与状态机](explanation/agent-machine.md) |
| 2 | 添加 Todo Feature（store / reminder / tool） | [添加一个 Todo Feature](how-to-guides/02-add-todo-feature.md) | [Store 模型](explanation/store-model.md) · [扩展点](reference/contribution-hooks.md) |
| 3 | 从头写 compact Feature（听机器事件、自动压上下文） | [写一个会自动压上下文的 Feature](how-to-guides/03-listen-and-trigger.md) | [事件表](reference/events.md) |
| 4 | 把 Feature facade 暴露给宿主 | [把 Feature 的 facade 暴露出去](how-to-guides/04-expose-facade.md) | |
| 5 | 可后台的 Tool + builtin WaitFor | [写一个可以后台的 Tool](how-to-guides/05-background-tool.md) | |
| 6 | Bash：查看执行中的工具，手动 detach | [引入 Bash](how-to-guides/06-bash-and-detach.md) | |
| 7 | 使用 builtin provider-catalog | [使用 provider-catalog](how-to-guides/07-use-provider-catalog.md) | [catalog 为什么是 Feature](explanation/provider-catalog.md) |

### 其余

| # | 文档 |
|---|---|
| 8 | [开发一个 Feature](how-to-guides/08-develop-feature.md) |
| 9 | [宿主启动 Unit 树](how-to-guides/09-bootstrap.md) |
| 10 | [异步初始化门控](how-to-guides/10-async-initialization.md) |
| 11 | [兄弟共享状态](how-to-guides/11-sibling-state.md) |
| 12 | [兄弟即时事件](how-to-guides/12-sibling-events.md) |
| 13 | [按 Feature 挂卸载路由](how-to-guides/13-feature-gated-routes.md) |
| 14 | [安装 createMedia](how-to-guides/14-install-media.md) |
| 15 | [绑定 Provider 并发一次 LLM 请求](how-to-guides/15-run-llm-request.md) |
| 16 | [非响应式资源清理](how-to-guides/16-cleanup-resources.md) |
| 17 | [Store 操作配方](how-to-guides/17-recipes.md) |
| 18 | [XState 钩子](how-to-guides/18-hooks.md) |
| 19 | [fromCallback](how-to-guides/19-from-callback.md) |

HTTP 装配见 [getting-started](getting-started.md)。

## Explanation

- [总览](explanation/overview.md)：包边界、产品树、两套事件面。
- [Feature 模型](explanation/feature-model.md)：三层 slot、贡献面、token、跨 Feature 协作。
- [Agent 状态机](explanation/agent-machine.md)：队列的目的；idle / running / turn / tool。
- [provider-catalog](explanation/provider-catalog.md)：目录为什么是 app Feature。
- [Unit 树与 EffectScope](explanation/unit-tree.md)：节点、scope、资源归属。
- [Store 模型](explanation/store-model.md)：事件是事实，状态是投影；Feature 怎么写投影。
- [XState 生命周期](explanation/lifecycle-model.md)：macrostep、entry/invoke、onDone 是转移。

## Reference

| 主题 | 文档 |
|---|---|
| 源码地图与导入 | [source-map](reference/source-map.md) |
| HistoryMessage / Delta | [history-message](reference/history-message.md) |
| 持久化事件与机器事件 | [events](reference/events.md) |
| Feature 贡献 hook（扩展点） | [contribution-hooks](reference/contribution-hooks.md) |
| setup 调用边界 | [setup-context](reference/setup-context.md) |
| 命名：`use*` 与实例 `get` | [naming](reference/naming.md) |
| `createUnit` / `mountRoot` | [create-unit](reference/create-unit.md) · [mount-root](reference/mount-root.md) |
| `useNode` / `useReady` / Handle | [use-node](reference/use-node.md) · [use-ready](reference/use-ready.md) · [node-handle](reference/node-handle.md) |
| `provide` / `inject` / `useExpose` | [provide](reference/provide.md) · [inject](reference/inject.md) · [use-expose](reference/use-expose.md) |
| `useFire` / `useOn` | [use-fire](reference/use-fire.md) · [use-on](reference/use-on.md) |
| `useContribute` / `useCollection` / `useChildren` | [use-contribute](reference/use-contribute.md) · [use-collection](reference/use-collection.md) · [use-children](reference/use-children.md) |
| Store 协议 / `openStore` / 组合 | [protocol](reference/protocol.md) · [open-store](reference/open-store.md) · [composition](reference/composition.md) |
| Tree journal / Blobs / 产品投影 | [drivers](reference/drivers.md) · [blobs](reference/blobs.md) · [domain](reference/domain.md) |

## Tutorials

- [计数树](tutorials/counter-tree.md)
- [计数 Store](tutorials/counter-store.md)
- [XState 时序验证](tutorials/verify-order.mjs) · [fromCallback 验证](tutorials/verify-callback.mjs)

## 交付检查

- Feature 之间只经 token / collection 协作：协作面收窄到包入口导出的符号，Feature 才能独立装卸。
- 绑 generate 用 `agent.setConfig` / `setCredentialProvider` / `setRequester`（Feature 用 `useAgent()` 上的同名方法）：它们是命令面上的同步设置，直接决定下一次 `generate`。
- 宿主取 facade 用 `handle.resolve(token)`，订 Feature 事件用 `session.on(feature, type)`。
- `app.on` / `session.on` 是已持久化（或 Feature `fire`）的节点事件；`agent.on` 是机器事件。
- 事实流用 `onCommit` 或节点 `on`：`subscribe` 只在状态变化时通知，状态没变 ≠ 事件没提交。
- hooks 只在同步 setup 段调用；await 之后用 setup 里捕获的句柄，按 id 取实例用 `useApp().get` / `session.get`。
- 需要状态机等待的异步过程建成 invoke + 状态：entry 的 action 不会被 await。
