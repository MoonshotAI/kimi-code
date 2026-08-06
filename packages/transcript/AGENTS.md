# transcript Agent Guide

The isomorphic transcript rendering data layer — agent-granular L1 store, idempotent L2 operations, `off/turn/block/delta` L3 subscription granularity, framework-free L4 view registry, and turn-cursor pagination. Pure TypeScript (browser-safe, no engine imports) and the sole owner of all transcript contract types (`src/contract/`); consumed by `packages/kap-server` (engine events → transcript, REST + WS surface; live stores backfill history from the persisted per-agent wire records — main on first attach, any agent on demand, cold sessions rebuild any agent — with 0-based turn ordinals matching the engine's).

## Cold rebuild

The cold rebuild is a two-level fold over `wire.jsonl` as the single source of truth: `history/groupTurns.ts` (context messages → turn tree) plus `history/foldFacts.ts` (non-context records → tasks, interactions, todos, goal/plan/swarm meta, and end-appended markers/taskrefs; interactions left pending at shutdown fold to `cancelled`).

## Plan content

Plan content is a recorded fact too: each ExitPlanMode review submission offloads the document to `agents/<agentId>/plan/<planId>/v<N>.md` and persists a reference-only `plan.revision` record (`{id, version, path, sha256, bytes}`), which projects — live and cold — to a `plan.revision` marker and the `modes.plan` badge (`{reviewPath, version}`).

## Op-batch sequencing contract

Owned here (`transcriptSeqSchema` in `contract/schema.ts`): a per-(session, agent) monotonic batch `seq` on `transcript.ops` / `transcript.reset` / the REST transcript response, the `transcript_since` subscription cursor, and the `GET .../transcript/ops` catch-up response shape — every field optional so pre-seq peers fall back to loss-signal-driven refreshes.

## Wire-level detail

Beyond the timeline, the model carries wire-equivalent detail: steps carry `usage` / `finishReason` / `timing` (LLM latencies) / `retry` / interrupt reason, turns carry `durationMs` / `error` / `usage`, tool frames carry the streamed `inputText` and the latest `progress`, tasks carry subagent `resultSummary` / `error` / `stateReason` / `usage`, `meta.agent` mirrors the agent status slices (model / usage / context / permission / phase), a global `prompts` entity (op `prompt.upsert`) tracks the prompt queue, and `hook.result` lands as a `'hook'` marker. These live-projected fields are NOT backfilled by the cold rebuild (known limitation).
