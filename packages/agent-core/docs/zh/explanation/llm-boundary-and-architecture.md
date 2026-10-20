# LLM 层的边界与架构

这是一篇 explanation 文档：说明 llm 层负责什么、边界划在哪里，以及代码为什么是现在这个形状。

## 定位

llm 层把一个规范请求（`LlmRequest`，`src/llm/request.ts`）转换成面向具体协议和模型的请求，发送出去，再把响应转换回规范的消息和事件。宿主（agent、CLI、server）只使用这份规范契约；协议和模型之间的差异都留在 llm 层内部。

## 边界规则

llm 层只划一条线：

| 关注点 | 由谁负责 | 不满足时的行为 |
|---|---|---|
| 历史的语义不变量（tool 调用和结果配对、id 唯一、媒体已解析） | 调用方 | `failed` 结果，错误类型为 `syntax`，不重试 |
| 协议、模型之间的布局和表示差异 | llm 层 | 静默适配，必要时发 notice |
| 容忍违反不变量的输入（旧会话、外来 transcript） | 调用方，显式开启 | 核心层不做；应放在一个 `MessageResolver` 里 |

llm 层不去猜测一份不合法的历史原本想表达什么。静默修补会掩盖上游 bug、丢失数据，所以违规一律报错，并在错误信息里指出出问题的消息。而一份合法的历史要被某个协议接受所需的一切转换，都是 llm 层的职责。

这份契约是闭环的：llm 层产出的消息，加上宿主为每个 tool call 回填恰好一个结果，一定满足不变量。对于模型输出，decode 侧会改写与历史冲突的 tool call id 来保证这一点。

## 分层

| 路径 | 职责 |
|---|---|
| `src/llm/request.ts`、`message.ts`、`response.ts`、`endpoint.ts` | 规范契约：请求维度、消息、事件、错误、endpoint 解析 |
| `src/llm/requester.ts` | 合并请求维度的构造器（`with`、`request`、`generate`） |
| `src/llm/policy/` | 单次 attempt 之上的运行循环：resolver、recovery、重试、把流收敛成结果 |
| `src/llm/generate.ts` | 一次 attempt：encode、解析 endpoint、构造 client、发送、decode、发事件 |
| `src/llm/protocol/` | 机制：协议契约（`protocol.ts`）、encode 流水线骨架（`pipeline.ts`）、`pattern.ts`、错误类型（`errors.ts`） |
| `src/llm/protocol/rules/` | 核心层对每个协议都强制执行的规则：legalize pass 及其顺序、媒体接受判定、模型参数合法化、decode 侧 tool call id 去重、状态码错误分类 |
| `src/llm/protocol/kit/` | 协议按需调用的可选积木，核心层从不执行 |
| `src/llm/builtin/protocol/<name>/` | 单个协议：`legalize.ts`、`lower.ts`、`decode.ts`、`capability.ts`、`index.ts` |
| `src/llm/builtin/provider/` | 预置 endpoint 默认值的 requester；Kimi 还提供文件上传 |
| `src/llm/builtin/policy/` | 内置的凭据提供者、recovery（`structure.ts`、`media-degrade.ts`）和 resolver |
| `src/llm/builtin/policy/store-ref/` | store-ref resolver：把 `store` 引用解析成 `url`、`file` 或内联来源。端口（`ports.ts`）、机制（`resolve.ts` 管单次请求，`materialize.ts` 管单个 part，`session.ts` 管 memo 和预算）、可替换的 `adapters/`（基于 `src/blob/` 的 ref store 和上传缓存） |
| `src/node/` | 只在 Node 下使用的宿主胶水：`endpointFromEnv` 和 `PROVIDER_ENV`（环境变量名）、`createHeadersTimeoutFetch`（带 headers timeout 和代理环境变量的 undici dispatcher） |
| `src/image/` | 只在 Node 下使用的图片预处理（压缩、裁剪、尺寸），与 `src/llm/` 无依赖 |

依赖方向：`builtin` 依赖 `protocol`，核心层从不 import `builtin`。在 `protocol/` 内部，机制只通过 `rules/index.ts` 调用规则；`rules/` 运行时只依赖叶子机制模块（`errors.ts`、`pattern.ts`）；`kit/` 只 import 类型。`src/node/` 依赖 `src/llm/`，反过来不行。

平台：`src/llm/` 下的代码只使用 web 全局对象（`fetch`、`crypto.subtle`、`performance`、`atob`、`btoa`），可以打进浏览器包。`node:*`、`Buffer`、`process`、`undici` 只出现在 `src/node/` 和 `src/image/`。唯一的例外是通过 `globalThis.process?.env` 读取 `ANTHROPIC_CUSTOM_HEADERS`，这与 SDK 自己的运行时检测方式一致。

## 运行循环（`runLlmRequest`，`src/llm/policy/policy.ts`）

一次运行以 `llm.started` 开始、以 `llm.ended { outcome }` 结束，两者恰好各一次；`outcome` 与返回值是同一个 `LlmOutcome`（`done`、`failed`、`aborted`）。中间每次 attempt：

1. 应用之前的 recovery 记录下来的消息改写。
2. 依次执行 `policy.resolvers`（例如 store-ref resolver）。
3. `settleLlmRequest` 调用 `generate`，把流收敛成 `LlmOutcome`；空响应会变成 `empty_response`。
4. 远端失败时，第一个提出有效改动的 recovery 生效，只记录一次，attempt 计数归零，发出 `llm.retrying { reason: 'recovery' }`。
5. 否则，如果错误可重试，发出 `llm.retrying { reason: 'backoff' }`，等待（`Retry-After` 或指数退避）后重试。

syntax 失败跳过第 4、5 步。边界事件的完整定义在 `src/llm/response.ts`（`LlmRunEvent`）；单次 attempt 内部的事件（`LlmAttemptEvent`，`src/llm/generate.ts`）不出现在边界上。

## Encode 流水线（`src/llm/protocol/pipeline.ts`）

`runPipeline` 只负责 trace 和 notice 路由；`legalize-*` 各 pass 的顺序在 `rules/index.ts` 里。

| Pass | 文件 | 作用 |
|---|---|---|
| `legalize-media` | `rules/media.ts` | 把目标端吃不了的媒体换成占位文本：已标记省略、模型能力未开启、协议在该位置未声明、来源形式或 MIME 不被接受 |
| `verify-history` | `rules/media.ts`、`rules/structure.ts` | 拒绝未解析的 store 引用和不合法的 tool 调用关系 |
| `legalize-structure` | `rules/structure.ts` | 去掉空白文本和空消息，把 tool result 挪到紧跟调用的位置 |
| `relocate-tool-media` | `rules/media.ts` | 把协议只在 tool result 之外接受的媒体，挪到 tool result 之后的一条 user 消息里 |
| `legalize-tool-call-ids` | `rules/structure.ts` | 把 id 映射到协议允许的字符集和长度，且不冲突 |
| `legalize-thinking-history` | 协议的 pattern 集合 | 协议特有的 reasoning 回放方式 |
| `legalize-model` | `rules/model.ts` | 输出 token 上限、sampling 子集、cache key、strict thinking effort、协议的 `verify` |
| `convert`、`merge-turns`、`annotate-cache`、`finalize-params`、`flatten` | `pipeline.ts` 和协议钩子 | 构建原生请求 |

`legalize-*` 系列 pass 仍在规范消息上工作，从 `convert` 开始处理的是协议原生结构。

## Decode（`src/llm/protocol/protocol.ts`、`src/llm/protocol/rules/tool-call-ids.ts`、`src/llm/generate.ts`）

协议解码器把 part 写进 `DecodeSink`。`generate` 用 `uniqueToolCallIds(history, sink)` 包住这个 sink：与历史冲突、或在同一响应内重复的 tool call id 会改写成 `<id>__2`、`<id>__3`，原始 id 保存在 `rawId` 里。这一步没有状态，只依赖本次请求的历史，所以重试的结果是确定的，也不需要回滚。

## 决策

| 决策 | 原因 |
|---|---|
| tool 调用关系的不变量违规直接报错，而不是修补 | 修补会掩盖 bug 并丢数据（丢弃孤儿 result、补造 result、去重） |
| tool call id 唯一性在 decode 侧无状态地保证 | 宿主存的是 decode 出来的消息，encode 只改出站副本；跨请求状态在会话重新加载后并不能真正兑现保证 |
| strict thinking effort 放在 `ModelLegality.strictThinkingEfforts` | 它在 encode 内部执行，协议不可能只声明 strict 却不执行 |
| 配置解析（thinking 默认值、环境变量）留在宿主 | llm 层接收的是已解析好的值，例如 `ThinkingRequestOptions`、`baseUrl`、`credentials`；Node 宿主用 `endpointFromEnv` |
| 传输层通过 `endpoint.fetch` 注入 | headers timeout 和代理是 Node 传输层的问题，浏览器的 `fetch` 表达不了；Node 宿主传入 `createHeadersTimeoutFetch(ms)`。OpenAI、OpenAI Responses、Anthropic 的 client 使用它；Google 的 SDK 不接受自定义 fetch |
| 媒体占位文本只有一张表，在 `message.ts` | encode 和 store-ref resolver 渲染的是同一套省略原因 |
| 每个协议只声明一次媒体接受能力（`MediaSupport`） | encode 和 store-ref resolver 依据同一份声明做判断；协议不再用私有模式改写媒体 |
| 内容类的东西目标端吃不了就换占位；控制参数无法照办就报错 | 模型会被告知哪些内容被省略；静默改变调用方要求的行为（`json_object`、thinking `off`）不可接受 |
| 引用的形状（`url` 或 `file`）由上传器返回 | 同一个协议会由文件引用方式不同的 provider 提供服务，例如 Anthropic 的 file id 和 Kimi 的 `ms://` URL |
| 边界事件只有一对 `llm.started` / `llm.ended`，结果在 `outcome` 里区分 | 宿主只靠事件也能知道运行何时结束、以什么结果结束；失败 attempt 不会产生终止事件，只产生 `llm.retrying`。完整消息由 settle 的累积器产出，不需要第二份累积逻辑 |
| `reasoning_details` 由 Kimi provider 处理，不在 OpenAI 基础协议里 | 它是 Kimi 网关独有的结构（summary 段加密文），标准 OpenAI Chat 没有；基础协议只认 `reasoning_content`、`reasoning` 两个字符串字段 |
