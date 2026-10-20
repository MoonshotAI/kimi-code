# harness-core Documentation

`@moonshot-ai/harness-core` is the Kimi product harness built on
[`@moonshot-ai/agent-core`](../../agent-core/AGENTS.md). agent-core ships the
runtime primitives — the kernel Unit runtime on `@vue/reactivity`, the
`createLoop` turn machine, the durable session domain, the event-sourced store
and blob store, and the app/feature seam (`createApp` / `createFeature`).
harness-core turns those primitives into a product:

- `src/runtime/` — the seam between agent-core and the product features:
  `createHarness`, `memoryHarnessSpace`, the per-agent `AgentRuntime`
  (requester slot, LLM policy arrays, tool registry, system prompt sections),
  the contribution hooks (`useAgentTools`, `useSystemPrompt`, …) and the
  durable feature stores (`useFeatureStore`, `undoAgentTurns`).
- `src/features/` — every Kimi product feature as a `createFeature` unit
  (todo, plan, permission, skill, mcp, compaction, provider-catalog, …).
- `src/feature-http/`, `src/feature-acp/`, `src/feature-remote-control/` —
  transport surfaces that expose the harness over HTTP/WebSocket, the Agent
  Client Protocol, and the remote-control tunnel.
- `src/host/` — `fsSessionSpace`, the on-disk `HarnessSessionSpace`.
- `src/preset.ts` — `harnessPreset`, the default feature bundle.
- `example/` — a runnable host that assembles the full stack; it is the
  canonical tutorial for this package.

## Documentation Map

### Explanation

- [Architecture](explanation/architecture.md) — the two packages, the three
  feature levels, facades, event bubbling, and the remount discipline.
- [Persistence](explanation/persistence.md) — loop logs, the session roster
  log, feature journals, blobs, and the `SessionSpace` layouts.
- [Agent Runtime](explanation/agent-runtime.md) — the `AgentRuntime` record,
  `ensureAgent`, tool/system-prompt freeze semantics, and managed model
  binding through provider-catalog.

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
  `useFeatureStore` scopes, dispatch, and undo-synchronized rewind.
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
import { createHarness, memoryHarnessSpace } from '@moonshot-ai/harness-core';
import { harnessPreset } from '@moonshot-ai/harness-core/preset';
import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject, watch } from '@moonshot-ai/agent-core/kernel/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';
```

(The package root re-exports `src/index.ts`; `harnessPreset` lives in
`src/preset.ts` and is imported via the `@moonshot-ai/harness-core/preset`
subpath.)
