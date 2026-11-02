# llm Module Guide

llm is a standalone LLM request library inside the human layer (`src/human/llm/`). It owns one complete request: a typed request contract, protocol encoding and decoding, streaming facts, thinking, media, error classification, and policy-driven attempts. The v2-compatible requester, provider catalog, media store, and turn orchestration live in adjacent modules rather than inside the core.

## Design Principles

1. **Minimal boundary: llm = "a single request"**. The core composes a request with `createRequester().with(...)` and returns an `LlmOutcome` from `generate`. It does not own the v2 A-event requester, provider catalog refresh state, usage accounting, HistoryMessage/meta, compaction, switch, the media file system, or Tool Message assembly.
2. **Streaming-native; outcomes and events have separate roles**. Core request execution returns `done / failed / aborted` as an `LlmOutcome` and emits run/stream events as they arrive. The A-vocabulary boundary in `src/human/llm-requester/` exposes the existing closed event union (`llm.sent`, streaming headers/part/usage/finish/message_id, failed syntax/remote, request retrying, and done). Extra core notices, started/ended, retry, and tool-call-end facts are not added to that union. Streaming and non-streaming share the decoder: `stream: false` uses `send` and replays the complete response through it.
3. **The pipeline masks inter-protocol differences; protocol patches express provider customizations**. Every protocol is a `defineProtocol` object (`src/human/llm/protocol/protocol.ts`): `runPipeline` composes the encode stages (cacheKey → thinking → responseFormat → maxOutputTokens → sampling → tool → message → mergeTurns → annotate → finalize → flatten), with legalize passes for media, tool-call ids, provider patterns, thinking history, and model rules. A protocol also provides its stream decoder, non-streaming replay, error decoder, and client/send/sendStream transport. Providers derive protocols with `protocol.with(patch)`; Kimi lives in `src/human/llm/builtin/provider/kimi/protocol.ts`. Endpoint/env resolution, default headers, and the A `classifyError` option belong to the outer requester/adapter layer.
4. **Two-layer error model**. Local validation throws `SyntaxRequestFormatError` from `llm/protocol/errors.ts`, converted by `toLlmSyntaxErrorMessage`. The A boundary emits `llm.failed.syntax` for local message errors and `llm.failed.remote` for remote failures, preserving status fields, raw errors, request ids, and protocol-provided error diagnostics. A protocol can implement `diagnoseError` to extract provider-specific details from the current attempt instead of exposing a generic `traceId`. Core error values are translated to the A error union at the boundary; failed never also emits done.
5. **Stateless core + Loop-owned orchestration**. A core requester is an immutable composition of protocol, endpoint, model, profile, content, and policy dimensions. `ProtocolAdapterRegistry` initializes one for each request; `AgentLoopService` is the only long-lived owner of the Agent-level request facade. Other Agent services use `loopService.requester` for side requests, credentials, upload capability, and request snapshots rather than injecting another requester service. `generateModel` runs the core policy with one backoff attempt and registered recoveries; structural projection, media resolution, and their recoveries run per attempt through registered policies, while credential recovery and outer retry remain with the turn machine and Loop. The settle stage accumulates streamed parts, judges empty responses, records timing, emits the neutral `llm.sent` fact at each actual send, and synthesizes the outcome. Abort remains an A `llm.failed.remote` event with kind `abort`; its reason is preserved. The turn owns the user-facing accumulator and resets it on retry/recovery.
6. **No silent fallback**. Configuration is used exactly as given. Unsupported beta features, thinking settings, media, and empty responses fail explicitly rather than silently switching behavior. The existing main-line history policy is preserved: the core does not enable stricter tool-history verification, cleanup, or reordering as a side effect of the migration.
7. **Every variable capability is a contribution point**. Protocol patches, media upload/degradation, usage, protocol error diagnostics, and recovery plug in around the core. The core does not import the A requester, v2 DI, models-dev, or provider-catalog state.
8. **Data is data**. `LlmModelSpec` and `LlmRequest` are serializable core contracts. Core messages use the existing `imageUrl/audioUrl/videoUrl` media parts; data URLs, `kimi-file://` session references, and uploaded `ms://` file ids stay in those parts. `ModelCatalog` only owns model/provider metadata and default-model selection; it does not cache requesters or expose generate/ping. Upload capability is declared by `LlmEndpoint.files`, and media resolvers receive the model and initialized requester from Loop. `SessionMediaStore.put` stores bytes and metadata and returns a `kimi-file://` reference, while `get` reads them back. ReadMediaFile only produces references; the Media Resolver resolves them on the next request using the request model, protocol media support, endpoint files, and endpoint credential recovery. The v2 history/wire message shape remains in `src/human/message.ts`; its codec preserves roles and envelopes without introducing a second media representation.
9. **Message conversion uses a compiler paradigm**. Generic messages become protocol payloads through ordered, independent patterns followed by lowering. Tool-message conversion and media mapping are patterns too. Main-line tool-result placeholders, reasoning details, and provider-specific wire behavior remain covered by the existing tests.

## Architecture

```
human/
├── message.ts                 v2 history/wire Message model and accumulator
│
├── llm/                       single-request core
│   ├── message.ts             core Message and existing media part model
│   ├── request.ts             model, endpoint, protocol, profile, content, and policy dimensions
│   ├── response.ts            run/stream events, LlmOutcome, usage, timing, and notices
│   ├── endpoint.ts            credential-aware endpoint resolution
│   ├── requester.ts           createRequester + immutable .with() composition + generate
│   ├── generate.ts            attempt driver: encode → client → send/sendStream (+replay) → decode
│   ├── policy/                attempt loop, settlement, retry, recoveries, resolvers, and registry
│   ├── protocol/              defineProtocol, pipeline, patterns, shared rules, and protocol kits
│   └── builtin/
│       ├── protocol/          openai / openai-responses / anthropic / google-genai implementations
│       ├── provider/          core requester presets, including builtin/provider/kimi
│       └── policy/            built-in recoveries, including media degradation
│
├── llm-requester/             v2 A requester and platform compatibility
│   ├── requester.ts           closed A event union, config/content/control, and protocol names
│   ├── run.ts                 v2 A events/errors + .with() request + outcome → A events
│   ├── factories.ts           named A factories over core requester presets and env connections
│   ├── actor.ts               single-request actor used by the turn machine
│   ├── retry.ts / recovery.ts turn-driven retry and recovery policies
│   └── timeout.ts             headers-timeout and proxy fetch glue
│
├── provider-catalog/
│   ├── catalog.ts             refresh/upsert/remove/ping state machine and dual-source model merge
│   └── provider/providers/    catalog handles backed by core requester presets
│
└── media/                     media cache, refs, resolver, store, upload, and Kimi uploads
```

Host composition lives in `agent/loop/` and `llm-adapter/`: `requester.ts`, `projector.ts`, and `projection.ts` are ordinary objects constructed with the Loop, not scoped services. `llm-adapter/model/generate.ts` converts core outcomes into the existing `ModelRequestEvent` transport vocabulary without retaining a `ModelRequester` object.

Request lifecycle: Loop resolves the turn or side-request configuration and context → `ProtocolAdapterRegistry` initializes a core requester with protocol, model, endpoint, credential-aware headers, timeout fetch, and optional `LlmEndpoint.files` → `generateModel` applies profile/content and runs `runLlmRequest` with the ToolSelect/media-tool/structure/media resolvers and recovery ledger → each attempt applies inherited and newly proposed rewrites, runs ToolSelect, media-tool, structure, and media resolvers in order, then emits `llm.started` and records the resolved request → the protocol legalize/pipeline stages encode the request and filter deferred tools → the client uses `sendStream`, or `send` plus replay for non-streaming → settle produces the outcome and stream facts → the Loop or klient boundary emits the existing event vocabulary. ReadMediaFile stays registered and only produces `kimi-file` references; the media-tool resolver hides its schema, calls, and results when the model accepts neither image nor video, and the media resolver turns references into a capability hint, an uploaded file id, or inline base64. Full compaction, cache probes, and media tools use the same Loop facade; klient direct-generate creates only a call-scoped core requester and keeps its public contract unchanged.

Tool disclosure is a request-view concern rather than an execution permission. The Agent persists one immutable initial registry snapshot plus ordered runtime changes after MCP initialization; later requests reconcile the live registry into that ledger instead of rebuilding the initial snapshot. Capable models project the current versions through deferred tools, added/removed announcements, and SelectTools schema system messages delivered by `loop.remind`. Loaded state requires the exact current schema version, so a same-name modification invalidates the old selection and emits remove+add for reselection. Models without dynamically loaded tools use only the initial top-level tools, promoting initial deferred entries in the resolver copy while keeping runtime additions filtered; runtime changes remain as content-bearing system reminders rather than dynamic schemas or select instructions. Model switches never rewrite the persisted snapshot, change ledger, or context history. Explicit tool overrides remain unchanged.

## Rejected Schemes (do not reintroduce)

- A `ModelRequester` wrapper, scoped `AgentLLMRequesterService` / `AgentContextProjectorService`, or requester access through `IModelCatalog` — core composition initializes requests, Loop owns the Agent facade, and Catalog owns only metadata.
- Splitting the request actor into llmActor / llmStreamActor — one actor per request; non-streaming also accumulates over the stream.
- A dedicated llm state machine wrapping the request actor — the turn machine invokes the actor directly and owns retry/recovery.
- DDD domain-method wrapping (Generation Domain, etc.) — use the pipeline/protocol/provider layering instead.
- Per-request trait hook objects passed to requester factories — provider customization belongs in `protocol.with(patch)` composition.
- Binding customization into format closures — providers patch the protocol spec rather than wrapping the requester.
- A second `ProviderDefinition` / `Provider.createRequester()` route — built-in providers are core requester presets, and catalogs compose them through `CatalogProviderHandle`.
- A request adapter inside `llm/` — v2 events, env connections, provider catalog state, and platform glue stay in adjacent modules.
- Hoisting system messages out of their position on egress — system messages stay in place in history and are converted in place.
- llm emitting a `{message, meta}` Context object — meta belongs to the turn domain.
- Implementing the user-facing accumulator in llm instead of the turn — settle accumulates only for its own outcome; the turn owns the external message accumulator.
- Unlimited fallback for beta features — protocols are selected explicitly, and `betaApi` remains an options/model-driven opt-in.
