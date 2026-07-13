# Topic — Persistence layering

How business code persists data in `agent-core-v2`: the three-layer model (`Store → Storage → backend`), the naming rules for each layer, and how to decide which layer a domain should depend on. Read this before adding any persistence to a domain.

A domain `I{Domain}EntityService` is a business facade over these layers, not a replacement for them. Before naming or bundling EntityServices by `session` / `agent` / `turn`, read [domain-boundaries.md](domain-boundaries.md).

## The three-layer model

Persistence is split into three layers, each hiding one kind of change:

```text
Business Service
   │ inject
   ▼
┌────────────────────────────────────────┐
│ Store  (semantic layer)                 │  ← access-pattern facade
│   IAppendLogStore / IAtomicDocumentStore│     append-log / atomic-doc / blob
└────────────────────────────────────────┘
   │ inject
   ▼
┌────────────────────────────────────────┐
│ Storage  (byte layer)                   │  ← byte primitives
│   IFileSystemStorageService            │     read/write/append/list/delete
└────────────────────────────────────────┘
   │ implements
   ▼
┌────────────────────────────────────────┐
│ Backend  (deployment-specific)          │  ← File / Postgres / Redis / S3
│   FileStorageService / PostgresStorage  │
└────────────────────────────────────────┘
   │ uses
   ▼
┌────────────────────────────────────────┐
│ Platform primitives                     │  ← hostFs / dbClient / redisClient
└────────────────────────────────────────┘
```

Each layer hides exactly one concern:

| Layer | Hides | Business code sees |
|---|---|---|
| **Store** | how an access pattern works (append-log reads, atomic-doc serialization) | "append this record" / "save this document" |
| **Storage** | byte primitives (atomic write, ordered append, prefix list) | `read/write/append/list/delete` over `(scope, key)` |
| **Backend** | deployment environment (file vs DB vs Redis vs S3) | nothing — chosen at the composition root |

## The one-sentence rule

> **Business code expresses *what* to store or fetch, never *how* to store it.**

If business code contains any "how to persist" detail, it has punched through the layer it should depend on:

| Business code contains | It has punched through | Depend on instead |
|---|---|---|
| `INSERT INTO …` / `SELECT …` | Storage + backend | a Store |
| file paths / `rename` / `fsync` | Storage | Storage or a Store |
| `JSON.parse` / `JSON.stringify` | Store (serialization) | `IAtomicDocumentStore` |
| append offsets / sequential cursors | Store (log semantics) | `IAppendLogStore` |
| `hash(data)` used as a key | Store (blob semantics) | `IBlobStore` |
| `pathe.join / relative / basename` on `homeDir` etc. | Bootstrap (path layout) | `IBootstrapService.scope(...)` / scope contexts |
| only `read/write/list/delete` on bytes | nothing — this is the byte layer | `IFileSystemStorageService` directly ✅ |

## Where scopes come from — `IBootstrapService` and scope contexts

Business code **never assembles scope strings from paths**. Scope strings come from three places:

1. **`IBootstrapService.scope(name)`** — well-known top-level scopes (`'config' | 'sessions' | 'blobs' | 'store' | 'logs' | 'cache' | 'credentials'`). App-scope, deployment-agnostic contract.
2. **`ISessionContext.scope(subKey?)`** — persistence scope rooted at the current session; `scope('agents/main')` etc.
3. **`IAgentScopeContext.scope(subKey?)`** — persistence scope rooted at the current agent; `scope('cron')`, `scope('blobs')` etc.

The bootstrap layer decides how each semantic scope maps to concrete addressing. In the file deployment, `FileBootstrapService` reads a `ResolvedEnvironment` (the paths bag) and returns homeDir-relative scopes; a server deployment could bind a different `IBootstrapService` implementation that maps `'sessions'` to a DB table without any business change.

```ts
// ❌ Wrong — path arithmetic on homeDir/sessionDir leaks the file layout
const scope = relative(bootstrap.homeDir, join(session.sessionDir, 'agents', agentId, 'cron'));

// ✅ Right — the agent already knows its own scope root
const scope = agentCtx.scope('cron');
```

Absolute paths (`sessionDir`, `agentHomedir`) are still available on `IBootstrapService` for the very small number of legacy APIs that expose on-disk paths (session log rotation, background task tail file). Prefer scope strings; ask before adding a new absolute-path caller.

## Which layer to depend on — decision tree

```text
Need to persist
  │
  ├─ read-whole / write-whole, JSON-serializable?
  │     └─ IAtomicDocumentStore
  │
  ├─ append-only writes / sequential reads, independent records?
  │     └─ IAppendLogStore
  │
  ├─ large object, addressed by content hash?
  │     └─ IBlobStore
  │
  ├─ custom byte layout (index / cache / binary) that read/write/list cover?
  │     └─ IFileSystemStorageService directly
  │
  ├─ new, reusable access semantics (multi-field query / time-range / graph)?
  │     └─ add a new Store; business depends on the Store
  │
  └─ business-specific, trivial, one or two lines?
        └─ IFileSystemStorageService directly; if it grows, extract a private Store
```

## Naming — Store by access pattern, not by business

A Store abstracts an **access pattern**, not a business data type. Name it after the pattern so its reusability is obvious from the name.

| Access pattern | Store name | Backend examples |
|---|---|---|
| append-log (append / sequential read) | `IAppendLogStore` | `FileAppendLogStore` / `PostgresAppendLogStore` |
| atomic-document (read/write whole) | `IAtomicDocumentStore` | `FileDocumentStore` / `RedisDocumentStore` |
| blob (hash-addressed large object) | `IBlobStore` | `FileBlobStore` / `S3BlobStore` |

**Do not name a generic Store after a business concept.** `IRecordStore` / `IConfigStore` make a reusable access pattern look like a private store for one feature. Any domain that needs an append-log uses `IAppendLogStore`; any domain that needs an atomic document uses `IAtomicDocumentStore`.

**Exception — business-specific Stores are named after the business.** When a Store captures one domain's unique query semantics (not a generic access pattern), name it after the domain:

```text
ISessionIndex      query / enumerate sessions by workspace   ← business-specific
```

Test: is the Store's semantics a *generic access pattern* (append-log / atomic-doc / blob) or *one domain's unique query*? Generic → name by pattern; unique → name by domain.

## Storage — a filesystem-specific byte layer

The byte layer is a single `IFileSystemStorageService` interface (read / readStream / write / append / list / delete / watch / flush / close). As the name says, it is **filesystem-specific**: it exposes the two irreducible durable primitives a local filesystem implements optimally — atomic whole-value replacement (`write`, via tmp + rename) and ordered durable extension (`append`, via `open('a')`). The node-fs Store backends (`AppendLogStore`, `JsonAtomicDocumentStore`, `BlobStoreService`) are built on it.

```ts
export interface IFileSystemStorageService {
  read(scope: string, key: string): Promise<Uint8Array | undefined>;
  readStream(scope: string, key: string): AsyncIterable<Uint8Array>;
  write(scope: string, key: string, data: Uint8Array, options?: { atomic?: boolean }): Promise<void>;
  append(scope: string, key: string, data: Uint8Array, options?: { durable?: boolean }): Promise<void>;
  list(scope: string, prefix?: string): Promise<readonly string[]>;
  delete(scope: string, key: string): Promise<void>;
  watch?(scope: string, key: string): Event<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
```

Two backends implement it today, both bound at the composition root:

```ts
// Production — local filesystem rooted at homeDir
collection.set(IFileSystemStorageService, new FileStorageService(homeDir));

// Tests — in-memory backend seeded by the test harness
collection.set(IFileSystemStorageService, new InMemoryStorageService());
```

**Non-filesystem backends (Postgres, S3, Redis) do not implement this interface.** Atomic-rename and byte-append have no native equivalent in those stores, so they implement the **Store** interfaces directly via their own clients instead:

```ts
// Server profile — append-logs on Postgres, atomic documents on Redis.
// Each Store is backed by a native client; IFileSystemStorageService is not involved.
collection.set(IAppendLogStore, new PostgresAppendLogStore(db, 'records'));
collection.set(IAtomicDocumentStore, new RedisDocumentStore(redis, 'config'));
```

Use the `scope` parameter to express **business namespace** within a backend. Do not overload `scope` to route backends — bind a different Store implementation at the composition root instead.

## Store `acquire(scope, key)` — flush-on-dispose handle

Stores that buffer writes expose an `acquire(scope, key)` handle so a business can flush them on disposal:

```ts
export interface IAppendLogStore {
  // …
  /**
   * Acquire a disposable handle for `(scope, key)`. Register it with your
   * `Disposable` (via `this._register(...)`); when you are disposed, pending
   * appends for that log are flushed. The shared store itself is not disposed.
   */
  acquire(scope: string, key: string): IDisposable;
}
```

`IAppendLogStore.acquire` flushes the log's pending appends on dispose — it exists because `append` is fire-and-forget. `IAtomicDocumentStore.acquire` is a no-op today (atomic documents are durable on write) and exists for interface symmetry. Businesses that do not need flush-on-dispose simply do not call `acquire`.

## When the byte layer does not apply

`IFileSystemStorageService` covers only the local-filesystem byte primitives. It is not a universal storage abstraction:

- **Non-filesystem backends** (Postgres / S3 / Redis) implement the **Store** interfaces directly via native clients — they never implement `IFileSystemStorageService`.
- **Blobs** are a Store-level interface (`IBlobStore`) with their own backends; the node-fs `BlobStoreService` sits on `IFileSystemStorageService`, but an `S3BlobStore` would not.
- **A backend has a fast primitive the Store interface cannot express** (e.g. Postgres `COPY`) → as an exception, extend that backend's Store implementation directly. This is an exception, not the default.

## Platform primitives are deployment-coupled, not core abstractions

`hostFs` (local filesystem) is a **platform primitive** used only by local backends (`FileStorageService`, `LocalFileSystemBackend`, `LocalSkillCatalog`, `HostFolderBrowser`). It is **not** a core abstraction and must not appear in L2/L3 dependency graphs. A server deployment swaps those backends for DB / S3 implementations and never registers `hostFs`.

## Red lines (this topic)

- Business code never contains "how to persist" details (serialization / paths / SQL / append offsets) — if it does, drop a layer.
- Business code never assembles scope strings from paths (`pathe.join / relative / basename` on `homeDir` / `sessionDir` / …). Use `IBootstrapService.scope(name)` for well-known scopes, `ISessionContext.scope(subKey?)` for session-rooted scopes, and `IAgentScopeContext.scope(subKey?)` for agent-rooted scopes.
- Name generic Stores by access pattern (`IAppendLogStore` / `IAtomicDocumentStore` / `IBlobStore`), never by business concept (`IRecordStore` / `IConfigStore`).
- Business-specific Stores (unique query semantics) are named after the domain (`ISessionIndex`).
- `IFileSystemStorageService` is the filesystem byte-layer interface; non-filesystem backends implement the **Store** interfaces directly. Route backends by binding a different Store implementation at the composition root, not by overloading `scope`.
- `hostFs` is a local-only platform primitive; L2/L3 domains must not import `node:fs` or `hostFs` directly.
- Only the file-backed bootstrap (`FileBootstrapService`) and file backends import `pathe`; business domains do not.
- Do not create a pass-through `Store` that only forwards `read/write` — a Store must hide a real access-pattern concern, or it is noise; use `IFileSystemStorageService` directly instead.
