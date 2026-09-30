# 7. 使用 builtin provider-catalog

How-to：装上 `providerCatalog`，用 `useProvider` 贡献 Provider，用 `ProviderCatalogRef` 解析出 `{ requester, endpoint }`，再 `agent.setModel` / `setEndpoint` / `setRequester`。它为什么是 app 级 Feature 见 [provider-catalog](../explanation/provider-catalog.md)。第 1 步是手绑 requester；这一步改成目录。

## 装上

`providerCatalog` 来自 `@moonshot-ai/agent-core`，已在 harness `features` 名单第一位。只开 catalog、不跑产品 Feature 时：

```ts
import { createHarness, providerCatalog, ProviderCatalogRef } from '@moonshot-ai/agent-core';

const app = createHarness({ features: [providerCatalog] });
await app.ready();
const catalog = app.resolve(ProviderCatalogRef);
```

底层仍是 `setModel` + `setEndpoint` + `setRequester`。catalog 解决的是「按 providerId + model 再绑一条传输」。

## 贡献 Provider

预制 requester（`openAIRequester` 等）**不会**自动进目录。把预制 requester 摆进 `CatalogProviderHandle.requester`（单个 requester、按协议名的 record、或 `(protocol?, model?) => requester` 工厂），写一个 app slot Feature：

```ts
import {
  createFeature,
  openAIRequester,
  useProvider,
  type CatalogProviderHandle,
} from '@moonshot-ai/agent-core';

const openai: CatalogProviderHandle = {
  id: 'openai',
  requester: { openai: openAIRequester },
};

export const officialOpenAI = createFeature('official-openai', {
  app() {
    useProvider({
      handle: openai,
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

harness 的 `kimi` Feature 就是 `useProvider({ handle: kimiProvider })` + `useProviderProtocol({ type: 'kimi', protocols: () => kimiProtocolBindings() })`——`kimiProvider` 是把 `kimiRequester` / `kimiAnthropicRequester` / `kimiResponsesRequester` 摆进 `requester` 的 `CatalogProviderHandle`，不写死 models，让 `listModels()` / config 物化填 `discovered`。

`useProvider` 必须在同步 setup 调用；卸载从目录 `remove`。

## 读目录、绑 requester

开 session 见 [1](01-run-a-turn.md)。已有 `session` 后：

```ts
catalog.providers();
catalog.models('openai');
const model = catalog.model('openai', 'gpt-4o');
const requester = catalog.requester('openai', 'gpt-4o');
if (model === undefined || requester === undefined) throw new Error('model not in catalog');
const agent = session.get(MAIN_AGENT_ID) ?? await session.create({ agentId: MAIN_AGENT_ID });
agent.setModel({ spec: model });
agent.setRequester(requester);
```

`model(providerId, modelId)` 返回合并后的 `CatalogModel`（它本身就是 `LlmModelSpec` 的超集，直接喂 `spec`）；`requester(providerId, modelId)` 按 handle.endpoint → info(baseUrl/customHeaders) → model(endpoint/protocolOptions/model 维度) 叠出**已烘焙模型与凭证**的 requester，缺一即 `undefined`。静态 key / OAuth 凭证由 catalog 的 resolver 链在 upsert 时烘进 handle 的 endpoint。

config Feature 在场时不必手绑：catalog 的 agent slot 会读 `default_model` 节的别名，从 `CatalogModels` 解析 binding 后自己调 `setModel` / `setRequester`（含凭证解析）；显式 `setModel` 先到则不再覆盖。

其它命令：

| 方法 | 作用 |
|---|---|
| `upsert({ providerId?, handle?, info?, models?, refresh? })` | 登记/替换条目（可顺带 handle）；`refresh !== false` 时随后 `listModels()` 填 discovered |
| `bind(handle)` | 只绑 handle，不动快照 |
| `refresh(target)` | 再拉一次 `listModels`（id / handle / 数组） |
| `ping(providerId, modelId)` | 单次探活；失败写入 `pingError` |
| `remove(id)` | 删除 |
| `onChanged(listener)` | 快照变更（providers 名单） |
| `onRefreshFailed(listener)` | 刷新失败 |
| `isLive(providerId)` | handle 是否已绑 |

`ping` 走 requester 的 `generate`，但 policy 只有 `retry.maxAttemptsPerStep: 1`（单次、不挂 recovery），默认 30s 超时。

模型列表也可以当 collection 读：`app.node.fold(CatalogModels)`，每条是 `{ providerId, model, alias, configKey?, requester }`。媒体上传通道在 requester 的 endpoint `files` 上（kimi requester 已携带），见 [14. 安装 createMedia](14-install-media.md)。

## 相关文档

- 为什么这样拆 → [provider-catalog](../explanation/provider-catalog.md)
- 手绑 requester → [15](15-run-llm-request.md)
- 贡献 hook → [contribution-hooks](../reference/contribution-hooks.md)
