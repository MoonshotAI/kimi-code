# minidb — Design Notes

A pure-Node.js (no native addons) embedded key-value database that mixes
**Redis** (in-memory KV speed, data structures, AOF/RDB persistence) with
**SQLite** (durable single-file persistence, WAL, indexed queries).

This document distills what we learned by reading real database source code, and
records the concrete decisions for our implementation.

## Sources studied

| Source | Why we read it | Key takeaways |
|---|---|---|
| **Redis** (`references/redis`) | Gold standard for in-memory KV + AOF/RDB + data structures | dict incremental rehashing, skiplist with `span`, lazy+sampled expiration, RDB framing, AOF rewrite, RESP |
| **SQLite** WAL doc (`sqlite.org/wal.html`) | WAL semantics done right | append-only changes + commit record, checkpoint, single writer / multi reader, read-degradation vs WAL size, `synchronous` FULL/NORMAL |
| **NeDB** (`references/nedb`) | Pure-JS embedded DB — closest to our stack | append-only log + tombstones + last-writer-wins replay, in-memory AVL secondary indexes, temp+rename compaction, single-concurrency executor, torn-tail tolerance |
| **Bitcask** (`references/bitcask`) | Log-structured hash KV — our storage model | entry format, in-memory keydir (key→offset), append+rotate, merge/compaction, hint-file recovery |
| **cstack/db_tutorial** (`references/db_tutorial`) | Tiny SQLite clone (paged B-tree) | page cache, B-tree node split/merge, cursor; also clarifies what a paged engine costs vs a log |

---

## 1. Constraints

- **Pure Node.js**, zero native addons. Only built-ins: `node:fs`,
  `node:worker_threads`, `node:buffer`, `node:net`, etc.
- **Single-writer, many-reader** within one process (like SQLite WAL). No
  multi-process locking in v1.
- Embedded library first; optional TCP server later.

## 2. Storage model: log-structured, in-memory index

We deliberately choose a **log-structured** engine (Bitcask/Redis-AOF style)
over a **paged B-tree** (SQLite style):

- The db_tutorial clone shows the real cost of a paged engine: fixed page
  frames + cache, in-place overwrite, node split/merge, parent pointers,
  separator keys, root special-casing — and that toy *still* has no WAL, fsync
  or crash recovery. That is a lot of complexity for our target.
- A log-structured store gives **sequential writes** (the fastest disk access),
  trivial **recovery by replay**, and simple crash safety — at the cost of
  needing an in-memory index and a compaction strategy, and range scans being
  harder (we solve those with secondary indexes + a skiplist).

So: **writes append to a log; compaction rewrites.** Reads can then be served
in one of two modes.

We borrow Bitcask's record format, rotation, copy-out merge, and truncate-tail
recovery. In the default `valueMode: 'memory'`, we keep **values in memory**
like Redis (dataset must fit in RAM), which makes reads O(1) with zero disk
I/O. In `valueMode: 'disk'`, we follow Bitcask more closely: the store keeps
only keys/metadata plus a `(file, offset, len)` pointer, and reads value bulk
from the snapshot/WAL with synchronous positioned reads so datasets can exceed
RAM without changing the synchronous public API. `valueMode: 'auto'` chooses
between the two at startup by comparing the current snapshot/WAL size against
`maxMemoryBytes` (falling back to `memory` when no budget is set).

## 3. On-disk record format (WAL + snapshot)

Borrowed from Bitcask's entry layout and Redis RDB's typed, length-prefixed
encoding. Every record is a self-contained frame:

```
 off        size  field
  0          2   magic     = "MD" (0x4D 0x44)
  2          1   type      1=SET, 2=DEL(tombstone)
  3          1   flags     reserved
  4          2   keyLen    uint16
  6          4   valLen    uint32 (0 for DEL)
 10          4   metaLen   uint32 (0 if none)
 14          8   expireAt  int64 ms since epoch, 0 = none
 22        keyLen  key
 22+k       valLen  value
 22+k+v     metaLen  meta     optional metadata blob (dt columns, …)
 22+k+v+m      4   crc32    CRC-32 trailer over [type..meta]
```

- **Fixed 22-byte header + 4-byte CRC trailer** → a reader computes the full
  frame length (`22 + keyLen + valLen + metaLen + 4`) before reading the
  payload (mirrors RDB's length-prefixed idea). The layout matches Bitcask's
  `[klen][vlen][key][val][crc32]` records, extended with an optional `meta`
  blob for top-level datetime columns; CRC-as-trailer verifies a frame in a
  single pass.
- **CRC-32** per frame → recovery detects a torn/corrupt tail and stops cleanly.
  (NeDB tolerates a torn last line by ignoring it; we enforce integrity with CRC
  and truncate at the first bad frame.)
- **Big-endian vs little-endian**: little-endian (matches Node/x86).

See `src/codec.ts`.

## 4. WAL + group commit + fsync policies

Borrowed from Redis AOF and SQLite WAL:

- Writes are appended to the active WAL **through a buffer**; frames accumulate
  and are flushed in batches (**group commit**) → one `write` syscall covers many
  ops. This is the single biggest throughput win in pure Node.
- **fsync policy** (configurable, exactly Redis's three modes):
  - `always` — `fsync` after every write (safest, slowest).
  - `everysec` — flush + `fsync` on a 1s timer (good default; ≤1s loss window).
  - `no` — let the OS flush (fastest, may lose seconds on power loss).
- Single-writer: Node's event loop already serializes JS execution, so in-memory
  index updates and WAL appends are naturally ordered. We additionally serialize
  the async flush so frames never reach disk out of order (NeDB's
  concurrency-1 executor is the same idea; we get it for free from the event
  loop plus an explicit flush gate).

See `src/wal.ts`.

## 5. Snapshot + compaction

Borrowed from Redis RDB/`BGREWRITEAOF` and Bitcask's merge. Compaction is
**non-blocking for writes**: the live WAL doubles as a Redis-style rewrite
buffer (`aof_rewrite_buf`), so the (slow) snapshot is written while writers
keep appending, and they pause only for a brief final rotation.

- When the WAL exceeds a size threshold, compact (rewrite state):
  1. **Fence.** Flush the WAL and record `baseOffset = wal.size`. Every write
     durable at/before `baseOffset` is already reflected in the store
     (`applyOp` runs synchronously in the same tick as `wal.append`, before the
     op awaits the WAL write).
  2. **Snapshot.** Write the live store to `db.snapshot.tmp` as a sequence of
     SET frames (tombstones dropped), then `fsync`. This phase is
     **non-blocking**: writers keep appending to the live WAL and mutating the
     store while we iterate. The snapshot need not be point-in-time — the WAL
     tail below repairs any fuzziness on replay.
  3. **Pre-copy the tail.** Stream `WAL[baseOffset .. head]` into `db.wal.tmp`,
     looping until the remaining delta is small. Also non-blocking: post-fence
     writes accumulate in the live WAL instead of a separate in-memory buffer.
  4. **Rotate** (the only blocking phase, and brief): set `_rotateLock` so new
     writers park, flush, copy the tiny remaining tail delta, close the old
     WAL, `rename` the snapshot into place, `rename` the new WAL into place,
     and reopen it. The two renames are ordered **snapshot-first** so a crash
     between them pairs the new snapshot with the old full WAL — replaying the
     whole old WAL on top of the new snapshot is idempotent for pre-fence
     frames and correct for post-fence frames, so the state stays consistent.
     Reversing the order would pair an old snapshot with a truncated new WAL
     and lose pre-fence data.
- Reads are unaffected throughout. Writes pause only for the rotation critical
  section (one flush, a small copy, two renames + two `fsyncDir`s); the bulk
  snapshot + tail copy happen concurrently with writes. Recovery is always
  `load snapshot + replay WAL`, last-writer-wins, which is exactly what makes
  the non-point-in-time snapshot converge to the correct latest state.
- A writer's gate check (`if (_rotateLock) await _rotateLock`) and its
  `wal.append()` are in the same synchronous segment, and `_rotateLock` is set
  synchronously before the rotation flush — so a writer either enqueued its
  frame before the lock (and is drained by the flush) or parks on the lock
  without appending. The event loop cannot interleave between the two, which
  is why the critical section is quiescent after the flush and cannot deadlock.
- The snapshot encoder runs on the main thread but **yields to the event loop
  every N entries** (chunked), so large snapshots stay responsive without a
  Worker. Offloading the encode to a `worker_thread` is the planned
  optimization; the snapshot is already consistent without it.

See `src/snapshot.ts`.

## 6. Recovery

1. Load the latest `db.snapshot` if present (CRC-checked frames) → rebuild map.
2. Replay the WAL from the snapshot point → apply SET/DEL, last-writer-wins.
3. **Corruption handling** (`recovery` option):
   - `resync` (default): a frame that fails CRC is **skipped** and the parser
     resynchronizes to the next valid frame (scan for the `MD` magic, re-validate
     with CRC). Only the corrupted bytes are lost; everything after the next
     valid frame is recovered. Each lost byte range is reported in
     `recoveryInfo.corruptRanges`. A torn tail (corruption reaching EOF) is
     **truncated**. A random byte sequence passing magic + length + CRC-32 is
     ~1/2³², so a revalidated frame is genuine.
   - `strict`: stop at the first bad frame and treat the entire tail as lost (the
     classic truncate-at-first-error behavior).

Either way the database opens in a consistent state; at most the last
un-`fsync`'d records or the individually corrupt frames are lost.

See `src/recovery.ts`.

## 7. In-memory primary index

- `Map<key, { value, expireAt, version }>`. V8's `Map` already gives us, for
  free, the equivalent of Redis's **incrementally-rehashed, power-of-two,
  load-factor-managed hash table** (ht_table[2] + rehashidx + SipHash). We do
  not reimplement it — that is the big win of targeting Node.
- Values are stored as `Buffer` to keep the hot path allocation-light; a higher
  layer handles JS-value encoding.

## 8. Expiration (TTL)

Directly ported from Redis:

- **Lazy**: every `get` checks `expireAt` and deletes if past.
- **Active**: a periodic timer samples a bounded number of keys (Redis samples
  ~20 per cycle under a CPU time limit) and deletes expired ones — incremental,
  non-blocking, friendly to the event loop.
- A small **min-heap** of expirations lets us short-circuit when nothing is due.

## 9. Secondary indexes + range queries

- Equality index: `Map<fieldValue, Set<primaryKey>>` (NeDB indexes field values,
  including per-element for arrays — we support the same).
- Range / order index: a **skip list** per indexed field, copied from Redis's
  `zskiplist`: node `{ key, backward, level[]{forward, span} }`, max level 32,
  P=0.25. The `span` field gives **O(log N) rank access** and efficient ordered
  range scans (`range`, `order by`, `limit`) without a full scan.
- Unique/sparse indexes with rollback on violation (NeDB pattern).

## 9b. Document model & query layer (MongoDB-like subset)

Records are `{ key, value, dt1..dtN }`:

- **key** — string ≤ 128. Kept in a hash `Map` (O(1) point) **and** a
  string-ordered skip list (O(log N) range / prefix / ordered scan).
- **value** — any JSON. Queried by a zero-dep path/filter/projection engine
  (`getPath`/`match`/`project`) supporting Mongo-like operators
  (`$gt $in $regex $contains $and $or …`) and dot/bracket paths.
- **dt columns** — top-level datetime columns (`dt1..dtN`), each a numeric
  (epoch-ms) skip list for O(log N) range. Stored in the frame's optional
  `meta` blob (`{ dt }`), separate from `value`.

Plus a **full-text inverted index** with a Latin + CJK unigram/bigram tokenizer
and TF-IDF ranking. The inverted index is **larger-than-RAM**: the bulk (every
`(doc, term)` posting) lives in an on-disk postings file (`db.text-<name>.postings`,
delta+varint compressed, CRC-framed), while only the small term dictionary
(`Map<term, {off, len, df}>`), per-doc lengths, and `key↔docID` maps stay in
RAM. Writes go to an in-memory `delta` and deletes set a tombstone; `search`
reads each query term's postings from disk (or a small LRU cache), merges the
delta, drops tombstones, and scores — synchronously, so `db.search()` /
`db.query()` keep their sync API. See `src/text-index.ts` and
`src/text-postings.ts`.

`db.query(q)` composes all four: it intersects candidate key sets from the key
range, dt range, and text search, then applies the value filter, sort, skip,
limit, and projection. Indexed dimensions are fast; an unindexed value filter
degrades to a full scan (same as Mongo without an index).

Indexes are pure derived state, rebuilt from the store on startup (definitions
persisted in `db.indexes.json` / `db.textindexes.json`). The equality/range/dt/
compound indexes are in-memory; the full-text index keeps only its small
dictionary + metadata in memory and stores its postings on disk (rewritten from
the store on open and on compaction), so a crash never loses it — it is simply
rebuilt.

## 10. Concurrency model

- **Main thread**: all GET/SET/DEL and index maintenance — lock-free by virtue
  of the single-threaded event loop. Snapshot encoding is chunked + yielding so
  it does not starve other work.
- **Single writer** at process scope, like SQLite WAL. No multi-process locking
  in v1.
- A future `worker_thread` can offload snapshot encoding / compression / heavy
  CRC if needed (Node's analog of Redis's `fork()`/COW).

## 11. Optional server

A small **RESP-like** TCP server (length-prefixed, CRLF-framed, binary-safe —
trivial per Redis's `rio.c`) so existing Redis clients can talk to minidb.

## 12. Module map

```
src/
  index.ts            public API: open/get/set/del/mget/mset/expire/range/...
  codec.ts            frame encode/decode + CRC streaming parser   [done]
  crc32.ts            table-based CRC-32                           [done]
  wal.ts              buffered append + group commit + fsync policy
  store.ts            in-memory primary index + TTL (lazy + active)
  snapshot.ts         chunked snapshot writer (yields to event loop)
  recovery.ts         load snapshot + replay WAL + truncate torn tail
  compaction.ts       threshold checks + rewrite/rotate trigger
  skiplist.ts         comparator-driven skip list (string + numeric) with span
  index-manager.ts    value-field secondary indexes (equality + range)
  compound-index.ts   compound indexes (groupBy + orderBy, multiple dt columns)
  dt-index.ts         datetime-column range indexes (per-column skip list)
  query.ts            value path / Mongo-like filter / projection / sort
  text-index.ts       full-text index (CJK n-gram + TF-IDF): in-RAM dictionary + delta + tombstones
  text-postings.ts    on-disk postings file (delta+varint + CRC) for the text index
  lockfile.ts         exclusive file lock + stale-lock recovery + read-only
  server.ts           optional RESP TCP server (redis-cli compatible)
```

## 13. Roadmap

1. **MVP**: Map index + get/set/del + WAL (`everysec`) + recovery replay.
2. **Durability**: snapshot + WAL rewrite/compaction (Worker).
3. **Queries**: secondary indexes + skiplist range.
4. **Server**: RESP-like protocol.
5. **Extras**: eviction (LRU/LFU), compression, sharding.
