# provider-catalog

Explanation：模型目录为什么是一个 app 级 Feature。用法见 [7](../how-to-guides/07-use-provider-catalog.md)。

## 目录是一张可变的登记表

开 agent 之后用 `setConfig` / `setCredentialProvider` / `setRequester` 绑 generate。传输这一条是 `setRequester`，寿命是「这台 agent 接下来怎么 `generate`」。

目录要解决的是另一件事：进程里可以有多家 Provider、每家一堆 model、override 与 discovered 合并、探活、按 `(providerId, model)` 再取出 `requester`，然后调用同一个 `setRequester`。这些是可变的登记表：随进程生命、被所有 agent 共享，没有回合级的状态要推进。登记表落在 app 层就是 `createFeature('provider-catalog', { app() { … } })`——app slot 本来就是进程内单例的位置，装卸随 Feature 名单。

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
- **存储**：`createProviderStore()` 是一份响应式快照（`providers: { [id]: { info, discovered, override, pingErrors } }`）：登记表覆盖即事实，`hydrate` 可以整表灌入（persist load 目前未接线）。
- **解析**：`resolve(providerId, model)` 必须同时有 live `Provider` 和能合并出的定义，才给你 `{ requester }`。`upsertEntry` 只改快照，绑不出 requester。未知协议也是 `undefined`。

override 盖 discovered；capability 做或合并。`ping` 走 `settleLlmRequest`（单次、无政策循环），把错误写到该 model 的 `pingError`。

## 和 `setRequester` 的关系

底层只 `agent.setRequester`。catalog 让宿主或其它 Feature 按模型解析出 `requester` 再交给它，以及探活、给 media 按 `model.provider` 找上传通道。协议实现（codec / 传输 / 媒体上传）留在 `llm/` 层，Feature 只维护登记表与解析，装上或卸下都不动协议代码。

## 相关文档

- 怎么用 → [07](../how-to-guides/07-use-provider-catalog.md)
- 手绑 → [15](../how-to-guides/15-run-llm-request.md)
- media 查找键 → [14](../how-to-guides/14-install-media.md)
