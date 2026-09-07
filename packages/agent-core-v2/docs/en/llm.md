# llm Module Guide

llm is a standalone LLM request library inside the human layer (`src/human/llm/`) that provides the complete capability of "a single LLM request": request encoding/decoding across multiple protocols (openai / openai-responses / anthropic / google-genai), streaming events, thinking, media, error classification, retry and recovery, and provider/model catalog management. It neither depends on nor is aware of any external agent framework; all responsibility boundaries and extension mechanisms follow the design principles below.

## Design Principles

1. **Minimal boundary: llm = "a single request"**. llm only handles request encoding/decoding and event emission. auth, usage accounting, HistoryMessage/meta, compaction, switch, the media file system, and Tool Message assembly are all out of scope — they either move up to the turn/agent layer or plug in as contribution points.
2. **Streaming-native; events are the contract**. The only outward surface is a single, purely serializable event stream (requester level: `llm.sent / headers / delta / usage / finish / message-id / failed.syntax / failed.remote / done`; the machine level adds `llm.retrying / llm.recovering`, and `llm.sent` carries the most recent recovery record). Streaming and non-streaming are isomorphic (non-streaming also accumulates over the stream, just without deltas). Events are emitted as they arrive — no caching, no fallback.
3. **format masks inter-protocol differences; trait expresses provider dialects**. format lives at the protocol layer and handles encoding/decoding of requests, responses, errors, usage, and finish. trait is a bundle of hooks a provider attaches (endpoint, headers, convertMessage, buildParams, withThinking, etc.). Protocol differences must not leak into the machine or into requester decorators.
4. **Two-layer error model**. Internally, code throws the SDK's native errors; local request validation throws the shared `SyntaxRequestFormatError` (`llm/syntax-errors.ts`), which the requester converts uniformly via `toLlmSyntaxErrorMessage`, with no intermediate layer. Externally there are only `llm.failed.syntax` (local message syntax errors, never retried) and `llm.failed.remote` (remote streaming errors, subdivided into connection / timeout / rate_limit / quota_exhausted / context_overflow / request_structure, etc.), converted by format at the boundary.
5. **Stateless core + state machine shell**. `generate(config, content, control)` is a stateless function; errors are delivered via onEvent, never thrown. The llm machine wraps a single request (messageResolvers, abort scope, event forwarding) and drives retry and recovery through the pure policy functions in retry.ts / recovery.ts: recovery re-sends with replacement messages produced by the pure `propose` function (attempt resets to 1), retry backs off in the `retrying` state (honoring Retry-After), and the machine emits `llm.recovering / llm.retrying` for each. Empty response is judged by `withEmptyResponseGuard` at the requester boundary and raised as `llm.failed.remote`, entering the same retry path. Abort is carried by an AbortController owned by the turn: the controller is passed into the machine and the request actor via `LlmInput.signal`, and the turn aborts it directly on `turn.abort`, with the request ending as `llm.failed.remote`; the request actor neither creates its own controller nor touches any signal on teardown, so a finished request can never abort a shared signal. The accumulator is held by the turn and fed by the event stream; on `llm.retrying / llm.recovering` the turn rolls it back and recreates it, so every attempt accumulates from zero while as much interrupted state as possible is preserved (the turn finishes the complete message out of the accumulator at `llm.done`).
6. **No silent fallback**. Configuration is taken exactly as given. For beta features, thinking, empty response, and similar scenarios, define explicit error conditions first, fail at request time, and guide the user to fix the configuration — never fall back silently.
7. **Every variable capability is a contribution point**. Providers, media upload/degradation, usage, traceId, and error recovery (compaction / media degradation) all plug in through extension points; the llm core contains none of these concepts.
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
├── protocol/             shared protocol layer (common across bases)
│   ├── base.ts           ProtocolName / ProtocolBase
│   ├── format.ts         ProtocolFormat: formatRequest + createStreamParser(sink callbacks)
│   ├── trait.ts          ProtocolTrait: the full set of provider dialect hooks
│   └── patterns.ts / rewrite.ts   MLIR-style Pattern Rewriter (Message N:M conversion)
│
├── requester/
│   ├── requester.ts      LlmRequester.generate(config, content, control);
│   │                     ExtraParams typed per protocol {openai?, responses?, anthropic?, googleGenai?}
│   ├── machine.ts        llm state machine (single request + retry/recovery + empty response
│   │                     judgment; emits llm.retrying / llm.recovering)
│   ├── retry.ts / recovery.ts   pure retry/recovery policy functions (driven by the llm machine; propose is pure)
│   ├── empty-response.ts withEmptyResponseGuard: judges empty responses at finish and raises llm.failed.remote
│   └── bases/            four protocol bases: openai / openai-responses / anthropic / google-genai
│                         each with format / lower / patterns / capability / extra-params / requester
│
├── provider/
│   ├── definition.ts     ProviderDefinition{id, protocols{base+trait}, media, models}
│   │                     createProvider() (no registry) → Provider{listModels, resolveModel, createRequester}
│   └── providers/        built-in providers such as standard (registered via contribution points)
│
├── provider-catalog.ts   xstate machine: refresh/upsert/remove/ping in, changed out;
│                         provider -> models structure; remote pulled vs local models dual sources of truth
│
└── media/                media contribution points: cache / degrade / ref / resolver / store / upload
```

Request lifecycle: `generate` receives (config, content, control) → format lowers the generic Message[] through the Pattern Rewriter into protocol requestParams → internalGenerate calls the official SDK → streaming chunks are converted by the stateless parser callbacks into `llm.delta/usage/finish/message-id` events → errors are converted by format into `llm.failed.*`; on success the requester emits `llm.done`, on failure it ends with `llm.failed.syntax / llm.failed.remote` and never emits `llm.done`. `withEmptyResponseGuard` judges empty responses at finish and raises `llm.failed.remote`; the llm machine first tries recovery on `llm.failed.remote` (replacement messages from the pure `propose` function, emitting `llm.recovering`), then retries with backoff (honoring Retry-After, emitting `llm.retrying`), and only lands in the failed final state once attempts are exhausted. The upper-layer turn holds the HistoryAccumulator, fed by the event stream, rolls it back and recreates it on `llm.retrying / llm.recovering`, and finishes the complete message at `llm.done`; usage accounting, tracing, compaction, and media degradation all attach to the event stream as plugins/contribution points.

## Rejected Schemes (do not reintroduce)

- Splitting llmActor / llmStreamActor into two actors — a single machine; non-streaming also accumulates over the stream.
- DDD domain-method wrapping (Generation Domain, etc.) — use the format/trait/provider layering instead.
- Functional `toWireMessage` / `WireAdapter` naming — use an adapter interface; no "Wire" in names.
- Provider registry / `defineProvider` — `createProvider` exporting a const.
- Hoisting system messages out of their position on egress — system messages stay in place in history and are converted in place.
- llm emitting a `{message, meta}` Context object — meta belongs to the turn domain; llm only emits events.
- Implementing the accumulator once in llm and once in the turn — the accumulator is held only by the turn and fed by the event stream.
- Unlimited fallback for beta features — protocols are split into `anthropic` / `anthropic_beta`; unspecified means unsent, misconfiguration means an error; a provider that needs beta features must use the `anthropic_beta` protocol explicitly.
