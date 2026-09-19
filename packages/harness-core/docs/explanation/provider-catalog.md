# provider-catalog

Explanation：模型目录为什么是一个 app 级 Feature，而不是状态机、也不是 `mountApp` 参数。用法见 [7](../how-to-guides/07-use-provider-catalog.md)。

## 两件事不要并成一台机器

开 agent 之后用 `setConfig` / `setCredentialProvider` / `setRequester` 绑 generate。传输这一条是 `setRequester`，寿命是「这台 agent 接下来怎么 `generate`」。

目录要解决的是另一件事：进程里可以有多家 Provider、每家一堆 model、override 与 discovered 合并、探活、按 `(providerId, model)` 再取出 `requester`，然后调用同一个 `setRequester`。这些是可变的登记表，没有「idle → running」要推进，也不该跟 turn 绑在一起。所以 `providerCatalog` 是 `createFeature('provider-catalog', { app() { … } })`，`agent-machine/` 不再含 catalog 状态机。

## 贡献面与存储面

```text
useProvider(contribution)
        │
        ▼
   Providers collection     ──watch──►  ProviderStore.upsert / remove
        │
        ▼
   store.snapshot           ──useChildren──►  每条 model 一个 catalog-model 子节点
                                                    │
                                                    ▼
                                              CatalogModels collection
```

- **贡献**：Feature 在 app slot `useProvider({ provider, info?, models? })`。卸载撤回。标准 openai / anthropic / google **不**自动贡献；harness 的 `kimi` 会。
- **存储**：`createProviderStore()` 是一份响应式快照（`providers: { [id]: { info, discovered, override, pingErrors } }`），不是 event-sourced `openStore`。`hydrate` 可以整表灌入，但 catalog 目前未接线 persist load。
- **解析**：`resolve(providerId, model)` 必须同时有 live `Provider` 和能合并出的定义，才给你 `{ requester }`。`upsertEntry` 只改快照，绑不出 requester。未知协议也是 `undefined`。

override 盖 discovered；capability 做或合并。`ping` 走 `settleLlmRequest`（单次、无政策循环），把错误写到该 model 的 `pingError`。

## 和 `setRequester` 的关系

底层只 `agent.setRequester`。catalog 让宿主或其它 Feature 按模型解析出 `requester` 再交给它，以及探活、给 media 按 `model.provider` 找上传通道。不要把四家协议实现搬进 Feature，也不要再给 `mountApp` 加默认 requester。

## 相关文档

- 怎么用 → [07](../how-to-guides/07-use-provider-catalog.md)
- 手绑 → [15](../how-to-guides/15-run-llm-request.md)
- media 查找键 → [14](../how-to-guides/14-install-media.md)
