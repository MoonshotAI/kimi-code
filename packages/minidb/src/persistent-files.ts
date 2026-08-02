// src/persistent-files.ts
//
// The authoritative inventory of MiniDb's on-disk persistent files — the
// single source of truth that every file-set enumerator derives from: the
// cluster reader fingerprint (cluster/lock-pool.ts), backup/restore
// (index.ts), and the open-time stale-temp cleanup (index.ts). Before this
// module existed the set was hand-enumerated in at least four places and the
// lists had already drifted apart (db.compound-indexes.json was invisible to
// the fingerprint — review #17). Adding a persisted file now means adding it
// HERE, and no consumer can silently miss it.
//
// MiniDb's disk state is a compound document: the primary data pair
// (db.snapshot + db.wal), the index-definition sidecars, and the per-text-
// index postings files. This module holds name/pattern knowledge only; it
// performs no I/O.
//
// Internal to the package — NOT re-exported from the root entry point.
//
// TRANSITIONAL: stage 5's generations/ manifest absorbs this module (the
// manifest codec becomes the authority on the file set). Until then, never
// re-enumerate these names elsewhere.

/** The primary data pair recovery pairs up: the snapshot, then the WAL. */
export const SNAPSHOT_FILE = 'db.snapshot';
export const WAL_FILE = 'db.wal';

/** Index-definition sidecars, rewritten atomically (tmp + rename) on every
 *  definition change. */
export const SECONDARY_INDEXES_FILE = 'db.indexes.json';
export const COMPOUND_INDEXES_FILE = 'db.compound-indexes.json';
export const TEXT_INDEXES_FILE = 'db.textindexes.json';
export const SIDECAR_FILES = [SECONDARY_INDEXES_FILE, COMPOUND_INDEXES_FILE, TEXT_INDEXES_FILE] as const;

/** Per-text-index postings files (derived state, rebuilt on open and after
 *  each compaction) share one naming pattern with the index name embedded. */
export const POSTINGS_PATTERN = /^db\.text-.*\.postings$/;

/** The files the cluster reader fingerprint MUST track: a change to any of
 *  them means a cached read-only instance can no longer serve without a
 *  refresh. The WAL comes first — the lock pool's "WAL-only append" fast path
 *  compares every OTHER entry by position (see shardFingerprint). */
export const FINGERPRINT_FILES = [WAL_FILE, SNAPSHOT_FILE, ...SIDECAR_FILES] as const;

/** Is `name` one of MiniDb's persistent files (a primary data file, an
 *  index-definition sidecar, or a postings file)? backup/restore filter on
 *  this. */
export function isPersistentFile(name: string): boolean {
  return (
    name === SNAPSHOT_FILE ||
    name === WAL_FILE ||
    (SIDECAR_FILES as readonly string[]).includes(name) ||
    POSTINGS_PATTERN.test(name)
  );
}

/** Atomic-write temp siblings a crashed previous run may have left behind
 *  (a compaction's snapshot/WAL temps, sidecar-definition temps). Only the
 *  sole writer may delete them at open — a read-only opener must never touch
 *  a live writer's in-flight temps. */
export const STALE_TMP_FILES: readonly string[] = [SNAPSHOT_FILE, WAL_FILE, ...SIDECAR_FILES].map((f) => `${f}.tmp`);

/** A failed postings rebuild orphans `db.text-*.postings.tmp` (its atomic
 *  rename never ran). Postings are pure derived state, so such temps are
 *  always safe for the writer to delete, for any index name. */
export const STALE_POSTINGS_TMP_PATTERN = /^db\.text-.*\.postings\.tmp$/;
