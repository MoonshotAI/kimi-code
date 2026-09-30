# Lifecycle of an LLM Request: Policy, Encode, Decode

This is an explanation document: it follows one `generate` call through its stages, describes what each stage does, and lists how protocols and providers differ at each stage. For the boundary rule and the layer map, see [LLM boundary and architecture](llm-boundary-and-architecture.md).

## Overview

A call is three nested layers, not three flat stages:

- The outer layer is **policy**: a run loop that spans multiple attempts.
- Each attempt runs **encode** (outbound conversion), then **send**, then **decode** (inbound conversion).
- Policy's settle step accumulates each attempt's event stream into one result; the final result is returned and emitted once as `llm.ended { outcome }`.

Protocol differences are expressed entirely through `PipelineSpec` hooks and `Protocol` methods. A provider differs by calling `.with(patch)` on a protocol to replace a few hooks, plus endpoint defaults and a file uploader.

```text
requester.generate(rest)                       src/llm/requester.ts: merges request dimensions
└─ runLlmRequest(request)                      src/llm/policy/policy.ts — policy loop
   ├─ emit llm.started                         once per run
   ├─ ledger.apply(messages)                   replays message rewrites from earlier recoveries
   ├─ policy.resolvers[*].resolve(...)         for example the store-ref resolver (async, does IO)
   ├─ settleLlmRequest(...)                    src/llm/policy/settle.ts — settle
   │   └─ generate(request)                    src/llm/generate.ts — one attempt
   │       ├─ effectiveModelSpec               merges capability inferred by the protocol
   │       ├─ base.encode(module)              == runPipeline — encode
   │       ├─ resolveEndpoint + base.client    (or endpoint.clientFactory)
   │       ├─ base.sendStream / base.send      — send
   │       └─ base.decodeStream / base.decode  — decode (sink wrapped by uniqueToolCallIds)
   ├─ remote failure → recoveries.proposeFirst llm.retrying { reason: 'recovery' }; the attempt counter resets
   ├─ retryable      → backoff and retry       llm.retrying { reason: 'backoff' }; Retry-After or exponential backoff
   └─ emit llm.ended { outcome }               once per run, on every path; same object as the return value
```

The two failure channels split inside `generate`:

- An error thrown during encode becomes an `attempt.failed` with `error.kind === 'syntax'`, skips recovery and retry, and ends the run with a `failed` outcome.
- An error during send or decode goes through `base.decodeError` and becomes an `attempt.failed` with a remote error kind.

## Policy stage

Files: `src/llm/policy/`, `src/llm/builtin/policy/`.

### Steps of each loop iteration

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

1. **Replay the recovery ledger** (`recovery.ts`). The ledger stores message rewrite functions. Every iteration reapplies them to the original history; the host's data is never mutated in place.
2. **Resolvers** (`MessageResolver`). This is the only entry point for tolerating or preprocessing input. The only built-in one is the store-ref resolver, described below.
3. **Settle** (`settle.ts`). It runs `generate` and uses `createMessageAccumulator` to assemble streamed parts into an `AssistantMessage`:
   - Adjacent text parts merge into one.
   - Think parts merge only when `encrypted`, `detailsIndex`, `hidden` and `reasoningKey` all match. Once a part carries `encrypted`, nothing more is appended to it.
   - `tool_call_part` deltas are appended to their function call by `index`.
   - Usage merges as patches: each field takes the latest value seen.
   - `requestId` is read from the headers, and timings are recorded (first-token latency, server decode time, client blocking time, and so on).
   - At the end, empty responses are detected: no content and no tool calls, or think-only output, becomes `empty_response`. An interrupted reply keeps whatever it can through `salvageInterruptedMessage`.
4. **Recovery**. Runs only on remote failures. `proposeFirst` takes the first proposal that actually changes the messages, records it once, resets the attempt counter to 1, and emits `llm.retrying { reason: 'recovery', strategy, action, error }`.
5. **Retry** (`retry.ts`), announced with `llm.retrying { reason: 'backoff', failedAttempt, nextAttempt, maxAttempts, delayMs, error }` before waiting:
   - Retryable by default: auth, connection, timeout, rate_limit, overloaded, provider; status errors only when the code is 408, 409, 429, 500, 502, 503, 504 or 529; `empty_response` unless it was caused by filtering.
   - At most 10 attempts by default. Backoff is 500ms × 2ⁿ, capped at 32s, plus up to 25% random jitter. A `Retry-After` value takes precedence.
   - With `infiniteRetry`, everything except syntax, abort and context_overflow is retried indefinitely.

### Boundary events

The `onEvent` of `runLlmRequest` (type `LlmRunEvent`) is the llm layer's outward event boundary. Contract: every call emits exactly one `llm.started` and one `llm.ended`; in between there are only streaming events, notices and `llm.retrying`.

| Event | When | Payload |
|---|---|---|
| `llm.started` | Entry of `runLlmRequest`, before resolvers and media upload | none |
| `llm.notice` | A pass or resolver adapted something | `notice` |
| `llm.streaming.headers` / `part` / `usage` / `finish` / `message_id` | Streaming within each attempt | Deltas |
| `llm.retrying`, `reason: 'backoff'` | An attempt failed and is retryable, before waiting | `error`, `failedAttempt`, `nextAttempt`, `maxAttempts`, `delayMs` |
| `llm.retrying`, `reason: 'recovery'` | An attempt failed and a recovery rewrote the messages | `error`, `strategy`, `action` |
| `llm.ended` | Before returning, on every path | `outcome: LlmOutcome` |

`LlmOutcome` is the same object `runLlmRequest` returns, with one shape per result:

- `{ type: 'done', message, usage, finish, messageId, requestId, timing, headers }`: the complete `AssistantMessage`, produced by settle's accumulator; there is no second accumulation.
- `{ type: 'failed', error, rawError?, message?, ... }`: `error.kind === 'syntax'` is a caller problem, any other kind is remote; `message` is the partial output. A non-abort exception thrown by a resolver also lands here (`kind: 'unknown'`), so `llm.started` is always paired with `llm.ended`.
- `{ type: 'aborted', message, ... }`: `message` is the salvaged part, possibly `null`.

The attempt-internal events (`LlmAttemptEvent` in `generate.ts`: `attempt.sending` and `attempt.failed`) only travel between `generate` and settle and never reach the boundary. Parts already emitted by a failed attempt are not retracted; hosts clear them on `llm.retrying`.

### Store-ref resolver

Files: `src/llm/builtin/policy/store-ref/resolve.ts`, `src/llm/builtin/policy/store-ref/materialize.ts`.

The store-ref resolver is the part of the policy stage most tied to protocols and providers. It reads `protocol.base.media` (`MediaSupport`) and `endpoint.files` (the provider's uploader).

For each media part, `materializePart` proceeds in this order:

1. A part already marked `omitted` becomes placeholder text. Hosts can customize the text through the `placeholder` port.
2. If the protocol does not support this media kind, or the model capability is off, the part is left unchanged. Encode's `legalize-media` turns it into a placeholder later.
3. An `inline` source is checked only for MIME and kind consistency. `url` and `file` sources pass through.
4. A `store` source (binary in host storage) is handled as follows:
   - Check the in-process memo, then the persistent upload cache. Both are keyed by "media kind + provider + baseUrl + account identity".
   - Read the bytes and determine the MIME: images prefer the sniffed type, other kinds prefer the declared one. If the protocol does not accept that MIME, the part becomes a `stripped` placeholder.
   - If the provider has `files` covering this kind, upload and get a `url` or `file` reference. On upload failure, 401/403 raises `UploadAuthError`; other errors fall back silently.
   - Otherwise, if the protocol accepts `inline`, encode as base64.
   - If neither works, the part becomes an `unavailable` placeholder.
5. **Budget**: when inline media in the request exceeds 20MB, the oldest items are dropped until the total is under 10MB. Dropped keys are kept in `budgetDropped` and stay dropped in later requests, so the same media does not flip in and out and break caching.
6. On `UploadAuthError`, if the credential provider can recover from it, `invalidate` refreshes the credentials and the whole pass runs once more.

### Built-in recoveries

| Recovery | Trigger | Action | Times |
|---|---|---|---|
| `structureRecovery` | `request_structure` | Merges adjacent assistant messages, drops leading non-user messages | Once |
| `credentialsRecovery` | `credentials.canRecover(error)` (401 for OAuth) | Calls `invalidate` before the next attempt to force a token refresh | Once |
| `createMediaDegradeRecovery` | `image_format` | Marks all current media `stripped` | Once per action |
| same | `request_too_large` | First `degraded` (keeps the 2 most recent media), then `stripped` if it still fails | Once per action |

Media recoveries only set the `omitted` marker; they never delete content. Encode's `legalize-media` is what turns the marker into placeholder text.

### Protocol and provider differences in the policy stage

The policy loop itself is protocol-agnostic. Differences enter in three places only:

- **`MediaSupport`** (declared by the protocol or provider): which media get materialized, which MIME types are accepted, whether inline is allowed.
- **`endpoint.files`** (supplied by the provider):

  | Provider | Uploaded kinds | Returned reference |
  |---|---|---|
  | Kimi | image, video | `url: ms://<id>`; the Anthropic-compatible entry rewrites the baseUrl to `/v1` |
  | DeepSeek | image only | `file: <id>`, 30-day lifetime, `expiresAt` one hour early; the Anthropic-compatible entry strips `/anthropic` |
  | OpenAI, Anthropic, Google, GLM | none | Everything is inlined as base64 |

- **The classification produced by `decodeError`**: the error kind decides which recovery applies and whether to retry. See the decode section.

## Encode stage

Files: `src/llm/protocol/pipeline.ts`, `src/llm/protocol/rules/`, each protocol's `lower.ts` and `legalize.ts`.

`defineProtocol` fixes `encode` to `runPipeline(definition, module)`. The pipeline has two halves:

```ts
const legal = legalize(input, pipeline, pipeline.cacheKey !== undefined, passes);
const converted = run('convert', convert(legal, pipeline));
const merged = run('merge-turns', mergeTurns(converted, pipeline.mergeTurns));
const annotated = run('annotate-cache', pipeline.annotate?.(merged) ?? merged);
const finalized = run('finalize-params', pipeline.finalize?.(annotated, legal) ?? annotated);
return run('flatten', pipeline.flatten(finalized, legal));
```

### First half: legalize, on canonical messages

The rules live in the core (`rules/index.ts` fixes the order); a protocol only supplies parameters through `LegalizeSpec`: `media`, `toolCallId`, `thinkingHistory`, `legality`.

| # | Pass | What it does | On violation |
|---|---|---|---|
| 1 | `legalize-media` | Replaces media with a placeholder for one of four reasons: already omitted, capability off (`unsupported`), not supported by the protocol at that position (`protocol_unsupported`), source form, MIME or URL not accepted (`stripped`) | Silent replacement |
| 2 | `verify-history` | Rejects unresolved store refs; checks tool exchanges: duplicate ids, orphan results, multiple results, empty results, calls without results | Throws a syntax error |
| 3 | `legalize-structure` | Drops blank text and messages without meaningful content; moves tool results right after their calls | Emits notices |
| 4 | `relocate-tool-media` | Media declared `inToolResult: 'relocate'` is moved out of tool results into a following user message ("Attached media from tool result:"); an emptied tool result gets "(see attached media)" | Silent |
| 5 | `legalize-tool-call-ids` | Maps ids through the protocol's `normalize` and `maxLength`; collisions get `_2`, `_3` suffixes | Silent |
| 6 | `legalize-thinking-history` | Applies the protocol's reasoning replay patterns | Silent |
| 7 | `legalize-model` | Checks the responseFormat allowlist; strict thinking effort correction; drops cacheKey when the protocol has no `cacheKey` hook; keeps only supported sampling fields; output cap = min(requested or fill value, context window − used tokens), then clamp; finally the protocol's `verify` | Throws a syntax error when the allowlist fails |

`legalize-media` runs before `verify-history`: a store ref the model cannot accept becomes a placeholder first and does not trigger the unresolved error. Only a store ref that both model and protocol accept but that no resolver handled is an error.

### Second half: lower, producing native structures

1. **`convert`**: params are shallow-merged in a fixed order: `cacheKey → thinking → responseFormat → maxOutputTokens → sampling`. Messages go through `message()` with flatMap, so one canonical message can produce several native ones. Tools are filtered for `deferred`, then mapped with `tool()`. The system prompt comes from `profile.systemPrompt`.
2. **`merge-turns`**: applies patterns on native messages.
3. **`annotate-cache`**: adds cache markers.
4. **`finalize-params`**: final parameter fixes based on the full native structure (for example beta flags).
5. **`flatten`**: builds the SDK request body and merges `options.extras`.

### Encode differences across the four protocols

**Media support (`MediaSupport`)**

| Protocol | image | audio | video |
|---|---|---|---|
| OpenAI Chat | png, jpeg, gif, webp; inline, url; relocate in tool results | any MIME; inline, url; unsupported in tool results | unsupported |
| OpenAI Responses | inline, url, file; native in tool results | mp3, mpeg, wav only; url must be http(s) | unsupported |
| Anthropic | inline, url, file; native | unsupported | mp4, mpeg, quicktime, webm, x-matroska, x-msvideo, x-flv, 3gpp; inline, url |
| Google GenAI | inline, url, file | same | same |

**Legalize parameters**

| Protocol | Tool call id | Thinking history | Allowed sampling | Other |
|---|---|---|---|---|
| OpenAI Chat | keeps only `[A-Za-z0-9_-]`, max 64 | `stampReasoningKey`: stamps think parts with the field name used for replay. Defaults to the last concrete field name in the history, else `reasoning_content`. With `options.reasoningKey`, every part is forced to that name | all 7 | — |
| OpenAI Responses | cuts everything after `\|`, then the same sanitize, max 64 | none | temperature, topP | — |
| Anthropic | sanitize, max 64 | `stripUnsignedThinking`: drops unsigned think parts; models with an unrecognized version keep them | temperature, topP, topK, stop | Clamps the output cap from a per-model table (for example 64K for opus-4-5); rejects `json_object`; an effort not in the known list only emits a notice |
| Google GenAI | not handled | none | all 7 | — |

**Lower hooks**

| Hook | OpenAI Chat | OpenAI Responses | Anthropic | Google GenAI |
|---|---|---|---|---|
| cacheKey | `prompt_cache_key` | `prompt_cache_key` | `metadata.user_id` | No hook; cacheKey is dropped during legalize |
| thinking | `resolveReasoningEffort` produces `reasoning_effort`. `on` sends nothing; `off` uses `offEffort`, and errors when the model always reasons or lacks an offEffort. When no concrete effort results and the history contains think parts, sends `medium` | Same resolution, produces `reasoning:{effort, summary:'auto'}` and `include:['reasoning.encrypted_content']` | Infers budget or adaptive mode from the model version. Adaptive produces `{type:'adaptive', display:'summarized'}` plus `output_config.effort`; budget produces `budget_tokens` (low 1024, medium 4096, high 32000). `off` errors when the model cannot disable thinking | gemini-3 uses `thinkingLevel`, other models use `thinkingBudget` (0, 1024, 4096, 32000); also sets `includeThoughts` |
| responseFormat | `response_format` | `text.format` | json_schema only, written to `output_config.format` | `responseMimeType: application/json` plus `responseJsonSchema` |
| maxOutputTokens | `max_completion_tokens` for o-series and gpt-5, `max_tokens` otherwise; hard ceiling 128K | `max_output_tokens` | `max_tokens`; flatten defaults to the model ceiling | `maxOutputTokens` |
| tool | `{type:'function', function:{…}}` | `{type:'function', name, …, strict:false}` | `{name, description, input_schema}` | `{functionDeclarations:[{…, parametersJsonSchema}]}` |
| mergeTurns | none | none | drops empty messages, merges adjacent user messages | merges adjacent user messages, functionResponse first |
| annotate | none | none | `cache_control: ephemeral` on the last cacheable block of the last message and on the last tool | none |
| finalize | none | none | interleaved-thinking beta by default; files-api beta when files are referenced; context-management beta and a `clear_thinking` edit when `thinking.keep` is set | none |
| flatten | system as the first `role:system` message; merges `extras` and `extra_body` | system in `instructions`, messages in `input`, `store:false` | system as a text block with `cache_control`; betas go in the body only on the beta API, otherwise in the `anthropic-beta` header | `{model, contents, config:{systemInstruction, tools, …params}}` |

**Per-message conversion (`message` hook)**

- **OpenAI Chat**: think parts are not placed in content; they are written back by `reasoningKey` as message-level string fields: `reasoning_content` or `reasoning`; an unrecognized field name is restamped to the standard name in use. `reasoning_details` is not part of the standard protocol and is handled by the Kimi provider. A single text part or a tool result uses string content; otherwise a part array. An image file reference becomes `{type:'file', file_id}`.
- **OpenAI Responses**: one message splits into several items. Think becomes a separate `reasoning` item; consecutive think parts with the same `encrypted` merge into one summary list. Assistant text becomes `output_text`. Tool results become `function_call_output`, tool calls become `function_call`. For o-series, gpt-4.1 and similar models, the system role becomes `developer`.
- **Anthropic**: a tool result becomes a `tool_result` block inside a user message, holding text, image and video. Think becomes a `thinking` block with `signature`. Tool call arguments are parsed as JSON into `input`, or `{}` if parsing fails. A system message in the middle of the history becomes a user message `<system>…</system>`.
- **Google GenAI**: a tool result becomes `functionResponse`. The function name is looked up in the history by call id; the result carries text only, with media as following parts. Tool call arguments that are not a valid JSON object raise a syntax error. Thought signatures go in `thoughtSignature`; a function call's signature comes from `extras.thought_signature_b64`.

Chat and Responses also provide an `extractToolText` variant: tool results keep plain text only, and media in tool results is treated as unsupported and replaced with placeholders.

## Send stage

| Protocol | Client and sending |
|---|---|
| OpenAI Chat, OpenAI Responses | OpenAI SDK with `maxRetries: 0` (policy owns retries) and `fetch: endpoint.fetch` (Node hosts pass `createHeadersTimeoutFetch`). Chat streaming adds `stream_options.include_usage` |
| Anthropic | Nulls the `authorization` header and headers named in the `ANTHROPIC_CUSTOM_HEADERS` env var, so the SDK cannot inject them from the environment; the env var is read through `globalThis.process?.env`, so browsers skip it. Uses `endpoint.fetch`. Chooses `beta.messages` or `messages` by `useBetaApi` |
| Google GenAI | The SDK takes no custom fetch, so `endpoint.fetch` and the headers timeout do not apply. Cancellation uses `Promise.race` and `abortableStream`. No headers are returned, so there is no requestId |

## Decode stage

Files: `src/llm/generate.ts`, `src/llm/protocol/rules/tool-call-ids.ts`, `src/llm/protocol/rules/status.ts`, each protocol's `decode.ts`.

### Shared skeleton

`generate` wraps the protocol's `DecodeSink` in two layers:

1. **Event sink**: turns decoder callbacks into `LlmAttemptEvent`s; a repeated message id emits only one event; `onError` emits `attempt.failed` and sets a failure flag, and the streaming loop exits early when it sees the flag. This is the channel for mid-stream errors.
2. **`uniqueToolCallIds(history, sink)`**: a model-produced tool call id that collides with the history, or repeats within the reply, is rewritten to `<id>__2`, with the original kept in `rawId`. The step is stateless, so retries are deterministic.

### Decode differences across the four protocols

| | OpenAI Chat | OpenAI Responses | Anthropic | Google GenAI |
|---|---|---|---|---|
| Stream shape | Each chunk is a delta | Typed event state machine | Block-level events (start, delta, stop) | Each chunk is a full candidate structure; the stream decoder reuses `decodeResponse` |
| Text | `delta.content` | `output_text.delta` | `text_delta` | `parts[].text` |
| Thinking | Strings from `reasoning_content`, `reasoning` (or an explicit field), stamped with `reasoningKey` | `reasoning_summary_part.added` emits an empty think as a separator; `summary_text.delta` is the text; `output_item.done` (reasoning) carries `encrypted_content` | `thinking_delta`; `signature_delta` becomes encrypted; `redacted_thinking` | Parts with `thought:true`; `thoughtSignature` becomes encrypted |
| Tool calls | Buffered by `index` until the name arrives, then a function is emitted and later arguments become `tool_call_part`; a missing id gets a UUID | `output_item.added` emits the function; argument deltas are accumulated; on `.done` the final arguments must start with what was accumulated, only the remainder is emitted, and a mismatch throws | `content_block_start(tool_use)` plus `input_json_delta` | Whole call at once. Gemini has no reliable id, so one is synthesized as `name_id_<8 hex>`, with the signature in `extras` |
| Usage | prompt − cached as inputOther, cached as cacheRead | Read from `response.completed`, same arithmetic | `message_start` emits the input part only, `message_delta` emits output; includes cache_read and cache_creation | Emitted only on the chunk that carries finishReason |
| Finish mapping | stop, tool_calls, length, content_filter | completed; incomplete split by reason (max_output_tokens → truncated, content_filter → filtered) | end_turn and stop_sequence → completed; max_tokens → truncated; pause_turn → paused; refusal → filtered | STOP, MAX_TOKENS; SAFETY, RECITATION and similar → filtered |
| Mid-stream errors | none | `error` events, `response.failed`, gateway-wrapped malformed errors, classified by code as context_overflow, quota_exhausted, rate_limit | none | none |
| `decodeError` | SDK error classes, plus `insufficient_quota` → quota_exhausted | Reuses the OpenAI Chat implementation | SDK error classes | `ApiError`; `google.rpc.RetryInfo` parsed from the JSON in the message as retryAfter |

All protocols end in `toLlmStatusErrorMessage` from `rules/status.ts`. It looks at the status code first (429 is rate_limit, 401/403 is auth), then uses regexes to detect context_overflow, request_too_large, overloaded, request_structure and image_format. These kinds decide which recovery the policy stage applies and whether it retries.

## Provider differences

A provider has three parts: a requester preset (default baseUrl, protocol options; env var names live in `PROVIDER_ENV`, `src/node/env.ts`), `protocol.with(patch)`, and a `files` uploader. The code lives in `src/llm/builtin/provider/`.

### Kimi: one variant each for Chat, Anthropic and Responses

- **Shared by all three**:
  - Media: image adds bmp, heic and heif; every media kind is native in tool results, no relocation.
  - requestId comes from the `x-trace-id` header.
  - Chat and Responses set `fillMaxOutputTokens` to "context window − used tokens", so an output cap is always sent.
  - `decodeError` also detects 429 billing errors (by error code and wording) as quota_exhausted.
- **`kimiOpenAIProtocol`**:
  - Strict thinking effort is on.
  - Thinking uses `thinking:{type, effort, keep}` instead of `reasoning_effort`.
  - The output cap uses `max_completion_tokens`.
  - Video accepts only `ms://` URLs obtained by upload.
  - Tools whose names start with `$` become `builtin_function`; tool schemas are normalized, including `$ref` expansion and type inference.
  - A system message with tools becomes a `tools` field; this is the entry point for dynamic tools.
  - Tool call `extras` pass through. With tool calls and an empty body, the content field is removed. With `keep=all`, the message always has a `reasoning_content` field (empty string if needed).
  - Decode hoists `choices[0].usage` to the top level.
  - `reasoning_details` (Kimi gateway only: summary segments plus one encrypted element) is handled here (`kimi/reasoning.ts`):
    - Decode: each element becomes a think part with `detailsIndex`; once `reasoning_content` has appeared, summaries are marked `hidden`, because the plaintext is the display field. Details are parsed before the chunk is handed to the base protocol, so they come before the plaintext and body text of the same chunk.
    - Replay: parts with the same `detailsIndex` are merged into one segment and written back in ascending index order, so the segment count and order match what the server sent even when deltas arrive interleaved. Whenever details are sent, `reasoning_content` is sent too: the field's own text if present, otherwise all visible think text concatenated.
- **`kimiAnthropicProtocol`**: no budget mode for thinking; always `enabled` plus `output_config.effort`, with the context-management beta. The requester enables `betaApi: true` by default.
- **`kimiResponsesProtocol`**: changes only media, `fillMaxOutputTokens` and error classification.

### DeepSeek: Chat and Anthropic

- **Capability inference**: v4-pro is text-only, v4-flash supports images.
- **Media**: image only; inline, url, file; URLs must be http(s) and at most 8192 characters.
- **Legality**: sampling keeps temperature, topP and stop only. Chat allows only `json_object`; Anthropic allows no responseFormat at all. The output cap is clamped to 393216.
- **Chat**: no cacheKey; thinking uses `{type}` plus `reasoning_effort`; the output cap uses `max_tokens`; the requester sets `reasoningKey: 'reasoning_content'`, so every think part is replayed under that field.
- **Anthropic**: thinking uses `enabled` plus `output_config.effort`.
- **Errors**: 402 becomes quota_exhausted.

### GLM: Chat only

- **Media**: image accepts png and jpeg only; video accepts URLs only; both relocate out of tool results.
- **Legality**: sampling keeps temperature, topP and stop only; only `json_object`; no cacheKey.
- **Thinking per model**:
  - glm-5.3 always reasons, so `off` errors; efforts are tiered (none, minimal, low → low; medium, high → high; xhigh, max → max), and an unmappable effort errors.
  - glm-5.2 passes the effort through.
  - Other models send no effort.
  - `keep` adds `clear_thinking:false`.
- **Messages**: part arrays that are all text are flattened into one string.
- **Decode**: `finish_reason: network_error` goes through `onError` as a provider error and is therefore retryable; `sensitive` maps to content_filter; `model_context_window_exceeded` maps to length.
- **Errors**: business codes 1113 and 1308–1321 become quota_exhausted, 1261 becomes context_overflow, 1305 becomes overloaded.

### OpenAI, Anthropic, Google

These use the base protocols directly with no endpoint preset; Node hosts add `endpointFromEnv(PROVIDER_ENV.openai)` and so on. Google has GenAI and Vertex requesters, which differ only in `options.vertexai`.

## Structural takeaways

- **One `MediaSupport` is used twice**: the policy stage uses it to decide how to materialize media, and encode uses it to decide what becomes a placeholder. A provider that changes media support changes both stages at once.
- **Content and control parameters are treated differently**: content such as media, blank text or unsigned think parts is silently replaced or dropped when the target cannot take it. Control parameters such as thinking `off` or responseFormat raise a syntax error when the target cannot honor them; they are never silently downgraded.
- **Providers replace hooks; they never fork the pipeline**. Legalize rules and pass order are fixed by the core. A provider can change only `LegalizeSpec` parameters, lower hooks, wrappers around `decode` and `decodeError`, and the endpoint and file uploader.
