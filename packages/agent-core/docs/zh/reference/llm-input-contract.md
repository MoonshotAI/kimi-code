# LLM 输入契约

这是一篇 reference 文档：列出 `LlmRequest` 可以包含什么、调用方必须保证哪些不变量，以及哪些情况由 llm 层自行适配。

## 请求维度（`src/llm/request.ts`）

| 字段 | 必填 | 内容 |
|---|---|---|
| `protocol` | 是 | `base`（一个 `Protocol`）、`options`（协议特有）、`stream`（默认 `true`） |
| `model` | 是 | `spec`（`LlmModelSpec`）、`thinking`、`maxOutputTokens`、`responseFormat`、`sampling`、`cacheKey` |
| `content` | 是 | `messages`、`usedTokens`（上下文窗口中已占用的 token 数） |
| `profile` | 否 | `systemPrompt`、`tools`（`deferred: true` 的工具不会发送） |
| `endpoint` | 否 | `baseUrl`、`headers`、`credentials`、`defaultBaseUrl`、`fetch`、`clientFactory`、`files` |
| `policy` | 否 | `resolvers`、`recoveries`、`retryables`、`retry` |

`createRequester().with(part)` 按字段合并各维度；endpoint 的 headers 按 key 合并。

## 消息（`src/llm/message.ts`）

- 角色：`system`、`user`、`assistant`（带 `toolCalls`）、`tool`（带 `toolCallId`）。
- 内容 part：`text`、`think`、`image_url`、`audio_url`、`video_url`。
- 媒体来源：`{ kind: 'url', url }`、`{ kind: 'inline', mimeType, data }`（base64）、`{ kind: 'file', id, mimeType }`（provider 的文件引用，通常由 store-ref resolver 产出）、`{ kind: 'store', ref }`。
- 媒体 part 上的 `omitted`（`degraded`、`stripped`、`budget`）表示"渲染为占位文本"；part 本身保留，以便这个决定可以重放。

## 调用方必须保证的不变量

违反任一条，本次运行以 `failed` 结束，错误为 `kind: 'syntax'`、`code: 'request_format'`，不会重试。

| # | 不变量 | 错误信息开头 |
|---|---|---|
| 1 | 每个 tool call id 在整段历史中唯一 | `Tool call id '<id>' is used by more than one tool call` |
| 2 | 每个 tool result 之前都有同 id 的 tool call | `Tool result '<id>' has no preceding tool call` |
| 3 | 一个 tool call 最多只有一个 result | `Tool call '<id>' has more than one result` |
| 4 | 每个 tool call 都有 result；被中断的调用需要宿主写一个明确的结果 | `Tool calls without a result: <ids>` |
| 5 | tool result 不能为空或只有空白 | `Tool result for '<id>' is empty` |
| 6 | 不能有 `store` 来源的媒体 part 到达 encode；需要注册一个 resolver 把它解析掉 | `Unresolved media reference '<ref>'` |

第 6 条只针对目标端能接受的媒体：已标记省略的媒体、模型或协议不支持的媒体，在检查之前就已经被换成占位文本。

## 由 llm 层适配（不报错）

| 输入 | 适配方式 | Notice code |
|---|---|---|
| 只有空白的文本 part | 去掉 | `whitespace_text_dropped` |
| 没有实质内容、也不带 tool 结构的消息 | 去掉 | `vacuous_message_dropped` |
| 和调用之间隔着其他消息的 tool result | 挪到紧跟调用的位置，按调用顺序排列 | `tool_result_reordered` |
| 超出协议字符集或长度的 tool call id | 只在本次请求里映射成不冲突的 id | 无 |
| 标记了 `omitted` 的媒体 | 对应原因的占位文本 | 无 |
| 模型能力没有开启的媒体类型（`capability.image_in` 等） | `[image omitted: not supported by this model]` | 无 |
| 协议没有声明的媒体类型，或不允许出现在 tool result 里 | `[image omitted: not supported by this provider]` | 无 |
| 来源形式或 MIME 不被协议声明接受 | `stripped` 占位文本 | 无 |
| tool result 里、协议只在 tool result 之外接受的媒体 | 挪到后面一条 user 消息 `Attached media from tool result:` 里；被挪空的 tool result 变成 `(see attached media)` | 无 |
| `maxOutputTokens`（缺省时用协议默认值） | `min(请求值, maxContextSize - usedTokens)`，至少为 1，再由协议 clamp；`'none'` 表示不发送上限 | 无 |
| `sampling` | 只保留协议支持的字段 | 无 |
| `cacheKey` | 协议没有 cache key 时去掉 | 无 |

Notice 以 `llm.notice` 事件发出，`source` 是对应的 pass 名。

## 模型能力

`effectiveModelSpec` 把 `protocol.capability(spec.name)`（按模型名推断）合并到 `spec.capability` 之下，显式声明的值优先。一个媒体 part 只有在有效能力开启了它的类型、并且协议的 `MediaSupport` 声明在该位置、该来源形式和 MIME 下接受它时，才会被发送。

| 协议 | 图片 | 视频 | 音频 |
|---|---|---|---|
| OpenAI chat | inline、url；基础 MIME；从 tool result 中挪出 | 未声明 | inline、url；任意 MIME；不能出现在 tool result 里 |
| OpenAI Responses | inline、url、file；基础 MIME | 未声明 | inline、url（仅 http/https）；mp3、mpeg、wav |
| Anthropic | inline、url、file；基础 MIME | inline、url；mp4、mpeg、quicktime、webm、mkv、avi、flv、3gpp | 未声明 |
| Google GenAI | inline、url、file；基础 MIME | inline、url、file；任意 MIME | inline、url、file；任意 MIME |
| Kimi（三种都是） | 基础协议之外再加 bmp、heic、heif | Kimi OpenAI：只能是上传后的 url；Kimi Anthropic：同 Anthropic | 同基础协议 |
| GLM（chat） | inline、url；png、jpeg；从 tool result 中挪出；仅视觉模型（`glm-5.3-flash*`、`glm-5v*`、`glm-4.xv`、`glm-4v*`） | 仅 url；从 tool result 中挪出；仅视觉模型 | 未声明 |
| DeepSeek（chat 和 Anthropic） | inline、url（http/https，最长 8192 字符）、file；基础 MIME；可原样出现在 tool result 里；`deepseek-v4-pro` 不支持视觉 | 未声明 | 未声明 |

基础图片 MIME 是 png、jpeg、gif、webp。Kimi 允许所有已声明的类型原样出现在 tool result 里。

## Thinking effort

`model.thinking` 的形状是 `{ effort, keep? }`，`effort` 取值为 `'off'`、`'on'`（模型默认）或具体字符串。把用户配置解析成这个值是宿主的事。

| 协议 | 行为 |
|---|---|
| Kimi OpenAI（`strictThinkingEfforts: true`） | 模型不支持 thinking → `off`；always-thinking 模型上的 `off` → 默认 effort；没有声明 efforts → `on`；`on` 或未声明的 effort → `defaultEffort`，没有则取声明列表的中间项 |
| Anthropic | 原样发送；不在 `supportEfforts` 里的 effort 会发出 `anthropic-thinking-effort-not-listed` |
| OpenAI chat 和 Responses | 原样发送；always-thinking 模型上的 `off`、没有 `offEffort` 时的 `off`、或在 `capability.thinking: false` 的模型上请求 effort → `thinking_config` 错误 |

## 协议特有的错误

| 协议 | 条件 |
|---|---|
| Anthropic | `responseFormat.type === 'json_object'`（必须提供 JSON schema） |
| Google GenAI | tool call 的参数不是 JSON 对象 |
| Kimi | 工具 JSON schema 中 `enum`/`const` 类型混杂或不是 JSON 值，或根节点不是对象 |
| DeepSeek | chat 上的 `json_schema` 响应格式；Anthropic 端点上的任何响应格式 |
| GLM | `json_schema` 响应格式；`glm-5.3*` 上的 thinking `off`；`glm-5.3*` 上 none、minimal、low、medium、high、xhigh、max 之外的 effort（`thinking_config`） |

声明了 `ModelLegality.responseFormats` 的协议，会以 `The '<type>' response format is not supported by this protocol.` 拒绝其他响应格式。

## Endpoint

| 字段 | 含义 |
|---|---|
| `baseUrl`、`defaultBaseUrl` | 按这个顺序解析；llm 层不读环境变量，Node 宿主合并 `src/node/env.ts` 里的 `endpointFromEnv(PROVIDER_ENV.<name>)` |
| `credentials.resolve()` | API key 和额外 headers；凭据给出的 headers 覆盖 `headers` |
| `fetch` | OpenAI、OpenAI Responses、Anthropic client 使用的传输函数；Node 宿主传入 `src/node/fetch.ts` 的 `createHeadersTimeoutFetch(ms)`，得到支持代理的 headers timeout |
| `clientFactory` | 完全替换协议 client（测试、自定义传输） |
| `files` | provider 能上传的 `kinds`，以及返回 `url` 或 `file` 来源的 `upload(file)`；供 store-ref resolver 使用，见 how-to 文档 |
