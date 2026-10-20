# LLM Input Contract

This is a reference document: it lists what an `LlmRequest` may contain, which invariants the caller must guarantee, and what the layer adapts on its own.

## Request dimensions (`src/llm/request.ts`)

| Field | Required | Content |
|---|---|---|
| `protocol` | yes | `base` (a `Protocol`), `options` (protocol-specific), `stream` (default `true`) |
| `model` | yes | `spec` (`LlmModelSpec`), `thinking`, `maxOutputTokens`, `responseFormat`, `sampling`, `cacheKey` |
| `content` | yes | `messages`, `usedTokens` (tokens already in the context window) |
| `profile` | no | `systemPrompt`, `tools` (`deferred: true` tools are not sent) |
| `endpoint` | no | `baseUrl`, `headers`, `credentials`, `defaultBaseUrl`, `fetch`, `clientFactory`, `files` |
| `policy` | no | `resolvers`, `recoveries`, `retryables`, `retry` |

`createRequester().with(part)` merges dimensions field by field; endpoint headers are merged key by key.

## Messages (`src/llm/message.ts`)

- Roles: `system`, `user`, `assistant` (with `toolCalls`), `tool` (with `toolCallId`).
- Content parts: `text`, `think`, `image_url`, `audio_url`, `video_url`.
- Media source: `{ kind: 'url', url }`, `{ kind: 'inline', mimeType, data }` (base64), `{ kind: 'file', id, mimeType }` (a provider file reference, normally produced by the store-ref resolver), `{ kind: 'store', ref }`.
- `omitted` on a media part (`degraded`, `stripped`, `budget`) means "render as a placeholder"; the part is kept so the decision can be replayed.

## Invariants the caller must guarantee

A violation ends the run with a `failed` outcome whose error is `kind: 'syntax'`, `code: 'request_format'`, and is never retried.

| # | Invariant | Error message starts with |
|---|---|---|
| 1 | Every tool call id is unique across the whole history | `Tool call id '<id>' is used by more than one tool call` |
| 2 | Every tool result follows a tool call with the same id | `Tool result '<id>' has no preceding tool call` |
| 3 | A tool call has at most one result | `Tool call '<id>' has more than one result` |
| 4 | Every tool call has a result; an interrupted call needs an explicit result written by the host | `Tool calls without a result: <ids>` |
| 5 | A tool result is not empty or whitespace-only | `Tool result for '<id>' is empty` |
| 6 | No media part with a `store` source reaches encode; register a resolver that lowers it | `Unresolved media reference '<ref>'` |

Invariant 6 only applies to media the target can accept: omitted media and media the model or protocol cannot accept become placeholders before the check.

## Adapted by the layer (no error)

| Input | Adaptation | Notice code |
|---|---|---|
| Whitespace-only text parts | Dropped | `whitespace_text_dropped` |
| Messages without meaningful content and without tool structure | Dropped | `vacuous_message_dropped` |
| Tool results separated from their call by other messages | Moved next to the call, in call order | `tool_result_reordered` |
| Tool call ids outside the protocol charset or length | Mapped to a collision-free id for this request only | none |
| Media marked `omitted` | Placeholder text for its reason | none |
| Media kind not enabled by the model (`capability.image_in` and so on) | `[image omitted: not supported by this model]` | none |
| Media kind not declared by the protocol, or not allowed inside tool results | `[image omitted: not supported by this provider]` | none |
| Source form or MIME type not accepted by the protocol declaration | `stripped` placeholder | none |
| Media in a tool result that the protocol accepts only outside tool results | Moved into a following user message `Attached media from tool result:`; an emptied tool result becomes `(see attached media)` | none |
| `maxOutputTokens` (or the protocol default when absent) | `min(requested, maxContextSize - usedTokens)`, at least 1, then protocol clamp; `'none'` sends no cap | none |
| `sampling` | Only the fields the protocol supports are kept | none |
| `cacheKey` | Dropped when the protocol has no cache key | none |

Notices are emitted as `llm.notice` events with `source` set to the pass name.

## Model capability

`effectiveModelSpec` merges `protocol.capability(spec.name)` (inferred from the model name) under `spec.capability` (explicit values win). A media part is sent only when the effective capability enables its kind and the protocol's `MediaSupport` declaration accepts it at that position, in that source form and MIME type.

| Protocol | Image | Video | Audio |
|---|---|---|---|
| OpenAI chat | inline, url; baseline MIME; relocated out of tool results | not declared | inline, url; any MIME; not in tool results |
| OpenAI Responses | inline, url, file; baseline MIME | not declared | inline, url (http/https only); mp3, mpeg, wav |
| Anthropic | inline, url, file; baseline MIME | inline, url; mp4, mpeg, quicktime, webm, mkv, avi, flv, 3gpp | not declared |
| Google GenAI | inline, url, file; baseline MIME | inline, url, file; any MIME | inline, url, file; any MIME |
| Kimi (all three) | Base protocol plus bmp, heic, heif | Kimi OpenAI: uploaded url only; Kimi Anthropic: as Anthropic | As the base protocol |
| GLM (chat) | inline, url; png, jpeg; relocated out of tool results; vision models only (`glm-5.3-flash*`, `glm-5v*`, `glm-4.xv`, `glm-4v*`) | url only; relocated out of tool results; vision models only | not declared |
| DeepSeek (chat and Anthropic) | inline, url (http/https, at most 8192 characters), file; baseline MIME; native in tool results; `deepseek-v4-pro` has no vision | not declared | not declared |

Baseline image MIME types are png, jpeg, gif and webp. Kimi accepts every declared kind natively inside tool results.

## Thinking effort

`model.thinking` is `{ effort, keep? }` with `effort` = `'off'`, `'on'` (model default) or a concrete string. The host resolves user configuration into this value.

| Protocol | Behavior |
|---|---|
| Kimi OpenAI (`strictThinkingEfforts: true`) | Model without thinking → `off`; `off` on an always-thinking model → default effort; no declared efforts → `on`; `on` or an undeclared effort → `defaultEffort`, else the middle declared effort |
| Anthropic | Sent unchanged; an effort not in `supportEfforts` emits `anthropic-thinking-effort-not-listed` |
| OpenAI chat and Responses | Sent unchanged; `off` on an always-thinking model, `off` without `offEffort`, or effort on a model with `capability.thinking: false` → `thinking_config` error |

## Protocol-specific errors

| Protocol | Condition |
|---|---|
| Anthropic | `responseFormat.type === 'json_object'` (a JSON schema is required) |
| Google GenAI | Tool call arguments that are not a JSON object |
| Kimi | Tool JSON schemas with mixed or non-JSON `enum`/`const` types, or a root that is not an object |
| DeepSeek | `json_schema` response format on chat; any response format on the Anthropic endpoint |
| GLM | `json_schema` response format; thinking `off` on `glm-5.3*`; an effort on `glm-5.3*` outside none, minimal, low, medium, high, xhigh, max (`thinking_config`) |

Protocols that list `ModelLegality.responseFormats` reject any other response format with `The '<type>' response format is not supported by this protocol.`

## Endpoint

| Field | Meaning |
|---|---|
| `baseUrl`, `defaultBaseUrl` | Resolved in this order; the layer never reads env vars, Node hosts merge `endpointFromEnv(PROVIDER_ENV.<name>)` from `src/node/env.ts` |
| `credentials.resolve()` | API key and extra headers; credential headers override `headers` |
| `fetch` | Transport used by the OpenAI, OpenAI Responses and Anthropic clients; Node hosts pass `createHeadersTimeoutFetch(ms)` from `src/node/fetch.ts` for a proxy-aware headers timeout |
| `clientFactory` | Replaces the protocol client entirely (tests, custom transports) |
| `files` | `kinds` the provider can upload and `upload(file)` returning a `url` or `file` source; used by the store-ref resolver, see the how-to guide |
