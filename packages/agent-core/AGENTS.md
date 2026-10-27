# agent-core Agent Index

This file is the entry point for coding agents working in this repository.

## Documentation Map

English:

- [LLM boundary and architecture](docs/en/explanation/llm-boundary-and-architecture.md): boundary rule, layers, run loop, encode and decode stages, decisions.
- [Lifecycle of an LLM request](docs/en/explanation/llm-request-lifecycle.md): policy, encode, send and decode stages step by step, with per-protocol and per-provider differences.
- [LLM input contract](docs/en/reference/llm-input-contract.md): request dimensions, invariants that raise errors, adaptations, capability, thinking, endpoint.
- [LLM errors, retries and recoveries](docs/en/reference/llm-errors.md): syntax and remote channels, error kinds, retry and recovery rules, notices.
- [Send images, video and audio](docs/en/how-to-guides/send-binary-media.md): store refs, store-ref resolver, upload, budget, troubleshooting.
- [Make an LLM request](docs/en/how-to-guides/make-an-llm-request.md): llm layer only — requester, endpoint, generate, outcomes.
- [Run an agent loop](docs/en/how-to-guides/run-an-agent-loop.md): loop + llm — tools, runTurn, hooks, no persistence.
- [Run a session with subagents](docs/en/how-to-guides/run-a-session-with-subagents.md): session + llm — durable multi-agent sessions, subagent tools, no App layer.

中文：

- [LLM 层的边界与架构](docs/zh/explanation/llm-boundary-and-architecture.md)
- [一次 LLM 请求的生命周期](docs/zh/explanation/llm-request-lifecycle.md)
- [LLM 输入契约](docs/zh/reference/llm-input-contract.md)
- [LLM 错误、重试与恢复](docs/zh/reference/llm-errors.md)
- [发送图片、视频和音频](docs/zh/how-to-guides/send-binary-media.md)
- [发起一次 LLM 请求](docs/zh/how-to-guides/make-an-llm-request.md)
- [运行一个 agent loop](docs/zh/how-to-guides/run-an-agent-loop.md)
- [运行一个带 subagent 的 session](docs/zh/how-to-guides/run-a-session-with-subagents.md)

## Reading Order

1. Boundary and architecture.
2. Request lifecycle, before changing a protocol, a provider, or the policy loop.
3. Input contract, before changing encode passes or what callers may send.
4. Errors, before changing error classification, retry or recovery.
5. Send binary media, before changing `src/llm/builtin/policy/store-ref/` or upload.

## Repository Shape

- `src/llm/`: canonical contract (`request.ts`, `message.ts`, `response.ts`, `endpoint.ts`), `requester.ts`, `generate.ts`.
- `src/llm/policy/`: run loop, resolvers, recoveries, retry, settle, and the per-loop policy registry (`registry.ts`, exposed as `loop.policy`).
- `src/llm/protocol/`: mechanism (`protocol.ts`, `pipeline.ts`, `pattern.ts`, `errors.ts`); `rules/` for rules the core applies to every protocol; `kit/` for opt-in protocol helpers.
- `src/llm/builtin/`: protocols, providers, built-in policies.
- `src/llm/builtin/policy/store-ref/`: resolver that turns `store` refs into wire sources; ports (`RefStore`, `UploadCache`), mechanism (`resolve.ts`, `materialize.ts`, `session.ts` with the in-process memo and budget) and `adapters/blob.ts` (`createBlobRefStore` maps a failed integrity check to unavailable, `createBlobUploadCache` validates entries and ignores cache errors).
- `src/loop/`: the public entry `createLoop` (`create-loop.ts`), a `Loop` instance with plain methods, a `subscribe` event channel and a plain `state` projection — with `wait(type, { match, timeoutMs, signal })` awaiting a single emitted event over that channel. `AgentMachine` (`agent-machine.ts`) is the only runtime state owner: phase, held, inbox, durable state, turn/step, foreground and detached tool slots, requester, listeners and waiters all live in that one object. Commands and async completions synchronously commit state and queue public events; external hooks, requesters and executors run outside those commits. Public events use one FIFO and never drive another machine. Input commands return ack synchronously, including from listeners and hooks, or `undefined` once closed. `runTurn` returns its accepted turn's own Promise, `waitForIdle` uses direct idle waiters, and `close` is idempotent with a shared Promise and completes final event delivery before callers resume. Every async completion is checked against its turn/step/tool identity and settled flag, so late results cannot mutate newer work. `loop.requester` (`requester.ts`) is a `LoopLlmRequester` facade for side requests: each `request`/`generate` re-reads the loop's current base requester and fills it with the live history (`toRequestMessages` of the loop messages plus a `usedContextTokens` estimate) before applying the accumulated `.with()` parts, so terminal calls always run the base requester's own methods on the latest configuration and context. The base requester is runtime-only: `createLoop({ requester })` seeds it, `loop.setRequester(...)` swaps or clears it at any time with the next step picking it up, `loop.baseRequester` reads it back, and with none set every step or side request fails with `loop has no requester`. The profile is `LoopProfile { systemPrompt?: string; tools?: ToolDescription[] }` everywhere. `setSystemPrompt`/`setTools` accept at any time while open and record `system_prompt.settled`/`tools.settled`; an in-flight request keeps its input snapshot and the next request reads the latest sole state. `remind` only queues into the inbox. Prefix-cache policy stays with the host, using the loop's setters, reminders and `step.started` events. Hook semantics are unchanged: `step.starting` runs once per LLM request and may rewrite history or block; `tool.batch-starting` can block the whole batch; per call, `tool.starting` precedes `tool.permitting`, rewrites chain, the first block settles without running later hooks or the executor, and `skipPermitting` bypasses only the permission phase. The loop starts held and releases through `runTurn`, `continue`, `submit`, `notify` or successful `steer`. Each turn consumes at most one normal item plus the current notify/remind items; drain consumes side items only. Aborted turns restore unappended pending items and hold. Abort uses cooperative grace for requesting/acting, an immediate second abort, and identity-checked late completion. `close()` performs no-grace final settlement, including foreground calls and detached `tool.async_ended` events, then resolves. `input.unfinished` starts as interrupted and held; resumable `continue` closes unfinished tool/step records with `CRASHED`, emits `turn.resumed` under the original turn id and continues with the next step. Other release paths close the unfinished turn first; `remind`/`cancel` leave it intact, `setContext` rejects it, and close writes no recovery records. The loop holds no persistence. `record.ts` remains the durable contract: `LoopRecord` selection, `toLoopRecord`, `isLoopRecord` and `loopProjection` are unchanged, so live durable state still equals replay by construction.
  - `agent-machine.ts`: the OOP state machine and direct async turn/step/tool execution chain.
  - `contract/`: commands, emitted events, hook points and decisions, inbox, turn/step/tool outcomes and profile; there is no internal signal/fact protocol.
  - `guards.ts`: runtime type guards for values returned by hooks, executors and requesters.
  - `hook/`: registry, per-point runners with decision guards, failure reporting.
  - `request.ts`: the plain async LLM runner, with first-outcome settlement and progress callbacks; `requester.ts` remains the live-history side-request facade.
  - `state.ts`: state and operation types, pure inbox/scheduling/recovery helpers, durable recording and the public `loop.state` view; it does not create an independent store.
  - `tool/`: direct tool execution (`execute.ts`), outcome/entry helpers and detached-task waiting (`tasks.ts`); task waiters clean up on first completion, timeout or close.
  - `builtin/`: hooks shipped with the loop but registered by the host, e.g. `createMaxStepsHook`.
- `src/history/`: history domain on top of `src/llm/message.ts` — entries with meta, steer merging, tool-result rendering, token estimation.
- `src/store/`: event-sourced logs with one writer and many readers. The top level is platform-free and re-exported by `index.ts`; backends are imported by path. `commit.ts` is shared by the writer, in-process readers and remote clients: `Commit` (`seq`/`time` plus `rewind` and/or `events`) and the line codec (`encodeCommit`/`decodeCommit`/`parseLog`). `replica.ts` has `createReplica` (effective entries, rewind truncation, per-reader `view(projection)`). `writer.ts` holds the `Journal` port and `openWriter` (lazy per-log load, serialized `commit`, `subscribe(from)` with catch-up then live lines, a monotonic clock across logs).
  - `backend/`: one `Journal` per platform: `memory.ts`, `node.ts` (jsonl file per log, torn-tail truncation, writer lock) and `durable-object.ts` (Durable Object SQLite tables with commits split into parts).
- `src/blob/`: object-store-like conversion between files and refs, with caching; platform-free top level re-exported by `index.ts`, backends imported by path. `backend.ts` is the `BlobBackend` port (`has`/`read`/`write`/`delete` on keys and `list(prefix)` key enumeration; `read` returns `undefined` when missing). `store.ts` has `openBlobStore(backend, prefix = 'data')`: `put({ bytes, mimeType?, filename? })` encodes one record (length-prefixed JSON header plus bytes) under `<prefix>/<ref>` where `ref` is the record's sha256, `get` returns `undefined` for unknown refs and throws `BlobIntegrityError` on a hash mismatch, `delete(ref)` drops one record, and `list()` returns the keyspace's refs (only 64-hex entries count). The prefix partitions one backend into per-consumer keyspaces (e.g. fileHistory owns `file-history/`), which is what makes delete and list safe to use. `blobStores(backend)` is the caching factory behind session containers: one store instance per prefix, defaulting to `data`. `cache.ts` has `openBlobCache(backend, namespace)`: JSON values under `cache/<namespace>/<sha256(key)>`, so one backend serves both. Consumers adapt it to their own ports (store-ref in `src/llm/`, the session takes a `BlobStore` directly from its `SessionSpace` container).
  - `backend/`: `memory.ts`, `node.ts` (one file per key, atomic rename) and `durable-object.ts` (SQLite rows split into parts).
- `src/session/`: the session domain, the single implementation of every session and agent operation. State rules: facts are events defined next to their projection (`LoopRecord` + `loopProjection` in `src/loop/record.ts`, `agent.registered` and `session.meta_updated` + `sessionProjection` in `model.ts`); runtime state (inbox, running turn, open agents, open source) lives only in live objects; composite state (`SessionStatus`) is computed from both; derived values are never committed back as events. A log may also carry host-owned events appended by the caller (e.g. harness feature events): projections reduce only the event types they own, and `fork` copies only loop records (`isLoopRecord`). A session always has a store; "no persistence" is the memory journal and blob backend.
  - `model.ts`: `SESSION_LOG`/`AGENT_LOG_PREFIX`, the roster event, the `session.meta_updated` patch event (session title and generic metadata), and `sessionProjection` (roster plus the folded session meta).
  - `session.ts`: `createSession({ id, journal, blobs, source, lastTurn, liveAgentsMap, onLastTurn, onClosed })` returns a plain `Session` whose `liveAgents` is a map of live `Agent`s — a plain `Map` by default; a host that mirrors it reactively supplies the instance via `liveAgentsMap`. The session owns all persistence: an `Agent` binds one loop to its `agents/<id>` log — rehydrated from the `loopProjection` view (the settled profile, messages, `nextTurnId`, the unfinished turn and pending async tool notifications), recorded through `toLoopRecord` in per-microtask batches (`flush` commits the pending batch now), closed when a write fails — and exposes its registered `source` plus `loop`/`log`/`view`/`since`/`flush`/`close`. `open` registers the agent before its log is written and is idempotent for a live agent (an in-flight `closeAgent` of the same id is awaited first, so a late flush never lands in the reopened log); `fork` copies the source's effective records into a new log; `undo` (idle live agents only) rewinds the agent log to a turn start, hands the rewound messages to `loop.setContext` and re-settles any profile value the rewind dropped; orphan agent logs are registered on open. `update` validates and journals a `session.meta_updated` patch (title replaced, metadata shallow-merged); `updateSessionMeta(journal, patch)` appends the same event without mounting a session, for catalog-level writes to closed sessions. `lifecycle` (`'open' | 'closing' | 'closed'`) is a readonly, one-way field: once `close()` starts it flips to `'closing'` and `open`/`fork`/`undo`/`closeAgent` reject with `SessionError('closed')`, so references escaping a closed session fail deterministically instead of hitting a closing writer. The main agent's last finished turn is derived from its `loopProjection` view and reported through `onLastTurn`; `status()` combines it with the live loops.
  - `space.ts`: the `SessionSpace` port (catalog records with title, metadata, the `lastTurn` index and timestamps, plus a journal and blob container per session — `blobs(prefix?)` returns the default-keyspace store or a per-consumer keyspace over the same backend) and its memory implementation. The catalog's title and metadata are a rebuildable index of the session log's `session.meta_updated` fold (the journal is the source of truth; a catalog record written before the event existed is healed into the journal when the session is opened); `lastTurn` there is likewise a rebuildable index so status is available without loading the main agent log.
  - `backend/node.ts`: the on-disk implementation (`nodeSessionSpace(root)`: one directory per session with an atomic `record.json`, a `journal/` jsonl store and a `blobs/` store), imported by path like the store and blob backends.
- `src/tool/`: tool contract and the host-held executor. `contract.ts` holds `ToolResult`, `ToolExecuteInput`, `ToolExecutor` (`execute` only — what the loop calls) and `ToolExecutorHost` (`register` / `invalidate` / `restore`). `executor.ts` is `createToolExecutor`: one slot per name, an in-flight call keeps the handler it resolved, and `execute` resolves the slot, returns an in-band error for an unknown or invalidated name, runs the handler, then truncates text to `policy.maxResultChars`. `define.ts` is `defineTool`, which parses arguments with a `ToolSchema` before the typed `execute`. `schema.ts` is `zodSchema`. `createLoop` stores the object it was given on `loop.executor`.
- `src/utils/abort.ts`: abort scopes shared by loop turns and tool execution.
- `src/utils/hash.ts`: `sha256Hex` on `crypto.subtle`, shared by `src/blob/` and the store-ref resolver.
- `src/utils/now.ts`: the process-wide wall clock — `now()` reads the current source, `setNow()` swaps or resets it (default `Date.now`); `src/utils/clock.ts`: the same for the monotonic clock used for durations (default `performance.now`). Both are read at call time instead of being threaded through factory options.
- `src/utils/error.ts`: `errorCode` for errors with a `code`; `src/utils/durable-object.ts`: the `DurableObjectSql` storage shape shared by the store and blob backends.
- `src/node/`: Node-only host glue: env-based endpoints, a fetch with headers timeout and proxy.
- `src/image/`: Node-only image intake (compress, crop, dimensions), independent of `src/llm/`.
- `test/`, `example/generate.ts`, `example/loop.ts` (re-act loop demo with a fake requester), `example/session.ts` (session demo with a subagent tool, fake requester).
- The Unit runtime (`src/kernel/`, on `@vue/reactivity`) and the app/feature seam (`src/app/`: createApp + createFeature) live in `packages/harness-core`.

## Commands

- `pnpm typecheck`
- `pnpm test`
- `pnpm example`
- `pnpm example:loop`
- `pnpm example:session`

## Current Principles

- The caller guarantees the semantic invariants of the history; violations fail as syntax errors and are never repaired by the core.
- The llm layer adapts layout and representation differences between protocols and models.
- Tolerance for invalid input is opt-in and belongs in a `MessageResolver`, not in encode.
- Configuration parsing and environment variables stay with the host; the layer receives resolved values.
- `src/llm/` is platform-free: only web globals (`fetch`, `crypto.subtle`, `performance`, `atob`/`btoa`), no `node:*`, `Buffer`, `process` or `undici`; Node-specific code goes in `src/node/`.
- A protocol flag must be executed by the pipeline that declares it.
- Keep English and Chinese docs in sync when either changes.

## Agent Rules

- Preserve user changes. Do not revert unrelated dirty or untracked files.
- Write no code comments unless the user asks for them; comments are always in English.
