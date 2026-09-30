# LLM Layer Boundary and Architecture

This is an explanation document: it describes what the llm layer is responsible for, where its boundary sits, and why the code is shaped the way it is.

## Purpose

The llm layer turns one canonical request (`LlmRequest`, `src/llm/request.ts`) into a request for a concrete protocol and model, sends it, and turns the reply back into canonical messages and events. Hosts (agents, CLIs, servers) speak only the canonical contract; protocol and model differences stay inside the layer.

## The boundary rule

The layer draws one line:

| Concern | Owner | Behavior when it does not hold |
|---|---|---|
| Semantic invariants of the history (tool exchanges pair up, ids are unique, media is resolved) | Caller | `failed` outcome with a `syntax` error, never retried |
| Layout and representation differences between protocols and models | llm layer | Adapted silently, optionally with a notice |
| Tolerating input that violates the invariants (legacy sessions, foreign transcripts) | Caller, opt-in | Not done by the core; belongs in a `MessageResolver` |

The layer does not guess what an invalid history meant. Repairing it silently hides upstream bugs and loses data, so violations are reported as errors that point at the offending message. Everything a valid history needs in order to be accepted by a given protocol is the layer's job.

The contract is closed: messages produced by the layer, plus exactly one tool result written by the host for each tool call, always satisfy the invariants. The decode side enforces this for model output by rewriting tool call ids that collide with the history.

## Layers

| Path | Responsibility |
|---|---|
| `src/llm/request.ts`, `message.ts`, `response.ts`, `endpoint.ts` | Canonical contract: request dimensions, messages, events, errors, endpoint resolution |
| `src/llm/requester.ts` | Builder that merges request dimensions (`with`, `request`, `generate`) |
| `src/llm/policy/` | Run loop above a single attempt: resolvers, recoveries, retry, settling a stream into a result |
| `src/llm/generate.ts` | One attempt: encode, resolve endpoint, build client, send, decode, emit events |
| `src/llm/protocol/` | Mechanism: protocol contract (`protocol.ts`), encode pipeline skeleton (`pipeline.ts`), `pattern.ts`, error types (`errors.ts`) |
| `src/llm/protocol/rules/` | Rules the core applies to every protocol: legalize passes and their order, media acceptance, model legality, decode-side tool call id dedup, status error classification |
| `src/llm/protocol/kit/` | Opt-in helpers protocols may call; the core never runs them |
| `src/llm/builtin/protocol/<name>/` | One protocol: `legalize.ts`, `lower.ts`, `decode.ts`, `capability.ts`, `index.ts` |
| `src/llm/builtin/provider/` | Ready-made requesters with endpoint defaults; Kimi also provides file upload |
| `src/llm/builtin/policy/` | Built-in credential providers, recoveries (`structure.ts`, `media-degrade.ts`) and resolvers |
| `src/llm/builtin/policy/store-ref/` | Store-ref resolver: turns `store` refs into `url`, `file` or inline sources. Ports (`ports.ts`), mechanism (`resolve.ts` per request, `materialize.ts` per part, `session.ts` for memo and budget), replaceable `adapters/` (memory, blob upload cache) |
| `src/node/` | Node-only host glue: `endpointFromEnv` and `PROVIDER_ENV` (env var names), `createHeadersTimeoutFetch` (undici dispatcher with headers timeout and proxy env) |
| `src/image/` | Node-only image intake (compress, crop, dimensions); independent of `src/llm/` |

Dependency direction: `builtin` depends on `protocol`; the core never imports `builtin`. Inside `protocol/`, the mechanism reaches rules only through `rules/index.ts`; `rules/` uses only the leaf mechanism modules (`errors.ts`, `pattern.ts`) at runtime; `kit/` imports types only. `src/node/` depends on `src/llm/`, never the reverse.

Platform: everything under `src/llm/` uses only web globals (`fetch`, `crypto.subtle`, `performance`, `atob`, `btoa`) and runs in a browser bundle. `node:*`, `Buffer`, `process` and `undici` live only in `src/node/` and `src/image/`. The one exception is reading `ANTHROPIC_CUSTOM_HEADERS` through `globalThis.process?.env`, which mirrors the SDK's own runtime detection.

## Run loop (`runLlmRequest`, `src/llm/policy/policy.ts`)

A run starts with `llm.started` and ends with `llm.ended { outcome }`, exactly once each; `outcome` is the same `LlmOutcome` that is returned (`done`, `failed` or `aborted`). In between, each attempt:

1. Apply message rewrites recorded by earlier recoveries.
2. Run `policy.resolvers` in order (for example the store-ref resolver).
3. `settleLlmRequest` runs `generate` and accumulates the stream into an `LlmOutcome`; an empty reply becomes `empty_response`.
4. On a remote failure, the first recovery that proposes a change wins, is recorded once, the attempt counter resets, and `llm.retrying { reason: 'recovery' }` is emitted.
5. Otherwise, if the error is retryable, emit `llm.retrying { reason: 'backoff' }`, wait (`Retry-After` or exponential backoff) and retry.

Syntax failures skip steps 4 and 5. The boundary events are defined in `src/llm/response.ts` (`LlmRunEvent`); attempt-internal events (`LlmAttemptEvent`, `src/llm/generate.ts`) never reach the boundary.

## Encode pipeline (`src/llm/protocol/pipeline.ts`)

`runPipeline` provides tracing and notice routing; the order of the `legalize-*` passes lives in `rules/index.ts`.

| Pass | File | What it does |
|---|---|---|
| `legalize-media` | `rules/media.ts` | Replaces media the target cannot consume with placeholder text: omitted, not enabled by the model, not declared by the protocol at that position, or source form and MIME not accepted |
| `verify-history` | `rules/media.ts`, `rules/structure.ts` | Rejects unresolved store refs and broken tool exchanges |
| `legalize-structure` | `rules/structure.ts` | Drops blank text and empty messages, moves tool results next to their calls |
| `relocate-tool-media` | `rules/media.ts` | Moves media the protocol accepts only outside tool results into a user message after the tool results |
| `legalize-tool-call-ids` | `rules/structure.ts` | Maps ids to the protocol charset and length, collision-free |
| `legalize-thinking-history` | protocol pattern set | Protocol-specific replay of reasoning parts |
| `legalize-model` | `rules/model.ts` | Output token cap, sampling subset, cache key, strict thinking effort, protocol `verify` |
| `convert`, `merge-turns`, `annotate-cache`, `finalize-params`, `flatten` | `pipeline.ts` and protocol hooks | Build the native request |

`legalize-*` passes stay in canonical messages; `convert` onward works on native structures.

## Decode (`src/llm/protocol/protocol.ts`, `src/llm/protocol/rules/tool-call-ids.ts`, `src/llm/generate.ts`)

The protocol decoder writes parts into a `DecodeSink`. `generate` wraps that sink with `uniqueToolCallIds(history, sink)`: a tool call id that collides with the history, or repeats within the reply, becomes `<id>__2`, `<id>__3`, and the original is kept in `rawId`. The rewrite is stateless and depends only on the request history, so retries are deterministic and need no rollback.

## Decisions

| Decision | Reason |
|---|---|
| Tool exchange invariants are errors, not repairs | Repairs hid bugs and dropped data (orphan results, synthesized results, deduplication) |
| Tool call id uniqueness is enforced on decode, statelessly | The host stores decoded messages; encode only changes the outbound copy. Cross-request state gave no real guarantee after a session reload |
| Strict thinking effort lives in `ModelLegality.strictThinkingEfforts` | It is executed inside encode, so a protocol cannot declare strictness without enforcing it |
| Config parsing (thinking defaults, env vars) stays with the host | The layer receives resolved values, for example `ThinkingRequestOptions`, `baseUrl` and `credentials`; Node hosts use `endpointFromEnv` |
| Transport is injected as `endpoint.fetch` | Headers timeout and proxies are Node transport concerns a browser `fetch` cannot express; Node hosts pass `createHeadersTimeoutFetch(ms)`. OpenAI, OpenAI Responses and Anthropic clients use it; Google's SDK takes no custom fetch |
| One media placeholder table in `message.ts` | Encode and the store-ref resolver render the same omission reasons |
| Each protocol declares its media acceptance once (`MediaSupport`) | Encode and the store-ref resolver judge the same declaration; protocols no longer rewrite media in private patterns |
| Content the target cannot consume becomes a placeholder; a control parameter it cannot honor is an error | The model is told what was omitted; silently changing requested behavior (`json_object`, thinking `off`) is not acceptable |
| Uploaders return the reference shape (`url` or `file`) | The same protocol is served by providers with different file references, for example Anthropic file ids and Kimi `ms://` URLs |
| The boundary has a single `llm.started` / `llm.ended` pair; the result is distinguished inside `outcome` | A host can learn from events alone when and how a run ended; a failed attempt produces no terminal event, only `llm.retrying`. The complete message comes from settle's accumulator, so there is no second accumulation |
| `reasoning_details` is handled by the Kimi provider, not the OpenAI base protocol | It is a Kimi-gateway-only structure (summary segments plus ciphertext) that standard OpenAI Chat lacks; the base protocol only knows the `reasoning_content` and `reasoning` string fields |
