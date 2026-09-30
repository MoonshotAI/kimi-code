# 15. 绑定 Provider 并发一次 LLM 请求

How-to：先绑定出 `LlmRequester`，再按单次或政策循环发请求。绑定与 `LlmPolicy` 无关。

## 选择边界

三层各管一段寿命：

| 层 | 入口 | 寿命 |
|---|---|---|
| 绑定 | 预制 requester（`openAIRequester` 等）或 `createRequester().with(part)` | 一次；无网络、无 policy |
| 单次尝试 | `settleLlmRequest(request, { signal, onEvent })` | 组包 + 发流 + 攒消息；不管重试 |
| 政策循环 | `requester.generate(rest, control)` / `runLlmRequest(request, control)` | resolver、recovery、retry；每次 attempt 重新 settle |

catalog ping 用 requester 的 `generate`（policy 压成 `retry.maxAttemptsPerStep: 1`，不挂 recovery）。机器侧 `createRequestActor` 只是把 `runLlmRequest` 的结果转成 actor 事件。媒体物化见 [安装 createMedia](14-install-media.md)。

## 绑定（policy 无关）

`LlmRequester` 三面：`with(part)` 按维度（`protocol` / `endpoint` / `model` / `profile` / `content` / `policy`）渐进填充并返回新 requester（同维度浅合并，`endpoint.headers` 单独合并）；`request(rest)` 补齐剩余维度组出 `LlmRequest`，不发送；`generate(rest, control)` 即 `runLlmRequest(request(rest), control)`。`AgentLlmRequester = LlmRequester<LlmDimension>`——所有维度都还能再 `with`。

预制 requester 已填 `protocol` 与默认 `endpoint`（kimi 带默认 baseUrl 与 `files` 上传通道），全部从包根导出：`openAIRequester` / `openAIResponsesRequester` / `anthropicRequester` / `googleGenAIRequester` / `googleVertexRequester` / `kimiRequester` / `kimiAnthropicRequester` / `kimiResponsesRequester` / `deepseekRequester` / `deepseekAnthropicRequester` / `glmRequester`。模型与凭证再 `with` 上去：

```ts
import { createStaticCredentialProvider, openAIRequester } from '@moonshot-ai/agent-core';

const requester = openAIRequester.with({
  endpoint: {
    baseUrl: process.env['OPENAI_BASE_URL'],
    credentials: createStaticCredentialProvider(process.env['OPENAI_API_KEY']),
  },
});
const model = {
  spec: {
    provider: 'openai',
    name: 'gpt-4o',
    capability: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
    },
    maxContextSize: 128_000,
  },
};
```

自定义协议从空绑定开始：`createRequester().with({ protocol: { base: someProtocol, options }, endpoint: … })`。协议本体是 `Protocol`（`encode` / `decode` / `decodeStream` / `decodeError` / `client` / `send` / `sendStream`，外加 `media` 支持表与可选 `capability` 查找），用 `defineProtocol(def)` 声明、`.with(patch)` 派生方言。

产品 turn 把内部类型交给 agent：`setModel(model)`、`setEndpoint(endpoint)`、`setRequester(requester)`，`runLlmRequest` 由机器侧发起。缺 model 或 requester 的下一次 `generate` 失败。步骤见 [01](01-run-a-turn.md)；按模型再绑 requester 见 [07](07-use-provider-catalog.md)。

## 政策循环

`LlmPolicy = { resolvers?, recoveries?, retryables?, retry? }` 在这里才出现——挂在请求的 `policy` 维度上（机器侧由 `createRequestActor(getRequester, policy)` 注入）。`settleLlmRequest` / `generate` 不认它。

```ts
const outcome = await requester.generate(
  {
    model: { ...model, thinking: { effort: 'medium' }, cacheKey: 'k', sampling: { temperature: 0 } },
    profile: { systemPrompt: '…', tools },
    content: { messages },
    policy,
  },
  { signal, onEvent: (event) => { /* llm.started / llm.streaming.* / llm.notice / llm.retrying / llm.ended */ } },
);
// runLlmRequest
//   onEvent(llm.started)
//   while (!aborted):
//     recovery ledger 先重写 messages（已记录的 recovery）
//     policy.resolvers[].resolve(messages)         // store-ref 物化在这里；notice 经 report 上抛
//     └─ settleLlmRequest(request, { signal, onEvent })
//          └─ generate(request, control)          // 见下一节
//          └─ 攒 assistant message + usage → LlmOutcome { done | failed | aborted }
//     failed(remote)?
//       recoveries 提案 → llm.retrying { reason: 'recovery', strategy, action }，attempt=1，continue
//       shouldRetry → llm.retrying { reason: 'backoff', failedAttempt, nextAttempt, delayMs }，延迟后 continue
//       else return failed
//   onEvent(llm.ended { outcome })；返回值即 outcome
```

`MessageResolver` 是唯一的容错缝：语义不合法但可修的输入（store ref、可压缩的超长段）在 resolver 里改，encode 一律把违规当 syntax 错误抛出、不修。

## 单次 generate

外圈每 retry 一次，整段重跑。协议只做组包和发流，不攒消息。

```ts
const outcome = await settleLlmRequest(request, { signal, onEvent });
// generate(request, control)
//   base.encode(module, { report })                 // 组包；抛错 → attempt.failed（kind: 'syntax'）
//   resolveEndpoint(request.endpoint)               // credentials.resolve() → headers，defaultBaseUrl 兜底
//   client = endpoint.clientFactory?.(endpoint) ?? base.client(endpoint, options)
//   attempt.sending（settle 内部计时用，不外发）
//   base.sendStream / base.send(client, request, signal)
//   decodeStream / decode → llm.streaming.{headers,part,usage,finish,message_id}
//   远端错误 → attempt.failed（协议 decodeError 分类）
// settleLlmRequest 听这些事件攒 assistant message + usage；空响应 → failed(empty_response)
```

## 边界

- 绑定一次，可以换不同 `LlmPolicy` 反复 `generate`。
- `resolvers` / `recoveries` / `retryables` / `retry` 归 `policy` 维度，随每次调用生效。
- 协议方言（`Protocol` 各方法与 `defineProtocol(...).with(patch)`）是绑定差异，不是政策。
- 包入口不导出 pipeline 内部（`runPipeline` 等）；产品只认 `LlmRequester.generate`。
- 事件面只有 `llm.started` / `llm.streaming.*` / `llm.notice` / `llm.retrying`（`reason: 'backoff' | 'recovery'`）/ `llm.ended { outcome }`——没有 `llm.sent` / `llm.failed.*` / `llm.recovering`。

源码：`packages/agent-core/src/llm/{request,requester,generate,response,endpoint}.ts`、`llm/policy/{policy,settle,resolver,recovery,retry}.ts`、`llm/protocol/{protocol,pipeline}.ts`、`llm/builtin/{protocol,provider,policy}/`、`agent-machine/llm-actor.ts`。基线见 [代码定位](../reference/source-map.md)。
