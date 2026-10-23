# llm Module Guide

llm is a standalone LLM request library inside the human layer (`src/human/llm/`) that provides the complete capability of "a single LLM request": request encoding/decoding across multiple protocols (openai / openai-responses / anthropic / google-genai), streaming events, thinking, media, error classification, retry and recovery, and provider/model catalog management. It neither depends on nor is aware of any external agent framework; all responsibility boundaries and extension mechanisms follow the design principles below.

## Design Principles

1. **Minimal boundary: llm = "a single request"**. llm only handles request encoding/decoding and event emission. auth, usage accounting, HistoryMessage/meta, compaction, switch, the media file system, and Tool Message assembly are all out of scope — they either move up to the turn/agent layer or plug in as contribution points.
2. **Streaming-native; events are the contract**. The only outward surface is a single, purely serializable event stream (requester level: `llm.sent / streaming.headers / streaming.part / streaming.usage / streaming.finish / streaming.message_id / failed.syntax / failed.remote / done`, plus `llm.request.retrying` when the caller retries an attempt below the turn and the attempt's streamed state must be discarded; the turn level adds `llm.retrying / llm.recovering`, and `llm.sent` carries the most recent recovery record). Streaming and non-streaming are isomorphic (non-streaming also accumulates over the stream, just without deltas — `stream: false` replays the complete response through the same decoder). Events are emitted as they arrive — no caching, no fallback.
3. **The pipeline masks inter-protocol differences; protocol patches express provider customizations**. Every protocol core is a `defineProtocol` object (`src/human/llm/protocol/protocol.ts`): an `encode` composed by `runPipeline` over a `PipelineSpec` (cacheKey → thinking → responseFormat → maxOutputTokens → sampling → tool → message → mergeTurns → annotate → finalize → flatten, preceded by the `legalize` passes: media → relocate → tool-call-ids → patterns → thinking-history → model), a stream `decoder` turning raw chunks into neutral sink callbacks, a `replay` for non-streaming, `decodeError`, and the `client`/`send`/`sendStream` transport. Customization is data flow through the spec: a provider derives its own protocol via `protocol.with(patch)` (kimi in `src/human/llm-kimi/protocol.ts` is the canonical example), overriding stages (`thinking`, `tool`, `message`, `legality`, `flatten`, `decoder`, …) instead of wrapping the requester. Endpoint/env resolution and default headers form the provider `connection`, error classification is a requester option (`classifyError`, hook-first), and model capability is a base field — none of them are pipeline business. Protocol differences must not leak into the turn or into requester decorators.
4. **Two-layer error model**. Internally, code throws the SDK's native errors; local request validation throws the shared `SyntaxRequestFormatError` (`llm/syntax-errors.ts`), converted uniformly via `toLlmSyntaxErrorMessage`, with no intermediate layer. Externally there are only `llm.failed.syntax` (local message syntax errors, never retried) and `llm.failed.remote` (remote streaming errors, subdivided into connection / timeout / rate_limit / quota_exhausted / context_overflow / request_structure, etc.), converted by the protocol's `decodeError` at the boundary.
5. **Stateless core + turn-driven orchestration**. `generate(config, content, control)` is a stateless function; errors are delivered via onEvent, never thrown. The A-vocabulary requester seam (`llm/requester/run.ts`) drives the run loop (`llm/policy/policy.ts` → `settleLlmRequest`) with a policy of `maxAttemptsPerStep: 1` and no recoveries, so exactly one attempt happens per call and the policy mechanism stays inert; the turn machine drives retry and recovery through the pure policy functions in retry.ts / recovery.ts: recovery is a strategy chain composed by the caller (the engine tries `credentialsRecovery` before the configured replacement-message strategies such as media degradation); each strategy's pure `propose` returns a self-describing record (`strategy`/`action`, optional replacement `attemptMessageOverride`, optional opaque `beforeNextAttempt` effect) — the turn runs `beforeNextAttempt` and/or swaps messages and re-enters `thinking` with attempt reset to 1; the override remains in use across subsequent retries of the same step until replaced or cleared before the next step; retry backs off in the `retrying` state (honoring Retry-After), and the turn emits `llm.recovering / llm.retrying` for each. The settle stage accumulates the streamed parts, judges empty responses itself, and the seam ends such requests as `llm.failed.remote` without a preceding `llm.done`; the turn's own done-path empty check therefore no longer fires, while `emptyResponseError` stays exported for direct consumers. Abort is carried by an AbortController owned by the turn: the controller is passed into the request actor via `LlmInput.signal`, the turn aborts it directly on `turn.abort`, and the request ends as `llm.failed.remote` with kind `abort`; the request actor neither creates its own controller nor touches any signal on teardown, so a finished request can never abort a shared signal. The accumulator is held by the turn and fed by the event stream; on `llm.retrying / llm.recovering / llm.request.retrying` the turn rolls it back and recreates it, so every attempt accumulates from zero while as much interrupted state as possible is preserved (the turn finishes the complete message out of the accumulator at `llm.done`). Parts already forwarded to the parent machine or UI by the interrupted attempt are not reclaimed; only the accumulator and the tool call id normalizer reset.
6. **No silent fallback**. Configuration is taken exactly as given. For beta features, thinking, empty response, and similar scenarios, define explicit error conditions first, fail at request time, and guide the user to fix the configuration — never fall back silently.
7. **Every variable capability is a contribution point**. Providers (via `protocol.with`), media upload/degradation, usage, traceId, and error recovery (compaction / media degradation) all plug in through extension points; the llm core contains none of these concepts.
8. **Data is data**. A model is pure, function-free data (endpoint url + model uniquely identifies a model), serializable and directly usable as generate input. The catalog is a derived `provider -> models` cache; the dependency direction only goes from models-dev into llm internals, never the reverse.
9. **Message conversion uses a compiler paradigm**. Converting generic Message[] into protocol payloads is an N:M mapping, done with an MLIR-style Pattern Rewriter: ordered, independent Patterns each rewrite a MessageRange into another MessageRange, followed by a final lowering. toolMessageConversion and media mapping are Patterns too.

## Architecture

```
llm/
├── message.ts            generic Message model (split by role; tool declarations are separate)
├── model.ts              LlmModel: pure data, provider+model+endpoint overrides
├── capability.ts / thinking.ts / usage.ts / finish-reason.ts / response-format.ts / syntax-errors.ts
├── errors.ts             two-layer LlmErrorKind (syntax | remote, each subdivided)
├── toolCallIdNormalizer.ts  streamed tool call id dedup: repeated raw ids are remapped in order
│
├── request.ts            core request contract: LlmModelSpec, LlmRequestModel, LlmSampling,
│                         LlmCredential(Provider), LlmEndpoint, LlmProtocolBinding (base+options+stream),
│                         LlmRequestProfile/Content, LlmRequest
├── response.ts           run-level types: LlmStreamEvent, LlmSentEvent, LlmRetrying, LlmTiming,
│                         LlmOutput, LlmOutcome, LlmNotice
├── endpoint.ts           ResolvedEndpoint + resolveEndpoint (credentials resolved per attempt)
├── generate.ts           attempt driver: encode → client → send/sendStream (+replay) → decoder;
│                         emits attempt.sending / streaming.* / attempt.failed
├── policy/
│   ├── policy.ts         runLlmRequest: the attempt loop (resolvers, recoveries ledger,
│   │                     retry with backoff) — wired single-attempt by the seam
│   ├── settle.ts         one attempt's settlement: accumulation, empty-response judgment,
│   │                     timing, outcome synthesis (done / failed / aborted)
│   ├── recovery.ts       pure recovery strategies + ledger (propose/record/apply)
│   └── resolver.ts       MessageResolver port for policy-driven message resolution
│
├── protocol/             shared protocol layer (common across bases)
│   ├── protocol.ts       Protocol / ProtocolDefinition / DefinedProtocol / defineProtocol (.with),
│   │                     DecodeSink/Decoder, ProtocolReply
│   ├── pipeline.ts       PipelineSpec stages + runPipeline + NativeModule
│   ├── rules/            legalize passes: media, model (legality/clamp/strict efforts),
│   │                     tool-call-ids, index (pass order)
│   ├── kit/              http (requestIdFromHeader) / params (withExtras)
│   ├── base.ts           ProtocolName / ProtocolBase / ProtocolRequesterOptions
│   ├── connection.ts     ProviderConnection: endpoint env declaration + default headers
│   └── rewrite.ts / patterns.ts   MLIR-style Pattern Rewriter (Message N:M conversion)
│
├── requester/
│   ├── requester.ts      LlmRequester.generate(config, content, control) — the A-vocabulary seam
│   │                     (LlmRequestEvent closed union; config gains stream?: boolean);
│   │                     ExtraParams typed per protocol {openai?, responses?, anthropic?, googleGenai?};
│   │                     LlmRequestConfig.credentialProvider: credential contribution point
│   │                     (resolve/canRecover/invalidate), resolved per attempt by the caller;
│   │                     factories and the credentialsRecovery strategy live in human/credentials
│   │                     (createStaticCredentialProvider / createOAuthCredentialProvider;
│   │                     createKimiOAuthCredentialProvider adapts Kimi OAuth tokens); the
│   │                     runWithCredentialRecovery / streamWithCredentialRecovery executors for
│   │                     direct callers live in llm-adapter/model/credential-recovery
│   ├── run.ts            the seam: config+content → LlmRequest, policy maxAttemptsPerStep:1,
│   │                     run-loop events → A vocabulary, outcome → llm.done / llm.failed.* /
│   │                     abort-as-remote; headers-timeout fetch per attempt
│   ├── actor.ts          request actor: a fromCallback wrapping a single request
│   │                     (messageResolvers, abort scope, event sendBack); invoked by the turn
│   ├── retry.ts / recovery.ts   pure retry/recovery policy functions (driven by the turn machine; propose is pure)
│   ├── empty-response.ts emptyResponseError: pure empty-response judgment (settle applies it
│   │                     at the source; the turn keeps it for its own checks)
│   └── bases/            four protocol bases: openai / openai-responses / anthropic / google-genai
│                         each with decode / legalize / lower / protocol (the defineProtocol object:
│                         client/send/sendStream/replay/decodeError), capability, extra-params,
│                         contract (wire types), and a thin requester.ts seam factory over createRunRequester
│
├── provider/
│   ├── definition.ts     ProviderDefinition{id, protocols{base+connection+classifyError+capability}, media, models}
│   │                     createProvider() (no registry) → Provider{listModels, resolveModel, createRequester}
│   └── providers/        built-in providers such as standard (registered via contribution points)
│
├── provider-catalog.ts   xstate machine: refresh/upsert/remove/ping in, changed out;
│                         provider -> models structure; remote pulled vs local models dual sources of truth
│
└── media/                media contribution points: cache / degrade / ref / resolver / store / upload
```

Request lifecycle: `generate` receives (config, content, control) → the caller resolves `config.credentialProvider` into a fully-credentialed model before each attempt (the request actor on the machine path), so requests always carry fresh credentials and a credential-refresh recovery (recoverable 401 → `credentials.invalidate()`, emitted as `llm.recovering` with strategy `credentials`) naturally re-resolves on the re-send (direct callers outside the state machines — ping, generate, full compaction, media upload — share the same single-retry recovery through `runWithCredentialRecovery` / `streamWithCredentialRecovery`) → the seam builds a `LlmRequest` (model spec from the resolved model, profile from systemPrompt+tools, policy single-attempt, endpoint with the static credential, per-attempt headers-timeout fetch) → `runLlmRequest` → `settleLlmRequest` → the attempt driver `generate.ts` encodes via the protocol pipeline (`legalize` passes normalize media, tool-call ids, provider patterns, thinking history, and model legality; `runPipeline` then lowers messages through the spec's `message` stage, converts tools, merges turns, annotates cache, finalizes and flattens params — kimi's protocol patch swaps or wraps individual stages at this level) → `client` + `sendStream` (or `send` + `replay` when `stream: false`) → streaming chunks are decoded into `llm.streaming.part / streaming.usage / streaming.finish / streaming.message_id` events → errors are converted by `decodeError` into `llm.failed.*`; the settle stage accumulates parts, times the attempt, and synthesizes the outcome: `done` (→ `llm.done`), `failed` (→ `llm.failed.syntax / llm.failed.remote`, never followed by `llm.done`), `aborted` (→ `llm.failed.remote` with kind `abort`). The turn holds the HistoryAccumulator, fed by the event stream, rolls it back and recreates it on `llm.retrying / llm.recovering / llm.request.retrying`, and finishes the complete message at `llm.done`; usage accounting, tracing, compaction, and media degradation all attach to the event stream as plugins/contribution points.

## Rejected Schemes (do not reintroduce)

- Splitting the request actor into llmActor / llmStreamActor — one actor per request; non-streaming also accumulates over the stream.
- A dedicated llm state machine wrapping the request actor — the turn machine invokes the actor directly and owns retry/recovery; the extra machine layer carried no state anyone consumed.
- DDD domain-method wrapping (Generation Domain, etc.) — use the pipeline/protocol/provider layering instead.
- Per-request trait hook objects passed to requester factories (the old OpenAITrait/AnthropicTrait/… seam) — provider customization belongs in `protocol.with(patch)` composition; the trait bag made every hook silently dead for protocols that ignored it and blurred which stage owned a behavior.
- Binding customization into the format as closures (a `createOpenAIFormat(trait)`, or hooks passed as formatRequest options) — the pipeline alternates pure stages explicitly; providers patch the spec, not the requester.
- Functional `toWireMessage` / `WireAdapter` naming — use an adapter interface; no "Wire" in names.
- Provider registry / `defineProvider` — `createProvider` exporting a const.
- Hoisting system messages out of their position on egress — system messages stay in place in history and are converted in place.
- llm emitting a `{message, meta}` Context object — meta belongs to the turn domain; llm only emits events.
- Implementing the accumulator once in llm and once in the turn — the accumulator is held only by the turn and fed by the event stream (the settle's internal accumulator serves only outcome synthesis).
- Unlimited fallback for beta features — protocols are split into `anthropic` / `anthropic_beta` via the `betaApi` option; unspecified means unsent, misconfiguration means an error; a provider that needs beta features must use the beta API explicitly.
