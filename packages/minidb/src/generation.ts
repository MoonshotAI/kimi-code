// src/generation.ts
//
// Persistent index generations (stage 5): the on-disk layout, the manifest
// codec, and the authoritative inventory of MiniDb's persistent files.
//
// A generation is a self-contained, atomically published checkpoint of every
// piece of DERIVED state MiniDb otherwise rebuilds from scratch on open:
// the store image (key -> value/refs + expiry + dt), the dt / secondary /
// compound index states, and each text index's dictionary + postings + doc
// table. Loading a published generation and replaying only the WAL delta past
// its checkpoint replaces the open-time full rebuild (decode every value,
// tokenize the whole corpus, rewrite every postings file).
//
// Layout (under the db directory):
//
//   db.snapshot                 authoritative data (unchanged)
//   db.wal                      authoritative log (unchanged)
//   db.indexes.json             index-definition sidecars (unchanged,
//   db.compound-indexes.json      still the source of truth for definitions)
//   db.textindexes.json
//   generations/
//     g-000001/                 a published generation (immutable)
//       store                   store image (inline values or disk refs)
//       dt.index                DtIndex columns
//       secondary.index         IndexManager indexes
//       compound.index          CompoundIndexManager indexes
//       text-<name>.dictionary  term -> { off, len, df } into the postings file
//       text-<name>.postings    postings records (native PostingsFile format)
//       text-<name>.docs        docID <-> key table, docLen, delta, tombstones
//       snapshot                hard link to (or copy of) the db.snapshot the
//                               generation's disk refs point into
//       manifest.json           written LAST inside the dir (dir contents are
//                               only meaningful with a parseable manifest)
//     g-000002.tmp-<pid>/       an in-flight build (never referenced by CURRENT)
//   CURRENT                     one line: the published generation id
//
// Crash protocol (publish): build into g-N.tmp-*, write + fsync every file,
// fsync the tmp dir, rename to g-N, fsync generations/, then atomically
// replace CURRENT (tmp + rename) and fsync the db dir. CURRENT therefore only
// ever points at a fully fsynced generation; a crash anywhere earlier strands
// a tmp dir the next writer open sweeps. Old generations are removed lazily,
// keeping the current and previous one (the previous shares the WAL anchor
// when no compaction intervened, so it is a real fallback).
//
// Load protocol: read CURRENT -> parse + validate the manifest (unknown
// format version is a structured fallback, never a deletion) -> verify the
// WAL anchor (dev/ino + size >= checkpoint) and, for disk valueMode, the
// snapshot anchor -> load the store image + every index image whose recorded
// definition hash still matches the live sidecar definitions -> replay WAL
// frames past the checkpoint with the normal per-frame op interpretation.
// ANY validation or I/O failure falls back to the legacy full recovery
// (snapshot + whole WAL + full index rebuild); the fallback never mutates or
// deletes authoritative data. See generation-load.ts / generation-build.ts.
//
// This module absorbs stage 9's transitional persistent-files.ts: it owns the
// name/pattern knowledge for every persistent path. It performs no I/O beyond
// tiny manifest/CURRENT reads and writes.

import { crc32 } from './crc32.js';

// ---- authoritative root file names (absorbed from persistent-files.ts) ----

/** The primary data pair recovery pairs up: the snapshot, then the WAL. */
export const SNAPSHOT_FILE = 'db.snapshot';
export const WAL_FILE = 'db.wal';

/** Index-definition sidecars, rewritten atomically (tmp + rename) on every
 *  definition change. */
export const SECONDARY_INDEXES_FILE = 'db.indexes.json';
export const COMPOUND_INDEXES_FILE = 'db.compound-indexes.json';
export const TEXT_INDEXES_FILE = 'db.textindexes.json';
export const SIDECAR_FILES = [SECONDARY_INDEXES_FILE, COMPOUND_INDEXES_FILE, TEXT_INDEXES_FILE] as const;

/** Per-text-index postings files at the ROOT are the legacy (pre-generation)
 *  location: read-only in-memory-base instances and the generations-disabled
 *  fallback still use them, and a writer deletes a root postings file once a
 *  published generation covers that index. */
export const POSTINGS_PATTERN = /^db\.text-.*\.postings$/;

/** On-disk postings file name for a text index (root location). */
export function rootPostingsFile(name: string): string {
  return `db.text-${sanitizeIndexName(name)}.postings`;
}

// ---- generation layout -----------------------------------------------------

export const GENERATIONS_DIR = 'generations';
export const CURRENT_FILE = 'CURRENT';
export const MANIFEST_FILE = 'manifest.json';
export const STORE_IMAGE_FILE = 'store';
export const DT_INDEX_FILE = 'dt.index';
export const SECONDARY_INDEX_FILE = 'secondary.index';
export const COMPOUND_INDEX_FILE = 'compound.index';
export const GEN_SNAPSHOT_FILE = 'snapshot';

/** Text-index artifact file names inside a generation directory. */
export function textDictionaryFile(name: string): string {
  return `text-${sanitizeIndexName(name)}.dictionary`;
}
export function textPostingsFile(name: string): string {
  return `text-${sanitizeIndexName(name)}.postings`;
}
export function textDocsFile(name: string): string {
  return `text-${sanitizeIndexName(name)}.docs`;
}

/** Index names land in file names; keep the same sanitization the legacy
 *  root postings path used so both locations agree. */
export function sanitizeIndexName(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
}

/** Generation directory id: monotonically increasing, zero-padded so
 *  lexicographic order equals numeric order. */
export function generationId(n: number): string {
  return `g-${String(n).padStart(6, '0')}`;
}

const GEN_ID_PATTERN = /^g-(\d+)$/;

/** Parse a generation directory name into its numeric id, or null. */
export function parseGenerationId(name: string): number | null {
  const m = GEN_ID_PATTERN.exec(name);
  return m ? Number(m[1]) : null;
}

/** In-flight generation build directories (crash-stranded ones are swept by
 *  the next writer open; a live build's tmp is never matched for another
 *  process because only the lock holder builds). */
export const GEN_TMP_PATTERN = /^g-\d+\.tmp-.*$/;

/** Manifest format version. Version 1 is the first persisted layout; an
 *  opener that reads a HIGHER version must not touch the files (a newer
 *  binary wrote them) and falls back to the legacy full recovery. */
export const GENERATION_FORMAT_VERSION = 1;

// ---- manifest --------------------------------------------------------------

/** Per-file integrity record: byte length and crc32 of the whole file. */
export interface ManifestFileInfo {
  bytes: number;
  crc32: number;
}

/** The WAL position the generation's images cover: frames at/after
 *  `walOffset` are NOT included and must be replayed on top. The anchor
 *  (dev/ino) pins the offset to one specific WAL inode; `walSize` is the
 *  size the WAL had when the checkpoint was sealed (>= walOffset). */
export interface GenerationCheckpoint {
  walOffset: number;
  walDev: number;
  walIno: number;
  walSize: number;
  /** Identity of the db.snapshot the generation's disk refs (and its own
   *  `snapshot` member) point into. `linked` records whether the generation's
   *  snapshot is a hard link to that inode (false = a full copy; disk-mode
   *  loads then cannot serve refs through the live db.snapshot path and the
   *  generation is only usable for memory-mode loads). */
  snapshotBytes: number;
  snapshotDev: number;
  snapshotIno: number;
  snapshotLinked: boolean;
}

/** Compatibility + definition-hash metadata. A generation is only loadable
 *  when the codec and value mode match the open options; per-index definition
 *  hashes decide which individual index images are still valid (a definition
 *  change invalidates only that index — it is rebuilt from the loaded store). */
export interface GenerationManifest {
  format: number;
  id: string;
  createdAt: number;
  valueCodec: string;
  /** The payload mode of the store image: 'memory' inlines every value,
   *  'disk' stores { file, off, len } refs (with inline values allowed for
   *  records that were RAM-resident at build time). */
  valueMode: 'memory' | 'disk';
  checkpoint: GenerationCheckpoint;
  /** Definition hash per index name, per index family. */
  indexDefs: {
    secondary: Record<string, string>;
    compound: Record<string, string>;
    text: Record<string, string>;
  };
  /** Integrity record for every file the build wrote (everything except the
   *  manifest itself and the `snapshot` link, which is anchored by dev/ino
   *  and carries per-frame CRCs of its own). */
  files: Record<string, ManifestFileInfo>;
  counts: {
    records: number;
    dtColumns: number;
    secondaryIndexes: number;
    compoundIndexes: number;
    textIndexes: number;
  };
}

/** Canonical definition hash: crc32 of the JSON of the definition with
 *  sorted keys, hex-encoded. Both sides (build and load) derive it from the
 *  SAME persisted definition shape (the sidecar entries), so a sidecar
 *  round-trip never changes it. */
export function indexDefHash(def: unknown): string {
  return crc32(Buffer.from(stableJson(def), 'utf8')).toString(16).padStart(8, '0');
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

// ---- persistent file inventory (absorbed from persistent-files.ts) ---------

/** The files the cluster reader fingerprint MUST track: a change to any of
 *  them means a cached read-only instance can no longer serve without a
 *  refresh. The WAL comes first — the lock pool's "WAL-only append" fast path
 *  compares every OTHER entry by position (see shardFingerprint). CURRENT is
 *  tracked so a generation switch (compaction publish) refreshes readers even
 *  though the snapshot entry already covers the rotation; both are kept
 *  because a compaction with generation builds disabled rotates the snapshot
 *  without touching CURRENT. */
export const FINGERPRINT_FILES = [WAL_FILE, SNAPSHOT_FILE, CURRENT_FILE, ...SIDECAR_FILES] as const;

/** Is `name` one of MiniDb's persistent top-level entries (a primary data
 *  file, an index-definition sidecar, a legacy postings file, CURRENT, or the
 *  generations directory)? backup/restore filter on this. */
export function isPersistentFile(name: string): boolean {
  return (
    name === SNAPSHOT_FILE ||
    name === WAL_FILE ||
    name === CURRENT_FILE ||
    name === GENERATIONS_DIR ||
    (SIDECAR_FILES as readonly string[]).includes(name) ||
    POSTINGS_PATTERN.test(name)
  );
}

/** Atomic-write temp siblings a crashed previous run may have left behind:
 *  a compaction's snapshot/WAL temps (fixed names), plus sidecar-definition
 *  temps from before sidecar writes gained unique suffixes. Current sidecar
 *  writes use `<file>.tmp-<pid>-<seq>` names, matched by isStaleTmpFile
 *  instead. Only the sole writer may delete them at open — a read-only
 *  opener must never touch a live writer's in-flight temps. */
export const STALE_TMP_FILES: readonly string[] = [SNAPSHOT_FILE, WAL_FILE, ...SIDECAR_FILES].map((f) => `${f}.tmp`);

/** Is `name` a unique-suffixed atomic-write temp (`<file>.tmp-<pid>-<seq>`)
 *  of one of the primary/sidecar/CURRENT files, orphaned by a crash between
 *  the tmp write and the rename? Whitelisted per known file so a LockFile's
 *  `db.lock.tmp-*` — possibly in flight in ANOTHER process right now — is
 *  never matched. Same deletion discipline as STALE_TMP_FILES: only the sole
 *  writer at open. */
export function isStaleTmpFile(name: string): boolean {
  return [SNAPSHOT_FILE, WAL_FILE, CURRENT_FILE, ...SIDECAR_FILES].some((f) => name.startsWith(`${f}.tmp-`));
}

/** A failed postings rebuild orphans `db.text-*.postings.tmp` (its atomic
 *  rename never ran). Postings are pure derived state, so such temps are
 *  always safe for the writer to delete, for any index name. */
export const STALE_POSTINGS_TMP_PATTERN = /^db\.text-.*\.postings\.tmp$/;
