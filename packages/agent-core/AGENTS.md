# agent-core Agent Index

This file is the entry point for coding agents working in this package.

## Documentation Map

English:

- [LLM boundary and architecture](docs/llm/en/explanation/llm-boundary-and-architecture.md): boundary rule, layers, run loop, encode and decode stages, decisions.
- [Lifecycle of an LLM request](docs/llm/en/explanation/llm-request-lifecycle.md): policy, encode, send and decode stages step by step, with per-protocol and per-provider differences.
- [LLM input contract](docs/llm/en/reference/llm-input-contract.md): request dimensions, invariants that raise errors, adaptations, capability, thinking, endpoint.
- [LLM errors, retries and recoveries](docs/llm/en/reference/llm-errors.md): syntax and remote channels, error kinds, retry and recovery rules, notices.
- [Send images, video and audio](docs/llm/en/how-to-guides/send-binary-media.md): store refs, store-ref resolver, upload, budget, troubleshooting.

中文：

- [LLM 层的边界与架构](docs/llm/zh/explanation/llm-boundary-and-architecture.md)
- [一次 LLM 请求的生命周期](docs/llm/zh/explanation/llm-request-lifecycle.md)
- [LLM 输入契约](docs/llm/zh/reference/llm-input-contract.md)
- [LLM 错误、重试与恢复](docs/llm/zh/reference/llm-errors.md)
- [发送图片、视频和音频](docs/llm/zh/how-to-guides/send-binary-media.md)

## Reading Order

1. Boundary and architecture.
2. Request lifecycle, before changing a protocol, a provider, or the policy loop.
3. Input contract, before changing encode passes or what callers may send.
4. Errors, before changing error classification, retry or recovery.
5. Send binary media, before changing `src/llm/builtin/policy/store-ref/` or upload.

## Repository Shape

- `src/llm/`: canonical contract (`request.ts`, `message.ts`, `response.ts`, `endpoint.ts`), `requester.ts`, `generate.ts`.
- `src/llm/catalog/`: provider catalog store core (snapshot merge, discovery, ping, refresh queues, layered requester resolution).
- `src/llm/policy/`: run loop, resolvers, recoveries, retry, settle.
- `src/llm/protocol/`: mechanism (`protocol.ts`, `pipeline.ts`, `pattern.ts`, `errors.ts`); `rules/` for rules the core applies to every protocol; `kit/` for opt-in protocol helpers.
- `src/llm/builtin/`: protocols, providers, built-in policies.
- `src/llm/builtin/policy/store-ref/`: resolver that turns `store` refs into wire sources; ports, mechanism (`resolve.ts`, `materialize.ts`, `session.ts`) and replaceable `adapters/`.
- `src/node/`: Node-only host glue: env-based endpoints, a fetch with headers timeout and proxy.
- `src/image/`: Node-only image intake (compress, crop, dimensions), independent of `src/llm/`.
- `src/history/`: history domain on top of `src/llm/message.ts` — entries with meta, builders, steer merging, tool-result rendering, token estimation. Not part of the platform-free LLM layer.
- `test/`, mirroring `src/llm` and `src/image`.

## Commands

- `pnpm typecheck`
- `pnpm test`

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
- Write no code comments.
