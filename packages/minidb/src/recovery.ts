// src/recovery.ts
//
// Startup recovery: load the latest snapshot (if any) then replay the WAL on
// top, last-writer-wins. In valueMode:'disk' recovery scans frames without
// copying values and stores { file, off, len } pointers instead.
//
// The per-frame interpretation (expiry drop, batch unrolling, value refs, dt
// meta) lives in frameToOps so that open-time recovery and read-replica WAL
// catch-up (catchUpWalAsync) can never drift apart.
//
// GENERATION PAIRING (stat-pairing — the LEGACY fallback path). MiniDb's
// disk state is a compound document: a compaction rotation swaps db.snapshot
// and db.wal in two renames, and a read-only opener that scans the two files
// unpaired can combine the OLD snapshot with the NEW truncated WAL — silently
// losing the data the snapshot had absorbed, and (in disk mode) reading
// values back through offsets that point into the wrong inode (review #15).
// recover() therefore runs bounded passes: each pass fingerprints both files
// (dev/ino/size of the opened fd BEFORE scanning it, a path re-stat AFTER the
// last read), and any generation switch — an inode change, a size shrink, a
// file appearing or disappearing mid-pass — discards the pass's whole result
// and retries with exponential backoff. A WAL that merely GREW on the same
// inode is safe (append-only; the extra frames are a natural staleness window
// that catch-up covers). Exhausting the retries throws
// RecoveryGenerationChurnError. The writer's own open walks the same code
// path but is naturally stable (it holds the write lock, and compaction only
// starts after recovery completes), so it costs two extra stat calls and
// changes zero behavior.
//
// Stage 5 supersedes this for the common case: when a published persistent
// index generation exists (generations/ + CURRENT, see generation.ts), open
// loads it and replays only the WAL delta past its checkpoint, and this full
// scan runs only as the fallback — for legacy databases, a missing/invalid
// generation, or a rotated-away WAL anchor.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { scanFrameRefsFdAsync, scanBatchOpRefs, TYPE_SET, TYPE_DEL, TYPE_BATCH, MAGIC } from './codec.js';
import type { FrameRef } from './codec.js';
import { SNAPSHOT_FILE, WAL_FILE } from './generation.js';
import { yieldToLoop } from './text-index/tokenize.js';
import type { Store, ValueLoc, ValueRef } from './store.js';

export type RecoveryMode = 'resync' | 'strict';
export type ValueMode = 'memory' | 'disk';

/** Optional wall-clock sink for the two recovery sub-phases (scan vs apply),
 *  accumulated across every pass (generation-churn retries included). Fed by
 *  the open-time lifecycle telemetry; recover() works unchanged without it. */
export interface RecoveryPhaseTimings {
  /** Async frame scanning of the snapshot and the WAL. */
  walScanMs: number;
  /** Applying the scanned frames to the store. */
  walApplyMs: number;
}

export interface RecoveryInfo {
  snapshotFrames: number;
  walFrames: number;
  /** On-disk sizes of the files recovery scanned (0 when absent). */
  snapshotBytes: number;
  walBytes: number;
  truncatedWal: boolean;
  corruptRanges: [number, number][];
  snapshotCorruptRanges: [number, number][];
  lostBytes: number;
  /** Byte offset in db.wal up to which recovery replayed frames (the scan
   *  endpoint; a torn/corrupt tail beyond it was NOT applied). 0 without WAL.
   *  Anchored by walDev/walIno to the inode that was scanned. */
  walScanEnd: number;
  /** dev/ino of the WAL inode recovery scanned (both 0 when there was none). */
  walDev: number;
  walIno: number;
  /** dev/ino of the snapshot inode recovery scanned (both 0 when there was
   *  none). */
  snapshotDev: number;
  snapshotIno: number;
  /** BATCH frames whose body failed strict structure validation (valid outer
   *  CRC but malformed sub-ops — review #9): the whole batch was skipped
   *  rather than half-applied. */
  corruptBatches: number;
  /** Generation-churn retries recovery needed before it paired a consistent
   *  snapshot/WAL set (0 on a stable directory — see the file header). */
  generationRetries: number;
  /** Stage 5: set when this recovery was served by a persistent index
   *  generation instead of the full snapshot/WAL scan + index rebuild. The
   *  generation id, the WAL checkpoint it covered (frames at/after it were
   *  replayed on top), and the store-image record count. */
  indexGeneration?: { id: string; walCheckpoint: number; records: number };
  /** Stage 5, generation loads only: how many primitive ops the WAL-delta
   *  replay applied on top of the loaded generation (drives the open-time
   *  background-refresh decision — a large delta means the checkpoint is
   *  stale and worth rebuilding in the background). */
  walDeltaAppliedOps?: number;
}

function readAtSync(fd: number, off: number, len: number): Buffer {
  if (len === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const r = fsSync.readSync(fd, buf, got, len - got, off + got);
    if (r === 0) throw new Error('recovery: short read past EOF');
    got += r;
  }
  return buf;
}

function parseMeta(meta: Buffer | null): Record<string, number> | null {
  if (!meta) return null;
  const parsed = JSON.parse(meta.toString('utf8')) as { dt?: Record<string, number> };
  return parsed.dt ?? null;
}

/** A recovered frame unrolled into one primitive store op; the shared
 *  interpretation layer between open-time recovery and replica catch-up. */
export interface RecoveredOp {
  type: number; // TYPE_SET | TYPE_DEL
  key: Buffer;
  ref: ValueRef | null;
  expireAt: number;
  dt: Record<string, number> | null;
}

function* setRefToOps(
  f: { key: Buffer; valueOff: number; valLen: number; meta: Buffer | null; expireAt: number },
  file: ValueLoc['file'],
  fd: number,
  valueMode: ValueMode,
): Generator<RecoveredOp> {
  // A record whose TTL already elapsed while the db was closed must not be
  // replayed as a live key: that would make `size` count a key scan/get hide,
  // and would rebuild indexes without it (inconsistency).
  //
  // We must also actively DROP the key: an expired SET is still the *latest*
  // write for its key. If an older live value for the same key was already
  // loaded from the snapshot (or an earlier WAL frame), simply skipping this
  // frame would leave that stale value behind — resurrecting a key the most
  // recent write had already expired. Deleting it preserves last-writer-wins
  // semantics: a later op (another SET, or a DEL) will re-establish the key if
  // needed; otherwise the key stays gone, as its expired TTL dictates.
  if (f.expireAt && f.expireAt <= Date.now()) {
    yield { type: TYPE_DEL, key: f.key, ref: null, expireAt: 0, dt: null };
    return;
  }
  const dt = parseMeta(f.meta);
  const ref: ValueRef =
    valueMode === 'disk'
      ? { kind: 'disk', loc: { file, off: f.valueOff, len: f.valLen } }
      : { kind: 'memory', value: readAtSync(fd, f.valueOff, f.valLen) };
  yield { type: TYPE_SET, key: f.key, ref, expireAt: f.expireAt, dt };
}

/** Unroll one recovered frame into primitive ops. SET frames carry their value
 *  ref (inline bytes in memory mode, a {file, off, len} pointer in disk mode);
 *  expired-at-replay SETs become DELs (see setRefToOps). A BATCH frame yields
 *  its sub-ops in order; a malformed body with a valid outer CRC skips the
 *  whole batch rather than half-applying it (and is reported through
 *  `onCorruptBatch` so recovery can account it). Unknown frame types yield nothing. */
export function* frameToOps(
  f: FrameRef,
  file: ValueLoc['file'],
  fd: number,
  valueMode: ValueMode,
  onCorruptBatch?: () => void,
): Generator<RecoveredOp> {
  if (f.type === TYPE_SET) {
    yield* setRefToOps(f, file, fd, valueMode);
  } else if (f.type === TYPE_DEL) {
    yield { type: TYPE_DEL, key: f.key, ref: null, expireAt: 0, dt: null };
  } else if (f.type === TYPE_BATCH) {
    let ops;
    try {
      ops = scanBatchOpRefs(readAtSync(fd, f.valueOff, f.valLen), f.valueOff);
    } catch {
      // A malformed body with a valid outer CRC can only come from an encoder
      // bug. Skip the whole batch rather than half-apply it, preserving the
      // all-or-nothing guarantee.
      onCorruptBatch?.();
      return;
    }
    for (const op of ops) {
      if (op.type === TYPE_SET) yield* setRefToOps(op, file, fd, valueMode);
      else if (op.type === TYPE_DEL) yield { type: TYPE_DEL, key: op.key, ref: null, expireAt: 0, dt: null };
    }
  }
}

/** Budgets for the cooperative slicing of recovered-op apply loops. A BATCH
 *  frame unrolls into thousands of primitive ops, so frame-granular yielding
 *  cannot bound an apply slice — primitive-op count and elapsed time can. */
export const WAL_APPLY_OPS_PER_SLICE = 512;
export const WAL_APPLY_SLICE_MS = 8;

/** Cooperative slicing for the recovered-op apply loops: reports true when
 *  either budget (primitive ops, or wall-clock since the last yield) is
 *  exhausted and the loop should yieldToLoop(). Yielding mid-apply is safe on
 *  both consumers: at open the store is not published until open() returns,
 *  so nothing observes a half-applied pass; during replica catch-up
 *  (catchUpWalAsync) concurrent readers can observe intermediate apply
 *  states, which the replica's eventual-consistency contract permits (the
 *  caller's watermark only advances once the whole delta has applied). */
export function walApplySlicer(): () => boolean {
  let ops = 0;
  let sliceStart = performance.now();
  return () => {
    if (++ops < WAL_APPLY_OPS_PER_SLICE && performance.now() - sliceStart < WAL_APPLY_SLICE_MS) return false;
    ops = 0;
    sliceStart = performance.now();
    return true;
  };
}

/** Apply recovered frames to the store. This is pure in-memory bookkeeping —
 *  one synchronous pass per file would be a noticeable event-loop stall on a
 *  large db (the open-time freeze used to be dominated by the index rebuild
 *  AFTER this pass, but the pass itself is not free either), so it yields
 *  periodically. Safe: the store is not published until open() returns, so
 *  nothing can observe a half-applied pass. */
async function applyFrames(
  frames: FrameRef[],
  file: ValueLoc['file'],
  fd: number,
  store: Store,
  valueMode: ValueMode,
  onCorruptBatch?: () => void,
): Promise<void> {
  const slice = walApplySlicer();
  for (const f of frames) {
    for (const op of frameToOps(f, file, fd, valueMode, onCorruptBatch)) {
      if (op.type === TYPE_SET) store.setRef(op.key, op.ref!, op.expireAt, op.dt);
      else if (op.type === TYPE_DEL) store.del(op.key);
      if (slice()) await yieldToLoop();
    }
  }
}

/** dev/ino/size identity of one persistent file at one moment. */
interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
}

/** The inode pair one consistent recovery pass actually scanned, handed to
 *  the disk-mode ValueReader attach check. null = the file did not exist. */
export interface GenerationAnchors {
  snapshot: { dev: number; ino: number } | null;
  wal: { dev: number; ino: number } | null;
}

/** Thrown when recovery kept detecting snapshot/WAL generation switches
 *  across every bounded retry — the writer is rotating files faster than a
 *  consistent pair can be scanned. Callers with a refresh loop (kap-server's
 *  readonly degrade path, the cluster shard reader) treat it as transient. */
export class RecoveryGenerationChurnError extends Error {
  readonly code = 'RECOVERY_GENERATION_CHURN';
  constructor(readonly attempts: number) {
    super(`recovery: snapshot/WAL generation kept changing across ${attempts} attempt(s)`);
    this.name = 'RecoveryGenerationChurnError';
  }
}

const GENERATION_RETRY_BASE_MS = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function statIdentity(p: string): FileIdentity | null {
  try {
    const st = fsSync.statSync(p);
    return { dev: st.dev, ino: st.ino, size: st.size };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** The pairing rule (see the file header): the file a pass scanned must still
 *  be the file at its path after the pass's last read — same dev+ino, and a
 *  size that never dropped below `sizeFloor` (append-only growth on the same
 *  inode is safe: the extra bytes are a staleness window catch-up covers).
 *  A null↔non-null transition (the file appeared or vanished mid-pass) cannot
 *  be verified and is treated as a generation switch. */
function sameGeneration(scanned: FileIdentity | null, after: FileIdentity | null, sizeFloor: number): boolean {
  if (scanned === null || after === null) return scanned === null && after === null;
  if (scanned.dev !== after.dev || scanned.ino !== after.ino) return false;
  return after.size >= sizeFloor;
}

/** Discard every record a churned pass applied, restoring the (always
 *  initially empty) Store for the next pass. del() keeps the bytes/expiry
 *  accounting consistent; stale TTL-heap entries are reaped lazily by their
 *  seq guard. (Map iteration survives deletion mid-iteration.) */
function resetStore(store: Store): void {
  for (const k of store.map.keys()) store.del(k);
}

export async function recover({
  dir,
  store,
  mode = 'resync',
  truncate = true,
  valueMode = 'memory',
  maxGenerationRetries = 4,
  attachValueReader,
  signal,
  timings,
}: {
  dir: string;
  store: Store;
  mode?: RecoveryMode;
  truncate?: boolean;
  valueMode?: ValueMode;
  /** Bounded retries when a pass detects a generation switch (default 4,
   *  exponential backoff from 5 ms). Exhaustion throws
   *  RecoveryGenerationChurnError. */
  maxGenerationRetries?: number;
  /** Disk-mode ValueReader attach point: called with the verified inode pair
   *  of an otherwise-consistent pass; must attach the reader to the current
   *  paths and report whether ITS handles are those same inodes. A false
   *  return discards the pass and retries the whole recovery — closing the
   *  "old offsets read a new file" window between recovery's final forensics
   *  and the reader attach. */
  attachValueReader?: (anchors: GenerationAnchors) => boolean;
  /** Cancellation for the async frame scans (stage 6): an aborted scan
   *  throws an 'AbortError' and leaves the pass's partial state discarded. */
  signal?: AbortSignal;
  /** Optional scan/apply wall-clock sink (see RecoveryPhaseTimings). */
  timings?: RecoveryPhaseTimings;
}): Promise<RecoveryInfo> {
  const snapPath = path.join(dir, SNAPSHOT_FILE);
  const walPath = path.join(dir, WAL_FILE);
  let delay = GENERATION_RETRY_BASE_MS;
  for (let attempt = 0; ; attempt++) {
    let pass: RecoverPassResult;
    try {
      pass = await recoverPass({ snapPath, walPath, store, mode, truncate, valueMode, signal, timings });
    } catch (e) {
      // A cancelled scan may have applied a prefix of the pass's frames:
      // discard the partial application so the error never carries state
      // into a caller that retries with the same Store.
      if ((e as Error).name === 'AbortError') resetStore(store);
      throw e;
    }
    if (pass.consistent && (!attachValueReader || attachValueReader(pass.anchors))) {
      pass.info.generationRetries = attempt;
      return pass.info;
    }
    // Generation churn: discard EVERY record this pass applied before
    // retrying, so no partial application state leaks into a later pass (or
    // survives inside the thrown error).
    resetStore(store);
    if (attempt >= maxGenerationRetries) throw new RecoveryGenerationChurnError(attempt + 1);
    await sleep(delay);
    delay *= 2;
  }
}

type RecoverPassResult = { consistent: false } | { consistent: true; info: RecoveryInfo; anchors: GenerationAnchors };

/** One recovery pass: scan + apply the snapshot then the WAL, recording the
 *  identity of each opened fd BEFORE scanning it (forensics round 1), then
 *  re-stat both paths AFTER the last read (round 2) and apply the pairing
 *  rule. Returns the recovered state plus the scanned inode anchors when the
 *  pass is generation-consistent; the caller retries otherwise. */
async function recoverPass({
  snapPath,
  walPath,
  store,
  mode,
  truncate,
  valueMode,
  signal,
  timings,
}: {
  snapPath: string;
  walPath: string;
  store: Store;
  mode: RecoveryMode;
  truncate: boolean;
  valueMode: ValueMode;
  signal?: AbortSignal;
  timings?: RecoveryPhaseTimings;
}): Promise<RecoverPassResult> {
  let corruptBatches = 0;
  const countCorruptBatch = (): void => {
    corruptBatches++;
  };
  let snapshotFrames = 0;
  let snapshotBytes = 0;
  let snapshotCorrupt: [number, number][] = [];
  let snapScanned: FileIdentity | null = null;
  if (fsSync.existsSync(snapPath)) {
    const fd = fsSync.openSync(snapPath, 'r');
    try {
      const st = fsSync.fstatSync(fd);
      snapScanned = { dev: st.dev, ino: st.ino, size: st.size };
      snapshotBytes = st.size;
      // Stage 6: the scan itself is async (sequential window reads, CRC
      // slices, periodic yields, abortable); only the in-memory apply below
      // runs on the event loop.
      const snapScanT0 = performance.now();
      const r = await scanFrameRefsFdAsync(fd, { onCorrupt: mode, signal });
      if (timings) timings.walScanMs += performance.now() - snapScanT0;
      const snapApplyT0 = performance.now();
      await applyFrames(r.frames, 'snapshot', fd, store, valueMode, countCorruptBatch);
      if (timings) timings.walApplyMs += performance.now() - snapApplyT0;
      snapshotFrames = r.frames.length;
      snapshotCorrupt = r.corruptRanges;
    } finally {
      fsSync.closeSync(fd);
    }
  }

  let walFrames = 0;
  let walBytes = 0;
  let walCorrupt: [number, number][] = [];
  let truncatedWal = false;
  let walScanEnd = 0;
  let walScanned: FileIdentity | null = null;
  // The size this pass itself leaves the WAL at: a torn-tail truncation is
  // our own write, so the post-scan re-stat is compared against this floor,
  // not against the pre-scan size.
  let walSizeFloor = 0;
  if (fsSync.existsSync(walPath)) {
    const fd = fsSync.openSync(walPath, 'r');
    try {
      const st = fsSync.fstatSync(fd);
      walScanned = { dev: st.dev, ino: st.ino, size: st.size };
      walSizeFloor = st.size;
      walBytes = st.size;
      const walScanT0 = performance.now();
      const r = await scanFrameRefsFdAsync(fd, { onCorrupt: mode, signal });
      if (timings) timings.walScanMs += performance.now() - walScanT0;
      const walApplyT0 = performance.now();
      await applyFrames(r.frames, 'wal', fd, store, valueMode, countCorruptBatch);
      if (timings) timings.walApplyMs += performance.now() - walApplyT0;
      walFrames = r.frames.length;
      walCorrupt = r.corruptRanges;
      walScanEnd = r.eofOffset;
      const last = r.corruptRanges[r.corruptRanges.length - 1];
      if (last && last[1] === st.size) {
        // A torn/corrupt tail is normally truncated so the next writer appends
        // cleanly. In read-only mode (truncate = false) we must never mutate the
        // database files: a read-only opener racing a live writer could otherwise
        // observe a momentarily-incomplete tail and destroy live data.
        if (truncate) {
          await fs.truncate(walPath, last[0]);
          truncatedWal = true;
          walSizeFloor = last[0];
        }
      }
    } finally {
      fsSync.closeSync(fd);
    }
  }

  // Forensics round 2: re-stat both paths after every byte was read.
  const snapAfter = statIdentity(snapPath);
  const walAfter = statIdentity(walPath);
  if (!sameGeneration(snapScanned, snapAfter, snapScanned?.size ?? 0)) return { consistent: false };
  if (!sameGeneration(walScanned, walAfter, walSizeFloor)) return { consistent: false };

  return {
    consistent: true,
    info: {
      snapshotFrames,
      walFrames,
      snapshotBytes,
      walBytes,
      truncatedWal,
      corruptRanges: walCorrupt,
      snapshotCorruptRanges: snapshotCorrupt,
      lostBytes: [...walCorrupt, ...snapshotCorrupt].reduce((a, [s, e]) => a + (e - s), 0),
      walScanEnd,
      walDev: walScanned?.dev ?? 0,
      walIno: walScanned?.ino ?? 0,
      snapshotDev: snapScanned?.dev ?? 0,
      snapshotIno: snapScanned?.ino ?? 0,
      corruptBatches,
      generationRetries: 0, // recover() overwrites with the real attempt count
    },
    anchors: {
      snapshot: snapScanned ? { dev: snapScanned.dev, ino: snapScanned.ino } : null,
      wal: walScanned ? { dev: walScanned.dev, ino: walScanned.ino } : null,
    },
  };
}

/** Continue a replica from a WAL watermark: strictly scan frames in
 *  [offset, EOF) of `walPath` and hand each to `apply(f, fd, slice)` in order.
 *
 *  Returns the new continuation offset (end of the last fully-valid frame)
 *  and how many frames were applied. An invalid/partial frame anywhere stops
 *  the scan WITHOUT error (a writer mid-writev leaves such a tail; everything
 *  applied before it stands and the next call re-validates from the stopped
 *  offset — its CRC passes once the writev lands). Returns null when `offset`
 *  cannot be a clean frame-boundary continuation (negative, beyond EOF,
 *  pointing at bytes that start no frame, or the file is not the `anchor`
 *  inode — rotation swapped it in the microseconds between the caller's stat
 *  and this open): the caller must fully reopen.
 *
 *  Cooperative (stage 5 follow-up of the open-path slicing): the frame scan
 *  runs through the windowed async scanner and the apply loop yields between
 *  primitive ops on the shared walApplySlicer budgets, so a replica that fell
 *  far behind no longer blocks the host loop in one synchronous scan+apply.
 *  `apply` receives the slicer and MUST await-yield when it fires — a BATCH
 *  frame unrolls into thousands of primitive ops, so frame-granular yielding
 *  could never bound a slice. Yielding mid-catch-up lets concurrent readers
 *  observe intermediate apply states; that is the documented replica contract
 *  (a replica is eventually consistent — the caller's watermark only advances
 *  once the whole delta has applied). */
export async function catchUpWalAsync(
  walPath: string,
  offset: number,
  anchor: { dev: number; ino: number },
  apply: (f: FrameRef, fd: number, slice: () => boolean) => Promise<void>,
): Promise<{ offset: number; appliedFrames: number } | null> {
  let fd: number;
  try {
    fd = fsSync.openSync(walPath, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const st = fsSync.fstatSync(fd);
    if (st.dev !== anchor.dev || st.ino !== anchor.ino) return null;
    const size = st.size;
    if (offset < 0 || offset > size) return null;
    const r = await scanFrameRefsFdAsync(fd, { onCorrupt: 'strict', startOffset: offset });
    if (r.frames.length === 0 && r.eofOffset < size) {
      // Bytes at `offset` start no valid frame. An append-only file grows
      // whole frames sequentially, so a torn tail is always a frame PREFIX
      // (starts with the magic): retry next time. Anything else means offset
      // was not a boundary of this file — no valid continuation exists here.
      const n = Math.min(MAGIC.length, size - offset);
      const head = readAtSync(fd, offset, n);
      if (!MAGIC.subarray(0, n).equals(head)) return null;
      return { offset, appliedFrames: 0 };
    }
    const slice = walApplySlicer();
    for (const f of r.frames) await apply(f, fd, slice);
    return { offset: r.eofOffset, appliedFrames: r.frames.length };
  } finally {
    fsSync.closeSync(fd);
  }
}
