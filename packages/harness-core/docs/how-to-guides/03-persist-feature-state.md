# Persist Feature State

How to give a feature durable, undo-aware state with `useFeatureStore` — the
scope and projection choices, dispatch semantics, and the single-rewind
undo. The persistence model behind it is explained in
[Persistence](../explanation/persistence.md#feature-stores-usefeaturestore).

## The API

```ts
import { useFeatureStore, type FeatureEvent } from '@moonshot-ai/harness-core';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

interface CounterState { readonly count: number }
interface CounterEvent extends FeatureEvent { readonly type: 'counter.incremented'; readonly by: number }

const counterProjection: Projection<CounterState, CounterEvent> = {
  initial: () => ({ count: 0 }),
  reduce: (state, { event }) =>
    event.type === 'counter.incremented' ? { count: state.count + event.by } : state,
};

// inside a feature's agent unit:
const store = useFeatureStore('agent', 'counter', counterProjection);
```

```ts
interface FeatureStore<S, E extends FeatureEvent> {
  readonly state: ComputedRef<S>;          // live folded state
  readonly ready: Promise<void>;           // resolves once the view is attached
  dispatch(events: readonly E[]): Promise<void>;
}
```

## Scope Chooses the Log

| Scope | Log | Rewound by undo | Use for |
|---|---|---|---|
| `'agent'` | `agents/<agentId>` — the agent's own log, shared with its loop records | yes — the same rewind | per-agent state that moves with the conversation (todo list, plan mode, model binding) |
| `'session'` | `session` — the roster log | **no** | session-wide state shared by all agents (session model defaults) |

There is no feature-specific log and no extra writer: every store of a
scope shares the one `Log` object the `Agent` / `Session` already exposes,
so your commits run through the same serialized queue as the loop records.
The store replays the log from the beginning on every open.

## Projection Rules

- `initial()` and `reduce(state, entry)` must be **pure** — the log is
  re-folded on every open, and any impurity becomes a restart-dependent
  state.
- **The projection must ignore event types it does not own.** The log
  carries loop records and other features' events; reduce only your own
  types and return the state unchanged otherwise (the `event.type !== X →
  return state` guard in the example above).
- Entries are `{ seq, time, event }`; `seq` is the committed sequence and
  `time` the commit clock.
- Events are written to a JSON-lines journal — keep them plain data. If an
  event needs the writing turn, put an explicit field on it (the todo
  feature stamps its own `turn` at dispatch time).
- Store facts, not derived values: compute derivatives from `state` with
  `computed` (as the todo face does with `items`).

## Mount and Readiness

The log is already open when your unit mounts, so `ready` resolves
immediately and is tracked with `useReady` like any other startup promise.
`state` is a `ComputedRef` fed by the replica view — reactive from the
first fold and kept current on every commit. Dispose releases the view;
dispatching after dispose throws `feature store '<name>' is closed`.

## Dispatch Semantics

```ts
await store.dispatch([{ type: 'counter.incremented', by: 1 }]);
```

1. Awaits `ready` (and rejects if the store is closed).
2. Commits the events in one journal commit, serialized with the loop's own
   commits on the same log.
3. **Re-fires each event as a unit event** — so `app.on(...)` observers see
   durable writes with the usual `sessionId` / `agentId` enrichment, and the
   typed form `app.on(feature, type, handler)` narrows to them when they are
   part of the feature's declared union.

Log forwarding does not duplicate these: the agent unit forwards only
`LoopRecord`s and the session unit only roster events into the unit tree,
so a dispatched feature event is delivered exactly once, by `dispatch`.

## Undo: One Rewind

```ts
await session.undo('main', 2);
```

`session.undo(agentId, turns)` (idle agents only; throws otherwise) rewinds
the agent log to the target turn's start — one commit that truncates the
undone turns' loop records **and their interleaved feature events**
together. The loop's context is re-settled, any profile value the rewind
dropped is restored, and every replica view over the log — including each
agent-scoped feature store's — re-folds from its projection, so your store
state is exactly what it was when the cut turn began, with no per-feature
cooperation required.

Session-scoped state deliberately does not rewind: the `session` log
describes session-wide, conversation-independent state and is never
truncated. If your state must follow the conversation, choose agent scope.
The product-facing wrapper is the `undo` feature's `UndoRef` facade
(`availability()`, `undo(turns)`), which adds anchors and telemetry around
`session.undo`.

## A Session-Scoped Example

The provider-catalog's session defaults, abridged from
`src/features/provider-catalog/feature.ts`:

```ts
// inside the feature's session unit:
const store = useFeatureStore('session', 'provider-catalog', sessionModelDefaultsProjection);

useExpose(SessionModelRef, {
  setModel: async (alias) => {
    await store.dispatch([{ type: SESSION_MODEL_DEFAULTS, defaultModel: alias }]);
  },
  // ...
});
```

Note the pattern: validation first, then `dispatch`, and the facade method
returns the dispatch promise so callers observe durability.

## Testing

Feature stores work unchanged on `memorySessionSpace()` (from
`@moonshot-ai/agent-core/session/index`): drive turns with the scripted
requester, close the session (`app.close('s1')`), re-open it, and assert
the state survived; then `session.undo(...)` and assert the rewind. The
todo feature's second test (`test/features/todo.test.ts`, "restores todos
across reopen and rewinds them with undo") is the reference implementation
of exactly this.
