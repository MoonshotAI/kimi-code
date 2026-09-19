# 绑定 Provider 并发一次 LLM 请求

How-to：先绑定出 `LlmRequester`，再按单次或政策循环发请求。绑定与 `LlmPolicy` 无关。

## 选择边界

三层不要混：

| 层 | 入口 | 寿命 |
|---|---|---|
| 绑定 | `createProvider` → `createRequester` | 一次；无报文、无网络、无 policy |
| 单次尝试 | `settleLlmRequest` / `generate` | 组包 + 发流；不管重试 |
| 政策循环 | `runLlmRequest` | 凭证、resolver、recovery、retry；每次循环重新 `generate` |

catalog ping 只调 `settleLlmRequest`。机器侧 `createRequestActor` 只是把 `runLlmRequest` 的结果转成 actor 事件。媒体物化见 [安装 createMedia](install-media.md)。

## 绑定（policy 无关）

`createRequester` 只收 protocol 绑定：`connection` / `trait` / `classifyError`，以及协议自己的 extras、clientFactory。`resolveModel` 只组 `LlmModel`。

```ts
import { createProvider } from '#/llm/provider';
import { openAIBase } from '#/llm/builtin/protocol/openai';

const provider = createProvider({
  id: 'openai',
  protocols: { openai: { base: openAIBase } },
});
const requester = provider.createRequester('openai');
const model = provider.resolveModel('gpt-4o', { apiKey: '…' });
const signal = new AbortController().signal;
// createProvider.createRequester
//   └─ ProtocolBase.bind({ connection, trait, classifyError })   // 例如 bindOpenAI
//        └─ 闭包收 Trait / extras / clientFactory / reasoning dialect
//             └─ ProtocolHandle { prepare, createClient, send, createStreamParser, classifyError }
//   └─ createRequesterFromHandle(handle)
//        └─ { generate: (config, content, control) => runProtocolRequest(handle, …) }
// resolveModel：组 LlmModel（capability / baseUrl / apiKey / headers），不碰 policy
```

标准 openai 预设已带 connection，可直接 `import { openaiProvider } from '#/llm/builtin/provider'`，协议名是 `openai` / `openai_responses`。

## 政策循环

`LlmPolicy` 在这里才出现。`generate` / `settleLlmRequest` 不认它。

```ts
import { runLlmRequest } from '#/llm/requester/policy';

const result = await runLlmRequest(
  requester,
  {
    config: { model, thinking: { effort: 'medium' }, cacheKey: 'k', sampling: { temperature: 0 } },
    content: { systemPrompt: '…', messages, tools },
    signal,
    toolCallIds,
    credentialProvider,
  },
  policy,
);
// runLlmRequest
//   while (!aborted):
//     credentialProvider.resolve() → applyCredential(model)
//     policy.resolvers[].resolve(messages)
//     └─ settleLlmRequest(requester, { config, content, signal, toolCallIds })
//          └─ requester.generate(config, content, { signal, onEvent })
//               └─ 见下一节
//          └─ 听 llm.*，累加成 LlmResult { done | failed | aborted }
//     failed?
//       recoveries.proposeFirst → llm.recovering，attempt=1，continue
//       shouldRetry → backoff，attempt++，continue
//       else return failed
```

`policy.media?.()` 在 settle 前写入 `content.media`（已有值不覆盖）。不要包一层 `LlmRequester` 去塞 media。

## 单次 generate

外圈每 retry 一次，整段重跑。协议只做组包和发流。

```ts
await requester.generate(config, content, { signal, onEvent });
// createRequesterFromHandle.generate
//   └─ runProtocolRequest(handle, config, content, control)
//        resolveModelConnection(config.model, handle.connection)
//        formatRequestInput(config, content, { model, messages, media, signal })
//        handle.toolCallIdPolicy? → normalizeToolCallIdsForProvider
//        handle.prepare(input, ctx)                 // 例如 prepareOpenAIRequest
//          └─ composeProtocolRequest(input, trait, ports)
//               encodeKwargs → { kwargs, preserveThinking }
//               kwargs = shake(kwargs + encodeSampling + extras)
//               sealKwargs?                         // 仅 Anthropic thinking.keep
//               lower(…, { preserveThinking })      // Message→Native，物化 media
//               trait.convertMessage?               // null 丢条
//               trait.mergeHistory ?? defaultMergeHistory ?? identity
//               tools = convertTool ?? defaultTool
//               assemble({ messages, tools, kwargs })
//               encode(assembled, trait.buildParams ?? identity) → TRequest
//             prepare 抛错 → llm.failed.syntax
//        headers = connection ⊕ model ⊕ handle.requestHeaders(request)
//        handle.createClient({ model, headers })
//        llm.sent
//        handle.send(client, request, signal) → { stream, headers? }
//        handle.createStreamParser(ctx)             // OpenAI 在此 observe reasoning key
//        for await chunk: parse → llm.streaming.*
//        llm.done  |  classifyError → llm.failed.remote
```

`settleLlmRequest` 听这些事件攒 assistant message + usage。协议自己不攒消息。

## 边界

- 绑定一次，可以换不同 `LlmPolicy` 反复 `runLlmRequest`。
- 不把 `resolvers` / `recoveries` / `retry` 传进 `bind` 或 `createRequester`。
- `RequestTrait`（`convertMessage` / `mergeHistory` / `convertTool` / `buildParams`）是绑定方言，不是政策。
- 包入口不导出 `ComposeProtocolPorts` / `composeProtocolRequest`；产品只认 `LlmRequester.generate`。

源码：v3 `llm/provider.ts`、`llm/protocol/{base,protocol,runner,format}.ts`、`llm/requester/{policy,settle,requester}.ts`、`llm/builtin/protocol/*/index.ts`、`agent-machine/llm-actor.ts`。基线见 [代码定位](../reference/source-map.md)。
