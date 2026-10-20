# Persist Feature State

How to give a feature durable, undo-aware state with `useFeatureStore` — the
scope and projection choices, dispatch semantics, and the synchronized
rewind. The persistence model behind it is explained in
[Persistence](../explanation/persistence.md#feature-journals-usefeaturestore).

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
  readonly ready: Promise<void>;           // resolves when the log is open
  dispatch(events: readonly E[]): Promise<void>;
  onCommit(listener: (entry: Entry<E>) => void): () => void;
}
```

## Scope Chooses the Log

| Scope | Log name | Rewound by undo | Use for |
|---|---|---|---|
| `'agent'` | `agents/<agentId>/<name>` | yes — entries stamped with `turnId` ≥ the cut turn | per-agent state that moves with the conversation (todo list, plan mode, model binding) |
| `'session'` | `<name>` | **no** | session-wide state shared by all agents (session model defaults) |

Both scopes live in the session's **feature journal** — separate from the
loop logs — handed out by `HarnessSessionSpace.featureJournal(sessionId)`
and shared through one writer per session. Name the log after your feature;
the store replays it from the beginning on every open.

## Projection Rules

- `initial()` and `reduce(state, entry)` must be **pure** — the log is
  re-folded on every open, and any impurity becomes a restart-dependent
  state.
- Entries are `{ seq, time, event }`; `seq` is the committed sequence and
  `time` the commit clock.
- Events are written to a JSON-lines journal — keep them plain data.
- Store facts, not derived values: compute derivatives from `state` with
  `computed` (as the todo face does with `items`).

## Mount and Readiness

`useFeatureStore` opens the log asynchronously and tracks that promise with
`useReady`, so **`app.create` / `session.open` do not resolve before your
store is readable**. `state` is a `ComputedRef` fed by the replica view —
reactive from the first fold and kept current on every commit. Dispose
releases the view; dispatching after dispose throws
`feature store '<log>' is closed`.

## Dispatch Semantics

```ts
await store.dispatch([{ type: 'counter.incremented', by: 1 }]);
```

1. Awaits `ready` (and rejects if the store is closed).
2. At **agent scope**, stamps every event with the current `turnId` — the
   running turn's id, or the agent's last recorded turn when idle. (This
   stamp is what undo alignment keys on; `turnId` is declared on
   `FeatureEvent`, so your event interfaces inherit it.)
3. Commits the events in one journal commit.
4. **Re-fires each event as a unit event** — so `app.on(...)` observers see
   durable writes with the usual `sessionId` / `agentId` enrichment, and the
   typed form `app.on(feature, type, handler)` narrows to them when they are
   part of the feature's declared union.

`onCommit(listener)` replays live commits from the version the store opened
at — for consumers that need the raw stream (cross-feature reactions,
metrics) rather than the folded state. It is cleaned up with the unit.

## Undo: Synchronized Rewind

```ts
import { undoAgentTurns } from '@moonshot-ai/harness-core';

await undoAgentTurns(harness.app, session, 'main', 2);
```

One call rewinds two things in lockstep:

1. **The agent's loop log** — `session.undo(agentId, turns)` (idle agents
   only; throws otherwise) rewinds to the target turn's start, re-settles
   the context, and restores any profile value the rewind dropped.
2. **Every agent-scoped feature log** (`agents/<agentId>/*`) — rewound to
   the first entry stamped `turnId ≥ cut.turnId`. A feature store state is
   therefore exactly what it was when that turn began, with no per-feature
   cooperation required.

Session-scoped logs deliberately do not rewind: their events carry no turn
stamp and describe session-wide, conversation-independent state. If your
state must follow the conversation, choose agent scope. The product-facing
wrapper is the `undo` feature's `UndoRef` facade (`availability()`,
`undo(turns)`), which adds anchors and telemetry around
`undoAgentTurns`.

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

Feature stores work unchanged on `memoryHarnessSpace()`: drive turns with
the scripted requester, close the session (`harness.app.close('s1')`),
re-create it, and assert the state survived; then `undoAgentTurns` and
assert the rewind. The todo feature's second test
(`test/features/todo.test.ts`, "restores todos across reopen and rewinds
them with undo") is the reference implementation of exactly this.
