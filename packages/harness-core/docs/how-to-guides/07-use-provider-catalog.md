# 7. 使用 builtin provider-catalog

How-to：装上 `providerCatalog`，用 `useProvider` 贡献 Provider，用 `ProviderCatalogRef` 解析出 `requester`，再 `agent.setRequester`。它为什么是 app 级 Feature 见 [provider-catalog](../explanation/provider-catalog.md)。第 1 步是手绑 requester；这一步改成目录。

## 装上

`providerCatalog` 来自 `@moonshot-ai/agent-core`，已在 harness `features` 名单第一位。只开 catalog、不跑产品 Feature 时：

```ts
import { mountApp, providerCatalog, ProviderCatalogRef } from '@moonshot-ai/agent-core';

const app = mountApp({ features: [providerCatalog] });
await app.ready();
const catalog = app.resolve(ProviderCatalogRef);
```

底层仍是 `setConfig` + `setRequester`。catalog 解决的是「按 providerId + model 再绑一条传输」。

## 贡献 Provider

标准 `openaiProvider` / `anthropicProvider` / `googleProvider` **不会**自动进目录。写一个 app slot Feature：

```ts
import { createFeature, openaiProvider, useProvider } from '@moonshot-ai/agent-core';

export const officialOpenAI = createFeature('official-openai', {
  app() {
    useProvider({
      provider: openaiProvider,
      info: { type: 'openai', defaultModel: 'gpt-4o' },
      models: [
        {
          provider: 'openai',
          model: 'gpt-4o',
          protocol: 'openai',
          capability: {
            image_in: true,
            video_in: false,
            audio_in: false,
            thinking: false,
            tool_use: true,
          },
          maxContextSize: 128_000,
        },
      ],
    });
  },
});
```

harness 的 `kimi` Feature 就是 `useProvider({ provider: kimiProvider })`，不写死 models，让 `listModels()` 填 `discovered`。

`useProvider` 必须在同步 setup 调用；卸载从目录 `remove`。

## 读目录、绑 requester

开 session 见 [1](01-run-a-turn.md)。已有 `session` 后：

```ts
catalog.providers();
catalog.models('openai');
const binding = catalog.resolve('openai', 'gpt-4o');
if (binding === undefined) throw new Error('model not in catalog');
const agent = session.get(MAIN_AGENT_ID) ?? await session.create({ agentId: MAIN_AGENT_ID });
agent.setRequester(binding.requester);
```

`resolve` 要两样都在：live `Provider` 实例（`upsert` / `useProvider` 绑过）+ 条目里能合并出的 model。缺一即 `undefined`。

其它命令：

| 方法 | 作用 |
|---|---|
| `upsert({ provider, info?, models? })` | 登记 live Provider，写 override，并 `listModels()` 填 discovered |
| `upsertEntry({ providerId, info?, models? })` | 只改快照，不绑 live |
| `refresh(provider)` | 再拉一次 `listModels` |
| `ping(providerId, model)` | `settleLlmRequest` 探活；失败写入 `pingError` |
| `hydrate(snapshot)` / `remove(id)` | 整表替换 / 删除 |

`ping` 不走 `runLlmRequest`，不带 retry / recovery。

模型列表也可以当 collection 读：`app.node.fold(CatalogModels)`，每条是 `{ providerId, model, requester }`。media 按 `ctx.model.provider` 找上传通道时要同时装 catalog，见 [14. 安装 createMedia](14-install-media.md)。

## 相关文档

- 为什么这样拆 → [provider-catalog](../explanation/provider-catalog.md)
- 手绑 requester → [15](15-run-llm-request.md)
- 贡献 hook → [contribution-hooks](../reference/contribution-hooks.md)
