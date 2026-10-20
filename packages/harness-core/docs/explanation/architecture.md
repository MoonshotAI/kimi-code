# Architecture

This document explains how harness-core is put together: the two-package
split, the feature mechanism that everything product-side hangs off, and the
runtime rules (facades, events, remounts) that feature code must respect.

## The Two Layers

```
your host (CLI, desktop app, server, tests)
└── @moonshot-ai/harness-core        ← this package: the Kimi product
    ├── src/runtime/                 ← seam: createHarness, AgentRuntime, hooks, feature stores
    ├── src/features/ (44 features)  ← product behavior as createFeature units
    ├── src/feature-http/ -acp/ -remote-control/  ← transports (also features)
    └── src/host/                    ← fsSessionSpace (Node, on disk)
└── @moonshot-ai/agent-core          ← the runtime: no product decisions
    ├── src/kernel/                  ← Unit runtime on @vue/reactivity
    ├── src/loop/                    ← createLoop: the turn/step machine
    ├── src/session/                 ← sessions, agents, durable logs, SessionSpace port
    ├── src/app/                     ← createApp + createFeature + level units
    ├── src/store/  src/blob/        ← event-sourced logs; content-addressed blobs
    ├── src/llm/                     ← requester/policy/protocol/provider stack
    └── src/tool/  src/history/      ← tool contract & executor; history entries
```

agent-core owns mechanism: how a turn runs, what gets persisted, how units
mount. It has no root entry — you import domain subpaths
(`@moonshot-ai/agent-core/app/index`, `.../kernel/index`, …). Its own
`packages/agent-core/AGENTS.md` is the authoritative description of those
domains; the agent-core docs cover the LLM boundary, the loop, and sessions
in depth.

harness-core owns product: which tools exist, what the system prompt says,
which events a UI can subscribe to, how models are bound to agents. It has a
root export (`@moonshot-ai/harness-core`) that re-exports everything public.
Nothing in harness-core replaces an agent-core mechanism — features are
composed *on* the agent-core seam, never inside it.

## The Harness Seam

`createHarness` (`src/runtime/harness.ts`) is a thin wrapper over
`createApp`:

```ts
import { createHarness, memoryHarnessSpace } from '@moonshot-ai/harness-core';

const harness = createHarness({ space: memoryHarnessSpace() });
const session = await harness.app.create({ sessionId: 's1' });
const agent = await harness.ensureAgent(session); // MAIN_AGENT_ID by default
```

It adds three things to the plain `App`:

1. **A `HarnessSessionSpace`** — a `SessionSpace` that also hands out a
   per-session feature `Journal` (`featureJournal(sessionId)`), which backs
   the durable feature stores (see [Persistence](persistence.md)).
2. **A per-agent `AgentRuntime` registry** — `ensureAgent(session, agentId?)`
   opens an agent with harness-managed capabilities: a requester slot, live
   LLM policy arrays, a tool registry, and system prompt sections. Feature
   units reach this record through `useAgentRuntime()`. See
   [Agent Runtime](agent-runtime.md).
3. **Feature journal writers** — one shared `Writer` per session, used by
   every `useFeatureStore` in that session.

Everything else in harness-core — all 44 features and all three transports —
is built as *features* on top of this seam, using the same mechanism you
would use to add your own.

## The Feature Mechanism

### Three Levels, One Definition

A feature is a named bundle of up to three unit setups, one per level of the
domain tree:

```ts
import { createFeature } from '@moonshot-ai/agent-core/app/index';

export const myFeature = createFeature('my-feature', {
  app() {},     // runs once per app
  session() {}, // runs once per session
  agent() {},   // runs once per agent
});
```

`createFeature(name, { app?, session?, agent? })` throws if no unit is
given. Inside a setup you are in a kernel unit: `useApp()` / `useSession()` /
`useAgent()` return the domain object of your level (an agent unit sees all
three, a session unit sees session and app), and every kernel hook
(`useInject`, `useOn`, `watch`, `useCleanup`, …) is available. Setups run
synchronously at mount and must return `undefined`; asynchronous startup goes
through `useReady(promise)` so `app.create` / `session.open` await it.

A feature may carry props: `createFeature<E, P>` typing plus
`features.add(feature, { props })`, where the props object is passed to each
unit setup. Features with constructor options are instead exported as
factories that close over their props and return `Feature<void>` — the
dominant style in `src/features/` (`createPermission(props)`,
`createCompaction(deps)`, …); a few are plain constants (`todo`,
`interaction`, `providerCatalog`).

### Registration and Scope

`app.features.add(feature, scope?)` registers a feature and returns an async
remover. The scope decides the reach:

| Scope | `app` unit | `session` units | `agent` units |
|---|---|---|---|
| `{}` (default) | once | every session | every agent |
| `{ session: id }` | — | that session | every agent of it |
| `{ session: id, agent: id }` | — | — | that agent |

Sessions and agents created *after* the registration are covered; units
above the scope are skipped; a feature with no unit at or below the scope is
rejected with a `TypeError`. `features.delete(featureOrName, scope?)` and
`features.list(scope?)` complete the API. Registration is host state — it is
never persisted.

Registrations of the same feature at different scopes fold **root to node,
then the instance's own**: the nearest registration of a name wins. A
re-registration with the same feature object updates the mounted unit's
props in place; a different feature object under the same name remounts the
unit.

### Facades: `useExpose` / `useInject`

Features publish their public surface as **facades**. A facade token is a
`createFacadeToken<T>(key)`; the exposing unit calls
`useExpose(token, face)`; consumers inject it:

```ts
import { createFacadeToken, useExpose, useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

export const TodoRef = createFacadeToken<TodoFace>('todo');

// in the todo feature's agent unit:
useExpose(TodoRef, { items, state });

// in another unit (agent level or below in the same lineage):
const todo: Readonly<ShallowRef<TodoFace | undefined>> = useInject(TodoRef);
```

Three properties of the model matter:

- **Injection is reactive and optional.** `useInject` on a facade token
  returns a ref-like computed that is `undefined` until (and whenever) the
  facade is not exposed. Facades appear after the exposing unit finishes
  mounting and disappear when it starts unmounting. Consumers must tolerate
  `undefined` (or throw a clear "feature X is not installed" error, as the
  `useInteractions()` helper does).
- **Resolution walks the lineage.** The nearest ancestor (or the unit
  itself) that exposes the token wins, so a session-level exposure of
  `TelemetryRef` shadows the app-level one for everything below it. This is
  how the telemetry feature scopes its context per session and per agent.
- **Facades cross the unit boundary, not the layer boundary.** HTTP handlers
  cannot call `useInject` — they resolve facades from outside via
  `sessionFacade(root, Token, sessionId)` /
  `agentFacade(root, Token, sessionId, agentId)` (see
  [Serve HTTP](../how-to-guides/04-serve-http.md)).

[Facades](../reference/facades.md) lists every token the package exposes.

### Events: Fire, Enrich, Bubble

Units fire events with `useFire()`; listeners attach with `useOn(type,
handler)` inside units, or with `app.on(type, handler)` / `app.wait(type)`
at the root. Events **bubble up the unit lineage**: an event fired in an
agent feature unit is delivered to the agent node, then its session node,
then the root — which is what makes `app.on('todo.updated', …)` work from
outside the tree.

Before delivery, every event is **enriched with the `EventContext`
contributions of the firing node's lineage**: the session unit contributes
`{ sessionId }`, the agent unit contributes `{ agentId }`. A handler at the
root therefore always knows which session and agent an event came from, and
`app.wait(type, { match })` can filter on it. (Enrichment writes context
*under* the event's own fields — an event's explicit `agentId`, e.g.
`shell.started`'s, is not overwritten.)

Two more event sources feed the same channel:

- **Lifecycle events** — the agent unit fires `agent.opened` (with `source`
  and `reopened`) when an agent mounts and `agent.closed` when it unmounts;
  the app fires `session.created` / `session.deleted` /
  `session.meta_updated`.
- **Log forwarding** — each session/agent unit forwards the commits of its
  durable log as unit events, starting from the log version the object was
  opened at (`since`). This is how `message.appended`, `turn.ended`, and
  `agent.registered` reach `app.on`. Only *recorded* loop events forward —
  streaming deltas and inbox events stay loop-local; subscribe to
  `agent.loop` for those.

`app.on` has a typed form: `app.on(feature, type, handler)` narrows the
handler to the feature's declared event union (declared as
`createFeature<MyEvent>(...)`), and `app.on(feature, '*', handler)`
prefix-matches `<feature.name>.`. The full event surface is documented in
[Events](../reference/events.md).

### Remounts and the Re-entrancy Discipline

Feature units are not singletons. The level units mirror two reactive
sources — the live domain children (`app.sessions`, `session.agents`) and
the folded feature registrations — and apply changes **synchronously inside
the reactive trigger**, so a session or agent and its feature units are
fully mounted before `app.create` / `session.open` resolve. Unmounting, by
contrast, is asynchronous; feature removers await it (`settle()`).

Your feature's setup runs again, from scratch, whenever:

- an agent **reopens** (closed then opened — the new `Agent` object gets a
  fresh agent unit with fresh feature units; keyed by object identity),
- the same name is **re-registered with a different feature object**
  (remount), or
- the feature is **removed and re-added**.

Hence the re-entrancy discipline:

- **Pair every registration with its cleanup.** Loop hooks registered via
  the `use*Starting`/`useTool*` helpers and tool handlers via
  `useToolHandler` are removed synchronously in `onScopeDispose` when the
  unit starts unmounting, so a remounted feature reusing the same hook id
  never collides with its outgoing instance. If you touch the loop directly,
  do the same with `useCleanup`.
- **Do not assume singleton state in closures.** If instances of your
  feature can coexist across a remount boundary, key shared state by the
  domain object (`WeakMap<Agent, …>` / `WeakMap<Session, …>`), as
  `tool-select` and `spawn` do.
- **Durable state belongs in a feature store**, not in memory: it survives
  remounts by construction (see
  [Persist Feature State](../how-to-guides/03-persist-feature-state.md)).

## The Runtime Contribution Model

Features change agent behavior through **contributions**, not configuration
files. An agent-level unit calls harness hooks that register into the
agent's `AgentRuntime`:

- `useAgentTools(...)` — tool definitions into the registry **and** the
  loop's tool profile (with freeze-aware re-sync),
- `useSystemPrompt(...)` — a section into the assembled system prompt
  (settled once),
- `useMessageResolver` / `useLlmRecovery` / `useLlmRetryable` — entries into
  the live policy arrays read by every LLM request,
- `useFeatureStore(...)` — a durable, undo-aware event-sourced store,
- plus the agent-core loop hook helpers (`useStepStarting`,
  `useToolPermitting`, …) for turn-cycle intervention.

[Contribution Hooks](../reference/contribution-hooks.md) is the full table;
[Agent Runtime](agent-runtime.md) explains the semantics behind them.

## Where Things Live

| Area | Path |
|---|---|
| Harness, agent runtimes, hooks, feature stores | `src/runtime/` |
| Default feature bundle | `src/preset.ts` (`harnessPreset`) |
| Product features | `src/features/<name>/feature.ts` |
| HTTP/WebSocket transport | `src/feature-http/` |
| ACP transport | `src/feature-acp/` |
| Remote-control transport | `src/feature-remote-control/` |
| On-disk session space | `src/host/session-space.ts` |
| Runnable assembly (the tutorial) | `example/app.ts`, `example/cli.ts` |
