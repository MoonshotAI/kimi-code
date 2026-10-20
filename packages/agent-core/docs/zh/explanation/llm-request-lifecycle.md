# 一次 LLM 请求的生命周期：policy、encode、decode

这是一篇 explanation 文档：沿着一次 `generate` 调用，说明请求经过哪几个阶段、每个阶段做了什么，以及不同 protocol、provider 在每个阶段的差异。边界规则与分层见 [LLM 层的边界与架构](llm-boundary-and-architecture.md)。

## 总览

一次调用是三层嵌套，而不是三个平铺的阶段：

- 最外层是 **policy**：跨多次 attempt 的运行循环。
- 每次 attempt 内部先 **encode**（出站转换），中间 **send**，然后 **decode**（入站转换）。
- policy 的 settle 把每次 attempt 的事件流收敛成一个结果；最终结果作为返回值，同时以 `llm.ended { outcome }` 发出一次。

协议之间的差异全部通过 `PipelineSpec` 钩子和 `Protocol` 方法表达。provider 的差异是对某个协议调用 `.with(patch)` 换掉其中几个钩子，再加上 endpoint 默认值和文件上传器。

```text
requester.generate(rest)                       src/llm/requester.ts：合并各请求维度
└─ runLlmRequest(request)                      src/llm/policy/policy.ts —— policy 循环
   ├─ 发出 llm.started                         每次运行一次
   ├─ ledger.apply(messages)                   重放之前 recovery 做过的消息改写
   ├─ policy.resolvers[*].resolve(...)         例如 store-ref resolver（异步，有 IO）
   ├─ settleLlmRequest(...)                    src/llm/policy/settle.ts —— 收敛
   │   └─ generate(request)                    src/llm/generate.ts —— 一次 attempt
   │       ├─ effectiveModelSpec               合并协议推断出的 capability
   │       ├─ base.encode(module)              == runPipeline —— encode
   │       ├─ resolveEndpoint + base.client    （或 endpoint.clientFactory）
   │       ├─ base.sendStream / base.send      —— send；非流式 body 经 base.replay 展开成 chunk
   │       └─ base.decoder(module, sink)       —— decode：push 每个 chunk，最后 end（sink 外面包了 uniqueToolCallIds）
   ├─ 远端失败 → recoveries.proposeFirst       llm.retrying { reason: 'recovery' }；attempt 计数归零
   ├─ 可重试   → 退避后重来                    llm.retrying { reason: 'backoff' }；Retry-After 或指数退避
   └─ 发出 llm.ended { outcome }               每次运行一次，所有分支都发；与返回值是同一个对象
```

两条失败通道从 `generate` 就分开了：

- encode 阶段抛出的错误变成 `attempt.failed`（`error.kind === 'syntax'`），跳过 recovery 和 retry，本次运行以 `failed` 结束。
- send 或 decode 阶段的错误经过 `base.decodeError` 处理，变成带远端错误类型的 `attempt.failed`。

## Policy 阶段

涉及文件：`src/llm/policy/`、`src/llm/builtin/policy/`。

### 每轮循环的步骤

```ts
while (!signal.aborted) {
  const messages = ledger.apply(request.content.messages);
  let resolvedMessages = messages;
  for (const resolver of listOf(policy.resolvers)) {
    resolvedMessages = await resolver.resolve(resolvedMessages, {
      model,
      endpoint: request.endpoint,
      media: request.protocol.base.media,
      signal,
      report: (notice) =>
        onEvent?.({ type: 'llm.notice', notice: { ...notice, source: resolver.id } }),
    });
  }
  const result = await settleLlmRequest(
    { ...request, content: { ...request.content, messages: resolvedMessages } },
    { signal, onEvent },
  );
  // ...
}
```

1. **重放 recovery 账本**（`recovery.ts`）。账本里存的是消息改写函数。每轮都从原始历史重新应用一遍，不会就地修改宿主的数据。
2. **resolver**（`MessageResolver`）。这是"容忍或预处理输入"的唯一入口。内置的只有 store-ref resolver，见下文。
3. **settle**（`settle.ts`）。它调用 `generate`，并用 `createMessageAccumulator` 把流式 part 拼成 `AssistantMessage`：
   - 相邻的 text 合并成一个 part。
   - think 只有在 `encrypted`、`detailsIndex`、`hidden`、`reasoningKey` 都一致时才合并。一旦带了 `encrypted`，就不再往这个 part 里追加内容。
   - `tool_call_part` 按 `index` 把参数拼回对应的 function call。
   - 解码器发出的 tool call 结束信号以内部事件 `attempt.tool_call_end` 到达，把 pending 的 call 关闭一次；settle 再把它转成对外的 `llm.streaming.tool_call_end`，携带拼装好的完整 `ToolCall`。
   - usage 按 patch 合并：每个字段取最新出现的值。
   - 从 headers 里取 `requestId`，并统计各项耗时（首 token 延迟、服务端解码时间、客户端阻塞时间等）。
   - 收尾时判断空响应：既没有内容也没有 tool call，或者只有 think，都会变成 `empty_response`。被中断的响应通过 `usableOutputOf` 尽量保留已收到的内容。
4. **recovery**。只在远端失败时运行。`proposeFirst` 取第一个确实改变了消息的提议，记录一次，把 attempt 重置为 1，并发出 `llm.retrying { reason: 'recovery', strategy, action, error }`。
5. **retry**（`retry.ts`），等待之前发出 `llm.retrying { reason: 'backoff', failedAttempt, nextAttempt, maxAttempts, delayMs, error }`：
   - 默认可重试：auth、connection、timeout、rate_limit、overloaded、provider；status 类错误只在状态码属于 408、409、429、500、502、503、504、529 时重试；`empty_response` 只要不是被过滤导致的就重试。
   - 默认最多 10 次。退避时间为 500ms × 2ⁿ，上限 32s，再加最多 25% 的随机抖动。如果响应带了 `Retry-After`，以它为准。
   - `infiniteRetry` 开启后，除了 syntax、abort、context_overflow 之外都会一直重试。

### 边界事件

`runLlmRequest` 的 `onEvent`（类型 `LlmRunEvent`）是 llm 层对外的事件边界。约定：每次调用恰好一个 `llm.started` 和一个 `llm.ended`，中间只有流式事件、notice 和 `llm.retrying`。

| 事件 | 时机 | 内容 |
|---|---|---|
| `llm.started` | `runLlmRequest` 入口，resolver 和媒体上传之前 | 无 |
| `llm.notice` | 任意 pass 或 resolver 做了适配 | `notice` |
| `llm.streaming.headers` / `part` / `usage` / `finish` / `message_id` / `tool_call_end` | 每次 attempt 的流式过程 | 增量数据；`tool_call_end` 携带拼装好的 `toolCall` |
| `llm.retrying`，`reason: 'backoff'` | attempt 失败且可重试，等待之前 | `error`、`failedAttempt`、`nextAttempt`、`maxAttempts`、`delayMs` |
| `llm.retrying`，`reason: 'recovery'` | attempt 失败且某个 recovery 改写了消息 | `error`、`strategy`、`action` |
| `llm.ended` | 返回之前，所有分支都会发 | `outcome: LlmOutcome` |

`LlmOutcome` 与 `runLlmRequest` 的返回值是同一个对象，按结果分成三种结构：

- `{ type: 'done', message, usage, finish, messageId, requestId, timing, headers }`：完整的 `AssistantMessage`，由 settle 的累积器产出，没有第二份累积逻辑。
- `{ type: 'failed', error, rawError?, message?, ... }`：`error.kind === 'syntax'` 是调用方问题，其余是远端问题；`message` 是已收到的部分。resolver 抛出的非中止异常也归入这里（`kind: 'unknown'`），保证 `llm.started` 一定配对 `llm.ended`。
- `{ type: 'aborted', message, reason?, ... }`：`message` 是抢救下来的部分，可能为 `null`；`reason` 可选，携带中止信号上的原因（`AbortSignal.reason`）。

单次 attempt 内部的事件（`generate.ts` 里的 `LlmAttemptEvent`：`attempt.sending`、`attempt.failed`）只在 `generate` 与 settle 之间流动，不出现在边界上。失败 attempt 已发出的 part 不会撤回，宿主在收到 `llm.retrying` 时自行清空。

### store-ref resolver

涉及文件：`src/llm/builtin/policy/store-ref/resolve.ts`、`src/llm/builtin/policy/store-ref/materialize.ts`。

store-ref resolver 是 policy 阶段与协议和 provider 关系最紧的部分。它读取 `protocol.base.media`（`MediaSupport`）和 `endpoint.files`（provider 提供的上传器）。

对每个媒体 part，`materializePart` 按以下顺序处理：

1. 已经标记了 `omitted` 的，换成占位文本。宿主可以通过 `placeholder` 端口自定义这段文本。
2. 如果协议不支持这种媒体，或者模型 capability 没有开启，就原样保留。之后由 encode 的 `legalize-media` 统一换成占位。
3. `inline` 来源只检查 MIME 与媒体类型是否一致。`url` 和 `file` 来源直接放行。
4. `store` 来源（宿主存储中的二进制）按以下步骤处理：
   - 先查进程内 memo，再查持久化的上传缓存。两者的 key 都是"媒体类型 + provider + baseUrl + 账号身份"。
   - 读出字节后确定 MIME：图片优先用嗅探结果，其他类型优先用声明的 MIME。协议不接受这个 MIME 时，换成 `stripped` 占位。
   - 如果 provider 有 `files` 且支持这种媒体类型，就上传，得到 `url` 或 `file` 形式的引用。上传失败时，401/403 抛出 `UploadAuthError`，其他错误静默回退。
   - 否则，如果协议接受 `inline`，就转成 base64。
   - 都不满足时，换成 `unavailable` 占位。
5. **预算**：本次请求内联媒体的总量超过 20MB 时，从最旧的开始丢弃，直到降到 10MB 以下。被丢弃的 key 记录在 `budgetDropped` 里，之后的请求也保持丢弃，避免同一个媒体反复进出、破坏缓存。
6. 遇到 `UploadAuthError` 时，如果凭据提供者能处理这类错误，就调用 `invalidate` 刷新凭据，然后整体重做一次。

### 内置 recovery

| recovery | 触发条件 | 做法 | 次数 |
|---|---|---|---|
| `structureRecovery` | `request_structure` | 合并相邻的 assistant 消息，丢弃开头的非 user 消息 | 一次 |
| `credentialsRecovery` | `credentials.canRecover(error)`（OAuth 场景下是 401） | 下次 attempt 前调用 `invalidate`，强制刷新 token | 一次 |
| `createMediaDegradeRecovery` | `image_format` | 把当前所有媒体标记为 `stripped` | 每种 action 一次 |
| 同上 | `request_too_large` | 先 `degraded`（只保留最近 2 个媒体），仍然失败再 `stripped` | 每种 action 一次 |

媒体 recovery 只改 `omitted` 标记，不直接删除内容。真正换成占位文本的是 encode 的 `legalize-media`。

### Policy 阶段中协议和 provider 带来的差异

policy 循环本身与协议无关。差异只从三个地方进来：

- **`MediaSupport`**（由协议或 provider 声明）：决定哪些媒体要物化、接受哪些 MIME、能否内联。
- **`endpoint.files`**（由 provider 提供）：

  | provider | 上传的媒体类型 | 返回的引用 |
  |---|---|---|
  | Kimi | image、video | `url: ms://<id>`；Anthropic 兼容入口会把 baseUrl 改到 `/v1` |
  | DeepSeek | 仅 image | `file: <id>`，有效期 30 天，`expiresAt` 提前 1 小时；Anthropic 兼容入口会去掉 `/anthropic` |
  | OpenAI、Anthropic、Google、GLM | 不上传 | 全部内联为 base64 |

- **`decodeError` 的分类结果**：错误被归为哪一类，决定了走哪个 recovery、是否重试。详见 decode 一节。

## Encode 阶段

涉及文件：`src/llm/protocol/pipeline.ts`、`src/llm/protocol/rules/`、各协议的 `lower.ts` 和 `legalize.ts`。

`defineProtocol` 把 `encode` 固定为 `runPipeline(definition, module)`。流水线分成两半：

```ts
const legal = legalize(input, pipeline, pipeline.cacheKey !== undefined, passes);
const converted = run('convert', convert(legal, pipeline));
const merged = run('merge-turns', mergeTurns(converted, pipeline.mergeTurns));
const annotated = run('annotate-cache', pipeline.annotate?.(merged) ?? merged);
const finalized = run('finalize-params', pipeline.finalize?.(annotated, legal) ?? annotated);
return run('flatten', pipeline.flatten(finalized, legal));
```

### 前半段：legalize，在规范消息上工作

规则写在核心层（`rules/index.ts` 固定顺序），协议只通过 `LegalizeSpec` 提供参数：`media`、`toolCallId`、`thinkingHistory`、`legality`。

| # | pass | 做什么 | 违规时 |
|---|---|---|---|
| 1 | `legalize-media` | 媒体换成占位，原因有四种：已标记省略、capability 未开启（`unsupported`）、协议在该位置不支持（`protocol_unsupported`）、来源形式、MIME 或 URL 不被接受（`stripped`） | 静默替换 |
| 2 | `verify-history` | 检查是否还有未解析的 store 引用；检查 tool 调用关系：id 重复、孤儿 result、多个 result、空 result、有调用没有 result | 抛出 syntax 错误 |
| 3 | `legalize-structure` | 去掉空白文本和没有实际内容的消息；把 tool result 挪到紧跟对应调用的位置 | 发出 notice |
| 4 | `relocate-tool-media` | 协议声明为 `inToolResult: 'relocate'` 的媒体，从 tool result 里移出，放到其后的一条 user 消息（"Attached media from tool result:"）；tool result 变空时补一句 "(see attached media)" | 静默 |
| 5 | `legalize-tool-call-ids` | 按协议的 `normalize` 规则和 `maxLength` 映射 id；冲突时加 `_2`、`_3` 后缀 | 静默 |
| 6 | `legalize-thinking-history` | 应用协议特有的 reasoning 回放 pattern | 静默 |
| 7 | `legalize-model` | 检查 responseFormat 白名单；strict thinking effort 纠正；协议没有 `cacheKey` 钩子时丢掉 cacheKey；sampling 只保留协议支持的字段；输出上限取 min(请求值或 fill 值, 上下文窗口 − 已用 token)，再交给 clamp；最后调用协议的 `verify` | 白名单不满足时抛出 syntax 错误 |

`legalize-media` 排在 `verify-history` 之前：模型不支持的 store 引用会先被换成占位，不会触发"未解析"错误；只有模型和协议都接受、却没有经过 resolver 的 store 引用才会报错。

### 后半段：lower，生成协议原生结构

1. **`convert`**：params 按固定顺序浅合并：`cacheKey → thinking → responseFormat → maxOutputTokens → sampling`。消息用 `message()` 做 flatMap，一条规范消息可以产出多条原生消息。tools 先过滤掉 `deferred`，再用 `tool()` 转换。system 取自 `profile.systemPrompt`。
2. **`merge-turns`**：在原生消息上应用 pattern。
3. **`annotate-cache`**：打缓存标记。
4. **`finalize-params`**：依据完整的原生结构，最后修正参数（例如 beta 开关）。
5. **`flatten`**：拼成 SDK 需要的请求体，并合并 `options.extras`。

### 四个协议在 encode 上的差异

**媒体能力（`MediaSupport`）**

| 协议 | image | audio | video |
|---|---|---|---|
| OpenAI Chat | png、jpeg、gif、webp；inline、url；在 tool result 中 relocate | 任意 MIME；inline、url；tool result 中不支持 | 不支持 |
| OpenAI Responses | inline、url、file；在 tool result 中原生支持 | 只接受 mp3、mpeg、wav；url 必须是 http(s) | 不支持 |
| Anthropic | inline、url、file；原生支持 | 不支持 | mp4、mpeg、quicktime、webm、x-matroska、x-msvideo、x-flv、3gpp；inline、url |
| Google GenAI | inline、url、file | 同左 | 同左 |

**legalize 参数**

| 协议 | tool call id | thinking 历史 | 允许的 sampling | 其他 |
|---|---|---|---|---|
| OpenAI Chat | 只保留 `[A-Za-z0-9_-]`，最长 64 | `stampReasoningKey`：给 think part 标上回放用的字段名。默认取历史中最后一个具体的字段名，否则用 `reasoning_content`。设置了 `options.reasoningKey` 时强制全部改成这个字段名 | 7 项全部支持 | — |
| OpenAI Responses | 先截掉 `\|` 后面的部分，再做同样的 sanitize，最长 64 | 无 | temperature、topP | — |
| Anthropic | sanitize，最长 64 | `stripUnsignedThinking`：丢掉没有签名的 think；无法识别型号的模型保留 | temperature、topP、topK、stop | 按型号查表 clamp 输出上限（例如 opus-4-5 是 64K）；拒绝 `json_object`；effort 不在已知列表里时只发 notice |
| Google GenAI | 不处理 | 无 | 7 项全部支持 | — |

**lower 钩子**

| 钩子 | OpenAI Chat | OpenAI Responses | Anthropic | Google GenAI |
|---|---|---|---|---|
| cacheKey | `prompt_cache_key` | `prompt_cache_key` | `metadata.user_id` | 没有钩子，cacheKey 在 legalize 阶段被丢掉 |
| thinking | `resolveReasoningEffort` 生成 `reasoning_effort`。`on` 时不发送；`off` 时用 `offEffort`，模型总是推理或缺少 offEffort 时报错。未得到具体 effort 且历史里有 think 时，补发 `medium` | 同样的解析逻辑，生成 `reasoning:{effort, summary:'auto'}` 和 `include:['reasoning.encrypted_content']` | 按型号推断 budget 或 adaptive 模式。adaptive 生成 `{type:'adaptive', display:'summarized'}` 加 `output_config.effort`；budget 生成 `budget_tokens`（low 1024、medium 4096、high 32000）。模型不能关闭推理时，`off` 报错 | gemini-3 用 `thinkingLevel`，其余型号用 `thinkingBudget`（0、1024、4096、32000）；同时设置 `includeThoughts` |
| responseFormat | `response_format` | `text.format` | 只支持 json_schema，写到 `output_config.format` | `responseMimeType: application/json` 加 `responseJsonSchema` |
| maxOutputTokens | o 系列和 gpt-5 用 `max_completion_tokens`，其他用 `max_tokens`；硬上限 128K | `max_output_tokens` | `max_tokens`；flatten 时默认填型号上限 | `maxOutputTokens` |
| tool | `{type:'function', function:{…}}` | `{type:'function', name, …, strict:false}` | `{name, description, input_schema}` | `{functionDeclarations:[{…, parametersJsonSchema}]}` |
| mergeTurns | 无 | 无 | 去掉空消息，合并相邻的 user 消息 | 合并相邻的 user 消息，functionResponse 排在前面 |
| annotate | 无 | 无 | 最后一条消息的最后一个可缓存 block、最后一个 tool 都加 `cache_control: ephemeral` | 无 |
| finalize | 无 | 无 | 默认加 interleaved-thinking beta；引用了 file 时加 files-api beta；设置了 `thinking.keep` 时加 context-management beta 和 `clear_thinking` edit | 无 |
| flatten | system 作为第一条 `role:system` 消息；合并 `extras` 和 `extra_body` | system 放进 `instructions`，消息放进 `input`，`store:false` | system 作为带 `cache_control` 的 text block；只有走 beta API 时 betas 才放进请求体，否则放进 `anthropic-beta` header | `{model, contents, config:{systemInstruction, tools, …params}}` |

**单条消息的转换（`message` 钩子）**

- **OpenAI Chat**：think 不放在 content 里，而是按 `reasoningKey` 回写成消息上的字符串字段：`reasoning_content` 或 `reasoning`；不认识的字段名会改成当前使用的标准字段名。`reasoning_details` 不属于标准协议，由 Kimi provider 处理。只有一段文本、或者是 tool result 时，content 用字符串，否则用 part 数组。image 的 file 引用转成 `{type:'file', file_id}`。
- **OpenAI Responses**：一条消息会拆成多个 item。think 变成独立的 `reasoning` item，连续且 `encrypted` 相同的 think 合并成一个 summary 列表。assistant 文本变成 `output_text`。tool result 变成 `function_call_output`，tool call 变成 `function_call`。o 系列、gpt-4.1 等型号的 system 角色改成 `developer`。
- **Anthropic**：tool result 变成 user 消息里的 `tool_result` block，里面可以放 text、image、video。think 变成带 `signature` 的 `thinking` block。tool call 的参数解析成 JSON 放进 `input`，解析失败时用 `{}`。历史中间出现的 system 消息变成 user 消息 `<system>…</system>`。
- **Google GenAI**：tool result 变成 `functionResponse`。函数名通过 call id 在历史里反查，结果只放文本，媒体作为 part 跟在后面。tool call 参数不是合法 JSON 对象时直接报 syntax 错误。思考签名放在 `thoughtSignature`；function call 的签名取自 `extras.thought_signature_b64`。

## Send 阶段

| 协议 | client 与发送 |
|---|---|
| OpenAI Chat、OpenAI Responses | OpenAI SDK，`maxRetries: 0`（重试由 policy 负责），`fetch: endpoint.fetch`（Node 宿主传入 `createHeadersTimeoutFetch`）。Chat 流式请求加 `stream_options.include_usage` |
| Anthropic | 把 `authorization` header 和 `ANTHROPIC_CUSTOM_HEADERS` 环境变量里的 header 都置空，防止 SDK 从环境变量注入；这个环境变量通过 `globalThis.process?.env` 读取，浏览器里直接跳过。使用 `endpoint.fetch`。按 `useBetaApi` 选择 `beta.messages` 或 `messages` |
| Google GenAI | SDK 不接受自定义 fetch，所以 `endpoint.fetch` 和 headers timeout 都不生效。取消靠 `Promise.race` 加 `abortableStream` 实现。不返回 headers，因此没有 requestId |

## Decode 阶段

涉及文件：`src/llm/generate.ts`、`src/llm/protocol/rules/tool-call-ids.ts`、`src/llm/protocol/rules/status.ts`、各协议的 `decode.ts`。

### 公共骨架

流式和非流式只在 send 上不同，decode 只有一条路径：

```ts
const chunks = stream
  ? receive(await base.sendStream(client, encodedRequest, signal), onEvent)
  : base.replay(receive(await base.send(client, encodedRequest, signal), onEvent));
const decoder = base.decoder(module, sink);
for await (const chunk of chunks) {
  decoder.push(chunk);
  if (sink.failed()) return;
}
decoder.end();
```

- **`replay(response)`** 是纯函数，把完整响应展开成该协议流式 chunk 的同一套词汇。因此非流式产出的 part、`tool_call_end`、finish 序列与流式一致，区别只是 part 粒度更粗、所有事件在响应到达后同步发完。
- **`decoder(module, sink)`** 是一个 chunk 级状态机，sink 在创建时绑定一次。`push` 处理一个 chunk；`end` 在流正常结束时调用，用来收尾解码器内部状态（目前只有 OpenAI Chat 用它关闭最后一个 tool call）。流中途出错或中止时不调用 `end`。
- `onDelta` 永远是增量：拼装统一交给 settle 的累积器。

单个 attempt 内事件的顺序约定：每个 function part 之后、下一个 function part 之前恰好有一个 `tool_call_end`；`finish` 在所有 part 和 `tool_call_end` 之后；`message_id` 最多一次，位置不定；`usage` 是 patch，可以出现在任何位置（OpenAI Chat 的 usage chunk 在 finish 之后）。`headers`、`message_id`、`usage`、`finish` 都可能缺席。

`generate` 给协议的 `DecodeSink` 包了两层：

1. **事件 sink**：把解码器的回调转成 `LlmAttemptEvent`；相同的 message id 只发一次事件；`onError` 发出 `attempt.failed` 并设置失败标记，流式循环看到这个标记就提前退出。这是流中途报错的通道。`onToolCallEnd` 转成内部事件 `attempt.tool_call_end`，等 settle 把 call 拼装完成后，再对外发出 `llm.streaming.tool_call_end`。
2. **`uniqueToolCallIds(history, sink)`**：模型输出的 tool call id 如果与历史冲突，或在同一个响应里重复，就改写成 `<id>__2`，原始 id 保存在 `rawId`。这一步没有状态，所以重试结果是确定的。

### 四个协议在 decode 上的差异

| | OpenAI Chat | OpenAI Responses | Anthropic | Google GenAI |
|---|---|---|---|---|
| 流的形态 | 每个 chunk 是一个 delta | 带类型的事件状态机 | block 级事件（start、delta、stop） | 每个 chunk 都是完整的候选结构 |
| `replay` | 一个 chunk：`message` 改名为 `delta`，tool_calls 按位置补 `index`，其余字段原样保留 | 每个 output item 展开成 `output_text.delta`、`reasoning_summary_text.delta` 或 `output_item.added/done`，最后按 status 补 `response.completed`、`incomplete` 或 `failed` | `message_start` → 每个 block 的 start、delta（`input` 序列化成 `input_json_delta`，签名变成 `signature_delta`）、stop → `message_delta` | 原样 `[response]` |
| 文本 | `delta.content` | `output_text.delta` | `text_delta` | `parts[].text` |
| 思考 | 从 `reasoning_content`、`reasoning`（或显式指定的字段）读字符串，标上 `reasoningKey` | `reasoning_summary_part.added` 发一个空 think 作为分段；`summary_text.delta` 是文本；`output_item.done`（reasoning）带上 `encrypted_content` | `thinking_delta`；`signature_delta` 变成 encrypted；`redacted_thinking` | `thought:true` 的 part，`thoughtSignature` 变成 encrypted |
| tool call | 按 `index` 缓冲，直到拿到函数名才发出 function，后续参数作为 `tool_call_part` 发出；缺 id 时生成 UUID。线上没有结束帧，结束是推断出来的：新 `index` 出现即关闭上一个 call，`finish_reason` 或 `end()` 关闭最后一个 | `output_item.added` 发出 function；收到参数 delta 时累计；`.done` 时校验最终参数是否以已累计的内容为前缀，只补发剩余部分，不一致就抛错；`output_item.done` 关闭这个 call | `content_block_start(tool_use)` 加上 `input_json_delta`；`content_block_stop` 关闭这个 call | 一次给出完整的 call。Gemini 没有可靠的 id，所以合成为 `name_id_8位hex`，签名放进 `extras`；解码器在完整 call 之后立即发出结束信号 |
| message id | 每个 chunk 的 `id` | 任何携带 `response` 对象的事件（`response.created` 起） | `message_start` | `responseId` |
| usage | prompt − cached 记为 inputOther，cached 记为 cacheRead | 从携带 `response` 对象的事件读（包括 `response.failed`），算法同左 | `message_start` 只发 input 部分，`message_delta` 发 output；有 cache_read 和 cache_creation | 只在带 finishReason 的那个 chunk 上发 |
| finish 映射 | stop、tool_calls、length、content_filter | completed；incomplete 再按原因区分（max_output_tokens 对应 truncated，content_filter 对应 filtered） | end_turn 和 stop_sequence 对应 completed；max_tokens 对应 truncated；pause_turn 对应 paused；refusal 对应 filtered | STOP、MAX_TOKENS；SAFETY、RECITATION 等对应 filtered |
| 流中途报错 | 无 | `error` 事件、`response.failed`、网关包裹的畸形错误，按 code 分类为 context_overflow、quota_exhausted、rate_limit | 无 | 无 |
| `decodeError` | SDK 错误类型，加上 `insufficient_quota` 判为 quota_exhausted | 复用 OpenAI Chat 的实现 | SDK 错误类型 | `ApiError`；从错误消息的 JSON 里解析 `google.rpc.RetryInfo` 作为 retryAfter |

所有协议最后都汇入 `rules/status.ts` 的 `toLlmStatusErrorMessage`。它先看状态码（429 是 rate_limit，401/403 是 auth），再用正则识别 context_overflow、request_too_large、overloaded、request_structure、image_format。这些分类直接决定 policy 阶段走哪个 recovery、是否重试。

## Provider 的差异

provider 由三部分组成：requester 预设（默认 baseUrl、protocol options；环境变量名在 `src/node/env.ts` 的 `PROVIDER_ENV` 里）、`protocol.with(patch)`、以及 `files` 上传器。代码在 `src/llm/builtin/provider/`。

### Kimi：Chat、Anthropic、Responses 三个协议各一份

- **三者共用**：
  - 媒体：image 额外支持 bmp、heic、heif，所有媒体在 tool result 中都原生支持，不再 relocate。
  - requestId 读 `x-trace-id` header。
  - Chat 和 Responses 的 `fillMaxOutputTokens` 用"上下文窗口 − 已用 token"，所以总会发送一个输出上限。
  - `decodeError` 额外识别 429 的欠费情况（按错误码和措辞），判为 quota_exhausted。
- **`kimiOpenAIProtocol`**：
  - 开启 strict thinking effort。
  - thinking 用 `thinking:{type, effort, keep}`，不用 `reasoning_effort`。
  - 输出上限用 `max_completion_tokens`。
  - video 只接受上传后得到的 `ms://` url。
  - 以 `$` 开头的工具转成 `builtin_function`；工具 schema 会做规范化，包括展开 `$ref` 和补全类型。
  - 带 tools 的 system 消息转成 `tools` 字段，这是动态工具的入口。
  - tool call 的 `extras` 原样透传。有 tool call 且正文为空时去掉 content 字段。`keep=all` 时保证消息上有 `reasoning_content` 字段（必要时为空字符串）。
  - decode 时把 `choices[0].usage` 提升到顶层。
  - `reasoning_details`（Kimi 网关独有，summary 段加一个 encrypted 元素）在这里处理（`kimi/reasoning.ts`）：
    - 解码：每个元素变成一个带 `detailsIndex` 的 think part；已经出现过 `reasoning_content` 时，summary 标为 `hidden`，因为原文才是展示用的字段。details 在交给基础协议之前解析，所以排在同一个 chunk 的原文和正文前面。
    - 回放：按 `detailsIndex` 把同一段合并，再按 index 升序写回，保证段数和顺序与服务端给的一致，流式交错到达也不会拆段。带 details 时一定同时写 `reasoning_content`：已有同名字段就用它，没有就用所有可见 think 的拼接。
- **`kimiAnthropicProtocol`**：thinking 不走 budget 模式，统一是 `enabled` 加 `output_config.effort`，并附带 context-management beta。requester 默认开启 `betaApi: true`。
- **`kimiResponsesProtocol`**：只改了媒体、`fillMaxOutputTokens` 和错误分类。

### DeepSeek：Chat 和 Anthropic 两个协议

- **能力推断**：v4-pro 是纯文本模型，v4-flash 支持图片。
- **媒体**：只支持 image；接受 inline、url、file；url 必须是 http(s) 且长度不超过 8192。
- **legality**：sampling 只保留 temperature、topP、stop。Chat 只允许 `json_object`；Anthropic 不允许任何 responseFormat。输出上限 clamp 到 393216。
- **Chat**：没有 cacheKey；thinking 用 `{type}` 加 `reasoning_effort`；输出上限用 `max_tokens`；requester 设置 `reasoningKey: 'reasoning_content'`，回放时所有 think 都标成这个字段名。
- **Anthropic**：thinking 用 `enabled` 加 `output_config.effort`。
- **错误**：402 判为 quota_exhausted。

### GLM：只有 Chat

- **媒体**：image 只接受 png、jpeg；video 只接受 url；两者在 tool result 中都 relocate。
- **legality**：sampling 只保留 temperature、topP、stop；只允许 `json_object`；没有 cacheKey。
- **thinking 按型号区分**：
  - glm-5.3 强制推理，`off` 报错；effort 分档映射（none、minimal、low 映射为 low，medium、high 映射为 high，xhigh、max 映射为 max），无法映射时报错。
  - glm-5.2 原样透传 effort。
  - 其他型号不发送 effort。
  - 设置了 `keep` 时加 `clear_thinking:false`。
- **消息**：全是文本的 part 数组压平成一个字符串。
- **decode**：`finish_reason: network_error` 走 `onError` 报 provider 错误，因而可以重试；`sensitive` 映射为 content_filter；`model_context_window_exceeded` 映射为 length。
- **错误**：业务码 1113、1308–1321 判为 quota_exhausted，1261 判为 context_overflow，1305 判为 overloaded。

### OpenAI、Anthropic、Google

这三家直接使用基础协议，没有 endpoint 预设；Node 宿主自行加上 `endpointFromEnv(PROVIDER_ENV.openai)` 等。Google 有 GenAI 和 Vertex 两个 requester，区别只在 `options.vertexai`。

## 结构要点

- **同一份 `MediaSupport` 用了两次**：policy 阶段用它决定媒体怎么物化，encode 阶段用它决定媒体是否换成占位。provider 改了媒体能力，两个阶段同时生效。
- **内容和控制参数的处理方式不同**：媒体、空白文本、未签名的 think 这类内容，目标端不接受时静默替换或丢弃。thinking `off`、responseFormat 这类控制参数，目标端无法照办时直接抛出 syntax 错误，不会静默降级。
- **provider 只换钩子，从不分叉流水线**。legalize 规则和 pass 顺序由核心层固定，provider 能改的只有 `LegalizeSpec` 的参数、各个 lower 钩子、`decoder`/`decodeError` 的包装，以及 endpoint 和文件上传器。
