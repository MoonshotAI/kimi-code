# harness-core Documentation

`@moonshot-ai/harness-core` is the Kimi product harness built on
[`@moonshot-ai/agent-core`](../../agent-core/AGENTS.md). agent-core ships the
runtime primitives — the kernel Unit runtime on `@vue/reactivity`, the
`createLoop` turn machine, the durable session domain, the event-sourced store
and blob store, and the app/feature seam (`createApp` / `createFeature`).
harness-core turns those primitives into a product:

- `src/app/` — `createApp`, the process root: session CRUD over a
  `SessionSpace` (agent-core); `app.open` / `app.create` return the
  `AppSession` session handler, whose `session.ensureAgent` /
  `session.forkAgent` open agents with the per-agent
  `AgentRuntime` registry (tool registry,
  host prompt section); the contribution hooks (`useAgentTools`,
  `useMessageResolver`, …) and durable feature stores (`useFeatureStore`)
  live in `hooks.ts` / `stores.ts` here.
- `src/runtime/` — the `AgentRuntime` record and `agentCaps`.
- `src/features/` — every Kimi product feature as a `createFeature` unit
  (todo, plan, permission, skill, mcp, compaction, provider-catalog, …).
- `src/feature-http/`, `src/feature-acp/`, `src/feature-remote-control/` —
  transport surfaces that expose the harness over HTTP/WebSocket, the Agent
  Client Protocol, and the remote-control tunnel.
- `src/presets/` — `base.ts` assembles an app instance with the full
  product feature set (`createDefaultApp`); `createDefaultHttp` /
  `createDefaultAcp` build on it and return the app with the HTTP
  (plus remote-control) or ACP transport mounted.
- `example/` — a runnable host that assembles the full stack; it is the
  canonical tutorial for this package.

## Documentation Map

### Explanation

- [Architecture](explanation/architecture.md) — the two packages, the three
  feature levels, facades, event bubbling, and the remount discipline.
- [Persistence](explanation/persistence.md) — loop logs, the session roster
  log, feature events sharing those logs, blobs, and the `SessionSpace`
  layouts.
- [Agent Runtime](explanation/agent-runtime.md) — the `AgentRuntime` record,
  `ensureAgent`, tool freeze semantics, the agent-core system prompt
  sections contribution point, and managed model binding through
  provider-catalog.

### Reference

- [Contribution Hooks](reference/contribution-hooks.md) — every hook a
  feature unit can call, one line each, with its module.
- [Events](reference/events.md) — every event reachable through `app.on`,
  including each feature's declared event union.
- [Facades](reference/facades.md) — every facade token a feature exposes and
  what the face provides.

### How-to Guides

- [Run a Turn](how-to-guides/01-run-a-turn.md) — assemble a harness, open a
  session and agent, attach a requester, run one turn.
- [Develop a Feature](how-to-guides/02-develop-a-feature.md) — write a
  `createFeature` with units, a facade, events, tools, and tests.
- [Persist Feature State](how-to-guides/03-persist-feature-state.md) —
  `useFeatureStore` scopes, dispatch, and the single-rewind undo.
- [Serve HTTP](how-to-guides/04-serve-http.md) — `createHttp`, the route
  layers, and consuming facades inside handlers.

## Quick Links

- New here? Read [Architecture](explanation/architecture.md) first, then run
  the example: `pnpm example` (see `example/app.ts` for the assembly).
- Adding a feature? Follow
  [Develop a Feature](how-to-guides/02-develop-a-feature.md) and keep
  [Contribution Hooks](reference/contribution-hooks.md) open.
- Wiring a transport or UI? [Facades](reference/facades.md) and
  [Events](reference/events.md) are the contract surface.
- agent-core's own docs (LLM boundary, request lifecycle, loop, session)
  live under `packages/agent-core/docs/`; its `AGENTS.md` is the authoritative
  architecture index.

## Import Conventions

harness-core has a root entry — everything public is re-exported from
`@moonshot-ai/harness-core`. agent-core has **no** root entry; import by
domain subpath:

```ts
import { createApp, createDefaultApp } from '@moonshot-ai/harness-core';
import { createFeature } from '#/app/index';
import { useInject, watch } from '#/composition-api/index';
import { MAIN_AGENT_ID, memorySessionSpace } from '@moonshot-ai/agent-core/session/index';
```
