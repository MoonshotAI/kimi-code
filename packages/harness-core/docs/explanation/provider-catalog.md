# provider-catalog

Explanation：模型目录为什么是一个 app 级 Feature。用法见 [7](../how-to-guides/07-use-provider-catalog.md)。

## 目录是一张可变的登记表

开 agent 之后用 `setModel` / `setEndpoint` / `setRequester` 绑 generate。传输这一条是 `setRequester`，寿命是「这台 agent 接下来怎么 `generate`」。

目录要解决的是另一件事：进程里可以有多家 Provider、每家一堆 model、override 与 discovered 合并、探活、按 `(providerId, model)` 再取出 `{ requester, endpoint }`，然后调用同一组 `setModel` / `setEndpoint` / `setRequester`。这些是可变的登记表：随进程生命、被所有 agent 共享，没有回合级的状态要推进。登记表落在 app 层就是 `createFeature('provider-catalog', { app() { … } })`——app slot 本来就是进程内单例的位置，装卸随 Feature 名单。

## 贡献面与存储面

```text
useProvider(contribution)
        │
        ▼
   Providers collection     ──watch──►  ProviderCatalog.upsert / remove
        │
        ▼
   catalog snapshot         ──useChildren──►  每条 model 一个 catalog-model 子节点
                                                    │
                                                    ▼
                                              CatalogModels collection
```

- **贡献**：Feature 在 app slot `useProvider({ handle, info?, models? })`。卸载撤回。预制 requester（`openAIRequester` / `anthropicRequester` / `googleGenAIRequester` 等）**不**自动贡献；harness 的 `kimi` 会。`CatalogProviderHandle` 是 `{ id, requester?: 单个 | 按协议 record | 工厂, endpoint?, listModels? }`——config 里的 `type` 经 `useProviderProtocol({ type, protocols })` 物化出同样的形状。
- **存储**：`llm/catalog` 的 `createProviderCatalog()` 是一份自包含的 store 核心（`providers: { [id]: { info, discovered, override, pingErrors } }`）：upsert 覆盖即事实，refresh 批量去重排队拉 `listModels()`，ping 走 `generate` 单次探活；glue 把 config 节经 upsert 写入条目，发现模型经 `onChanged` 写回 config（persist 由 config Feature 承担）。
- **解析**：`model(providerId, modelId)` 给合并后的 `CatalogModel`（`LlmModelSpec` 超集），`requester(providerId, modelId)` 按 handle.endpoint → info(baseUrl/customHeaders) → model 维度叠出已烘焙的 requester；handle 未绑或 model 合不出即 `undefined`。

override 盖 discovered；capability 归一到 `UNKNOWN_CAPABILITY`（tool_use 缺省 true）。`ping` 走 requester 的 `generate`（policy 压成 `retry.maxAttemptsPerStep: 1`，默认 30s 超时，不挂 recovery），把错误写到该 model 的 `pingError`。

## 和 `setRequester` 的关系

底层是 `agent.setModel` / `setEndpoint` / `setRequester`。catalog 让宿主或其它 Feature 按模型解析出烘焙好的 requester 再交给它，以及探活。catalog 自己的 agent slot 也会读 `default_model` config 节实时应用绑定，显式 `setModel` 先到则不覆盖。媒体上传通道不再按 provider 查表——它写在 requester 的 endpoint `files` 上（kimi requester 已携带）。协议实现（codec / 传输 / 媒体上传）留在 `llm/` 层，Feature 只维护登记表与解析，装上或卸下都不动协议代码。

## 相关文档

- 怎么用 → [07](../how-to-guides/07-use-provider-catalog.md)
- 手绑 → [15](../how-to-guides/15-run-llm-request.md)
- 媒体物化 → [14](../how-to-guides/14-install-media.md)
