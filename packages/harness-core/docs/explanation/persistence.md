# Persistence

A harness session is durable by default. This document maps every byte the
harness writes: what is stored, in which log, and how it is read back.

## Overview: Three Journals, One Blob Store, One Catalog Record

Per session, the stack persists:

| What | Where (log name) | Written by | Content |
|---|---|---|---|
| Session roster | `session` | `createSession` | `agent.registered` events — which agents exist, with origin info |
| Agent loop log | `agents/<agentId>` | the `Agent` binding | `LoopRecord`s — the durable subset of loop events |
| Feature journals | `<name>` or `agents/<agentId>/<name>` | `useFeatureStore` | feature events, turn-stamped at agent scope |
| Blobs | (blob backend) | `session.blobs` | content-addressed media/files, plus cache entries |
| Catalog record | `record.json` (fs space) | the space, via `App` | title, metadata, `lastTurn` index, timestamps |

"A session always has a store" — the memory journal and blob backend are
what "no persistence" means (`memoryHarnessSpace()`); `fsSessionSpace(root)`
puts the same layout on disk. Nothing else in the stack knows which backend
is underneath.

## The Loop Log (`agents/<agentId>`)

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

On open, the log is folded back by `loopProjection` into the loop's input:
the settled **profile** (system prompt + tool descriptions), the **messages**,
`nextTurnId` (monotonic — past every recorded turn id, so ids are never
reused), per-turn positions with outcomes, the **unfinished turn** (a turn a
crashed process left without `turn.ended` — the reopened loop starts
`interrupted` and held, and `continue` can resume it), and pending async-tool
**notifications**. See agent-core's loop docs for the resume semantics.

## The Session Log (`session`)

One event type: `agent.registered`, committed before an agent's own log is
first written (so a roster entry never points at a missing log), carrying
`source` (e.g. `'btw'` for by-the-way agents) and `forkedFrom` for forks.
`sessionProjection` folds it into the roster (`session.roster`). Agent logs
found on disk without a roster entry — orphans from a crash — are registered
on session open. Session metadata (title, `metadata`) lives **only** in the
catalog record, never in this log.

## Feature Journals (`useFeatureStore`)

Features keep durable state in event-sourced stores too, but on a **separate
journal** — the one the space hands out via
`HarnessSessionSpace.featureJournal(sessionId)`. One `Writer` per session is
shared by all feature stores (`featureWriterOf` in
`src/runtime/harness.ts`), and `harness.close()` closes these writers after
the app closes.

```ts
const store = useFeatureStore('agent', 'todo', todosProjection);
```

- **Scope decides the log name.** `'agent'` → `agents/<agentId>/<name>`;
  `'session'` → `<name>`. The two scopes sit in the same journal as each
  other (but a different journal from the loop logs).
- **State is a projection.** `Projection<S, E>` is `{ initial, reduce }`
  from `@moonshot-ai/agent-core/store/index`. The store opens the log,
  builds a replica view, and exposes `state: ComputedRef<S>`; `ready`
  resolves when the log is open (and is tracked with `useReady`, so
  `app.create` / `session.open` do not resolve before stores are readable).
- **`dispatch(events)` commits, then re-fires.** Events are appended in one
  commit; at agent scope each event is first stamped with the **current
  `turnId`** (the running turn, else the last recorded turn of the agent's
  view). After a successful commit each event is re-fired as a unit event —
  this is how `app.on('todo.updated', …)` observes durable writes. Dispatch
  after dispose throws.
- **`onCommit(listener)`** replays live commits (from the version the store
  opened at) as `{ seq, time, event }` entries — for features that need the
  raw stream rather than the folded state.

Because dispatch re-fires through the unit tree, feature events participate
in the same bubbling/enrichment channel as everything else (see
[Architecture](architecture.md#events-fire-enrich-bubble)).

### Undo: Synchronized Rewind

`undoAgentTurns(app, session, agentId, turns)` rewinds the agent **and** its
feature stores as one operation:

1. `session.undo(agentId, turns)` (idle agents only) rewinds the loop log to
   the target turn's start, hands the rewound messages back to
   `loop.setContext`, and re-settles any profile value the rewind dropped.
2. Then every feature log under `agents/<agentId>/` is rewound to the first
   entry whose stamped `turnId` is ≥ the cut turn's id — the `turnId` stamp
   written by `dispatch` is what makes this alignment possible.

**Session-scoped feature logs are not rewound** — they have no turnId stamp
and no per-agent meaning. The `undo` feature (`UndoRef`) wraps this with
anchor bookkeeping and telemetry.

## Blobs

`session.blobs` is a `BlobStore` from agent-core: `put({ bytes, mimeType?,
filename? })` stores one record under `data/<ref>` where `ref` is the
record's sha256, and `get(ref)` returns `undefined` for unknown refs and
throws `BlobIntegrityError` on a hash mismatch. `openBlobCache(backend,
namespace)` layers JSON cache values under
`cache/<namespace>/<sha256(key)>` on the same backend. Media features use it
for image originals and upload caches; the LLM store-ref resolver adapts it
to turn `store:` refs into wire sources.

## The Space Implementations

### `fsSessionSpace(root)` — `src/host/session-space.ts`

```
<root>/<sessionId>/
├── record.json        ← catalog record: title, metadata, lastTurn, createdAt, updatedAt
├── journal/           ← nodeJournal: one .jsonl per log, nested by log name
│   ├── session.jsonl
│   ├── agents/<agentId>.jsonl
│   └── writer.lock
├── blobs/             ← nodeBlobBackend: data/<ref>, cache/<namespace>/<sha256(key)>
└── features/          ← the feature journal (lazy nodeJournal), same .jsonl layout
    └── writer.lock
```

`record.json` is written atomically (`.tmp` + rename). `copy(from, to)` —
session fork — copies the whole directory and strips both `writer.lock`
files so the target can open its journals. `delete` closes the feature
journal before removing the tree.

### `memoryHarnessSpace()` — `src/runtime/harness.ts`

The same port in memory (session container from agent-core's
`memorySessionSpace()` plus in-memory feature journals), with `copy`
duplicating journal contents. This is the space every harness test uses —
see the test pattern in
[Develop a Feature](../how-to-guides/02-develop-a-feature.md#testing).

## The `lastTurn` Catalog Index

The catalog record carries a `lastTurn` field — the main agent's last
finished turn (`{ turnId, outcome }`). The session derives it from the main
agent's `loopProjection` view, reports changes through `onLastTurn`, and the
`App` writes it back to the space (`session.meta_updated` fires only for
explicit `app.update` calls, not for this index). It exists so session
**status is available without loading the main agent's log** — and it is a
rebuildable index, not a fact: the loop log remains the source of truth.
