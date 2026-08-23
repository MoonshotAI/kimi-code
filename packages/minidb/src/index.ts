// src/index.ts
//
// MiniDb: the public embedded API. Ties together the in-memory Store (with its
// ordered key index), the WAL, recovery, compaction, dt-column indexes, value
// secondary indexes, and full-text indexes.
//
// Document model:
//   { key: string(<=128), value: <any JSON>, dt1..dtN: <epoch-ms datetime columns> }
//
// This is the package's barrel: the MiniDb class lives in mini-db.ts, the
// public option/record types in types.ts; everything is re-exported here so
// the entry point's public surface stays exactly the pre-split one.

export * from './mini-db.js';
export { UniqueViolationError } from './index-manager.js';
export { LockError } from './lockfile.js';
// The close-gate + in-flight-count lifecycle primitive, shared with embedders
// that run lifecycle-managed background work (kap-server's search service).
export { OpTracker } from './op-tracker.js';
export { TextIndexBuildingError } from './text-index/index.js';
export { normalizeLiteral, createNgramTokenizer } from './trigram.js';
export { tokenize } from './text-index/index.js';
export type { RecoveryInfo, RecoveryPhaseTimings } from './recovery.js';
export type {
  MiniDbLifecycleState,
  MiniDbLifecycleStatus,
  OpenPhaseTimings,
  OpenTextIndexSource,
} from './lifecycle-status.js';
export type { IndexDef, IndexInfo, IndexType } from './index-manager.js';
export type { CompoundIndexDef, CompoundIndexInfo } from './compound-index.js';
export type { TextIndexTokenizerName } from './trigram.js';
export type {
  ValueCodecName,
  ValueCodec,
  ValueModeSetting,
  OpenOptions,
  RestoreOptions,
  SetOptions,
  BatchInputOp,
  DocRecord,
  ScanEntry,
  QueryOptions,
} from './types.js';
// ClusterDb (the multi-process sharding layer) lives at the './cluster'
// subpath export to keep this module free of import cycles.
