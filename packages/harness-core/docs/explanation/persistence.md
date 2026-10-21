# Persistence

A harness session is durable by default. This document maps every byte the
harness writes: what is stored, in which log, and how it is read back.

## Overview: One Journal, One Blob Store, One Catalog Record

Per session, the stack persists:

| What | Where (log name) | Written by | Content |
|---|---|---|---|
| Session roster | `session` | `createSession` | `agent.registered` events — which agents exist, with origin info |
| Session-scoped feature events | `session` | `useFeatureStore('session', …)` | feature events (model defaults, file registry, …) |
| Agent loop log | `agents/<agentId>` | the `Agent` binding | `LoopRecord`s — the durable subset of loop events |
| Agent-scoped feature events | `agents/<agentId>` | `useFeatureStore('agent', …)` | feature events (todo, plan, cron, …) |
| Blobs | (blob backend) | `session.blobs` | content-addressed media/files, plus cache entries |
| Catalog record | `record.json` (fs space) | the space, via `App` | title, metadata, `lastTurn` index, timestamps |

There is **no separate feature journal**. Session-scoped feature events are
appended to the `session` log, agent-scoped feature events to the agent's
own log — one journal directory, one writer, one serialized commit queue
(`openWriter`). Every consumer folds the log through a projection that
reduces only the event types it knows and ignores the rest, so domain data
of several kinds shares a log without interfering.

"A session always has a store" — the memory journal and blob backend are
what "no persistence" means (`memorySessionSpace()`);
`nodeSessionSpace(root)` puts the same layout on disk. Nothing else in the
stack knows which backend is underneath.

## The Agent Log (`agents/<agentId>`)

Each open agent binds its loop to one log. The binding (in agent-core's
`createSession`) subscribes to the loop, selects the durable events with
`toLoopRecord`, and commits them **batched per microtask**; `agent.flush()`
forces the pending batch out. A failed append reports through `onError` and
closes the loop, so a broken store never silently loses history.

`LoopRecord` is the durable subset of emitted loop events
(`src/loop/record.ts` in agent-core):

```
turn.started   turn.resumed   turn.ended
step.started   step.ended
message.appended
context.settled   system_prompt.settled   tools.settled
tool.started   tool.async_ended
hook.failed   llm.retrying   llm.notice
```

Streaming deltas, hook configuration, prompt-queue events, and payload
duplicates are deliberately not recorded. Unknown errors are converted to
JSON at the boundary.

Agent-scoped feature events are interleaved into the same log by
`useFeatureStore` (below). On open, the log is folded back by
`loopProjection` into the loop's input — the settled **profile** (system
prompt + tool descriptions), the **messages**, `nextTurnId` (monotonic —
past every recorded turn id, so ids are never reused), per-turn positions
with outcomes, the **unfinished turn** (a turn a crashed process left
without `turn.ended` — the reopened loop starts `interrupted` and held, and
`continue` can resume it), and pending async-tool **notifications** — and
`loopProjection` skips every event type it does not know, so feature events
never reach loop state. `isLoopRecord` is the runtime guard with the same
type list; `session.fork` uses it to copy **only loop records** into the
forked agent's log, so forks never inherit feature state.

## The Session Log (`session`)

The roster event `agent.registered` is committed before an agent's own log
is first written (so a roster entry never points at a missing log),
carrying `source` (e.g. `'btw'` for by-the-way agents) and `forkedFrom` for
forks. `sessionProjection` folds the log into the roster
(`session.roster`), reducing `agent.registered` and ignoring everything
else — session-scoped feature events live in the same log and never reach
the roster. Agent logs found on disk without a roster entry — orphans from
a crash — are registered on session open. Session metadata (title,
`metadata`) lives **only** in the catalog record, never in this log.

## Feature Stores (`useFeatureStore`)

Features keep durable state in event-sourced stores over the session's own
logs:

```ts
const store = useFeatureStore('agent', 'todo', todosProjection);
```

- **Scope decides the log.** `'agent'` → the agent's own log
  (`agents/<agentId>`, shared with the loop records); `'session'` → the
  `session` log (shared with the roster). All stores of one scope share one
  `Log` object — the one the `Session`/`Agent` already exposes — so every
  commit runs through the same serialized queue, with no extra writer or
  lock.
- **State is a projection.** `Projection<S, E>` is `{ initial, reduce }`
  from `@moonshot-ai/agent-core/store/index`. The store builds a replica
  view over the shared log and exposes `state: ComputedRef<S>`; the
  projection **must ignore event types it does not own** (the log carries
  loop records and other features' events), which every bundled projection
  does with a type guard. `ready` resolves immediately — the log is already
  open (and is tracked with `useReady`).
- **`dispatch(events)` commits, then re-fires.** Events are appended in one
  commit; after a successful commit each event is re-fired as a unit event —
  this is how `app.on('todo.updated', …)` observes durable writes. Log
  forwarding (the mechanism that replays log commits into the unit tree)
  filters these out: the agent unit forwards only `LoopRecord`s and the
  session unit only roster events, so a dispatched feature event is
  delivered exactly once. Dispatch after dispose throws.
- **A feature event that carries data for one feature only.** Because all
  features of a scope share a log, an event type belongs to the feature
  that defines it; writing foreign-typed events into the shared log is how
  a feature would corrupt another feature's state. (The `ptc` feature wraps
  model-authored events in a `ptc.dispatched` envelope for exactly this
  reason.)

Because dispatch re-fires through the unit tree, feature events participate
in the same bubbling/enrichment channel as everything else (see
[Architecture](architecture.md#events-fire-enrich-bubble)).

### Undo: One Rewind

`session.undo(agentId, turns)` (idle agents only) rewinds the agent log to
the target turn's start — one commit that truncates the loop records **and
the interleaved feature events** of the undone turns in the same operation.
The loop's messages are handed back to `loop.setContext`, any profile value
the rewind dropped is re-settled, and every replica view over the log —
including each feature store's — re-folds from its projection, so feature
state lands exactly where it was at the cut turn. There is no turn-stamping
and no second rewind pass to keep in sync.

**Session-scoped feature events are not rewound** — the `session` log has
no per-agent turn meaning and is never truncated. The `undo` feature
(`UndoRef`) wraps `session.undo` with anchor bookkeeping and telemetry.

## Blobs

`session.blobs` is a `BlobStore` from agent-core: `put({ bytes, mimeType?,
filename? })` stores one record under `data/<ref>` where `ref` is the
record's sha256, and `get` returns `undefined` for unknown refs and throws
`BlobIntegrityError` on a hash mismatch. `openBlobCache(backend,
namespace)` layers JSON cache values under
`cache/<namespace>/<sha256(key)>` on the same backend. Media features use it
for image originals and upload caches; the LLM store-ref resolver adapts it
to turn `store:` refs into wire sources.

## The Space Implementations

### `nodeSessionSpace(root)` — agent-core, `src/session/backend/node.ts`

```
<root>/<sessionId>/
├── record.json        ← catalog record: title, metadata, lastTurn, createdAt, updatedAt
├── journal/           ← nodeJournal: one .jsonl per log, nested by log name
│   ├── session.jsonl
│   ├── agents/<agentId>.jsonl
│   └── writer.lock
└── blobs/             ← nodeBlobBackend: data/<ref>, cache/<namespace>/<sha256(key)>
```

`record.json` is written atomically (`.tmp` + rename). `copy(from, to)` —
session fork — copies the whole directory and strips `journal/writer.lock`
so the target can open its journal. Imported by path:
`@moonshot-ai/agent-core/session/backend/node`.

### `memorySessionSpace()` — agent-core, `src/session/space.ts`

The same port in memory, with `copy` duplicating journal contents. This is
the space every harness test uses — see the test pattern in
[Develop a Feature](../how-to-guides/02-develop-a-feature.md#testing).

## The `lastTurn` Catalog Index

The catalog record carries a `lastTurn` field — the main agent's last
finished turn (`{ turnId, outcome }`). The session derives it from the main
agent's `loopProjection` view, reports changes through `onLastTurn`, and the
`App` writes it back to the space (`session.meta_updated` fires only for
explicit `app.update` calls, not for this index). It exists so session
**status is available without loading the main agent's log** — and it is a
rebuildable index, not a fact: the loop log remains the source of truth.
