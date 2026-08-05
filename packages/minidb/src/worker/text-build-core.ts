// src/worker/text-build-core.ts
//
// The engine of the stage-6 workerized full-text generation build. This
// module is deliberately free of MiniDb/live-state dependencies: it reads a
// PINNED source (the snapshot inode + the WAL prefix below a sealed
// checkpoint offset), reconstructs the store exactly as open-time recovery
// would (same frame interpretation, same expiry drop, same batch unrolling),
// then tokenizes every indexable document and produces a fresh postings base
// per text index — postings file, dictionary image, and the base doc table —
// as fully fsynced files inside the generation's tmp directory.
//
// It runs in two hosting modes:
//   - inside the worker thread (worker/text-build-worker.ts — the normal
//     path: the CPU-heavy tokenization/aggregation/merge never touches the
//     main event loop);
//   - inline on the main thread (the explicit fallback when a worker cannot
//     be spawned, e.g. a bundled single-file deployment).
//
// Memory discipline (the plan's hard requirement): the full `term -> all
// docs` aggregation is NEVER held in RAM. Per-index aggregations accumulate
// until the configured byte budget, then flush as sorted segment files; a
// final k-way external merge streams the segments into the postings file in
// term order. Peak memory is O(live keys) + O(budget) + O(hottest term's
// list) — bounded independently of the total (doc, term) pair count.
//
// Everything this module writes lands inside the generation tmp directory
// (a discardable artifact): a crash, cancel, OOM or ENOSPC here can never
// touch the currently published generation.
//
// IMPORT NOTE: every relative import in this file (and its whole import
// closure) uses explicit `.ts` specifiers so the worker thread can load the
// module under Node's native type stripping with `execArgv: []` — no tsx or
// bundler required inside the worker.

import fsSync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from '../crc32.ts';
import { scanFrameRefsFdAsync, scanBatchOpRefs, TYPE_SET, TYPE_DEL, TYPE_BATCH } from '../codec.ts';
import type { FrameRef } from '../codec.ts';
import { tokenize, extractText } from '../text-index/tokenize.ts';
import { createNgramTokenizer } from '../trigram.ts';
import { encodeRecord, encodePostingList, decodeRecord, decodePostingList } from '../text-postings.ts';
import { GenFileWriter, ByteReader, writeTextDictionaryImage } from '../gen-codec.ts';

// ---- spec / result ------------------------------------------------------------

export type WorkerTokenizerName = 'default' | 'ngram';

export interface WorkerTextIndexSpec {
  name: string;
  fields: readonly string[] | null;
  tokenizer: WorkerTokenizerName;
  /** Output paths INSIDE the generation tmp directory (discardable). */
  postingsPath: string;
  dictionaryPath: string;
  baseDocsPath: string;
}

export interface TextBuildCoreSpec {
  /** The pinned source: the snapshot inode (null when absent) and the WAL
   *  prefix [0, walOffset). The anchors are verified after open — a rotation
   *  racing the build fails it instead of reading a wrong file. */
  snapshotPath: string | null;
  walPath: string;
  walOffset: number;
  walDev: number;
  walIno: number;
  snapshotDev: number;
  snapshotIno: number;
  indexes: WorkerTextIndexSpec[];
  /** Aggregation byte budget per text index — exceeding it flushes a sorted
   *  postings segment to disk (external build). */
  memoryBudgetBytes: number;
  /** I/O mode for the big artifact writes (segments, postings): in a worker
   *  thread (syncIo: true) the writes are plain writeSync on the worker's
   *  own thread — they NEVER occupy the host's libuv thread pool (measured:
   *  the async variant serialized worker and main-thread I/O behind the
   *  default 4-thread pool, inflating builds 10-20x). The inline fallback
   *  keeps async I/O (it shares the main thread and must not block it). */
  syncIo?: boolean;
  /** Progress callback (every PROGRESS_DOCS docs and every segment flush). */
  onProgress?: (p: { docs: number; terms: number; segments: number }) => void;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

export interface TextBuildCoreIndexResult {
  name: string;
  /** Number of documents the new base indexes. */
  liveCount: number;
  dictTerms: number;
  postingsInfo: { bytes: number; crc32: number };
  dictionaryInfo: { bytes: number; crc32: number };
  baseDocsInfo: { bytes: number; crc32: number };
  segmentsFlushed: number;
}

export interface TextBuildCoreResult {
  indexes: TextBuildCoreIndexResult[];
  /** Live (unexpired) keys at the checkpoint, as reconstructed by the
   *  worker — the main thread sanity-checks it against its own image. */
  scannedLiveKeys: number;
  expiredSkipped: number;
  docsIndexed: number;
}

function abortError(): Error {
  const err = new Error('text build aborted');
  err.name = 'AbortError';
  return err;
}

/** Progress cadence AND the worker's own thread-yield cadence: every this
 *  many docs the build checks cancellation, reports progress, and yields
 *  its thread (setImmediate), so the tokenization run never becomes one
 *  multi-hundred-ms CPU burst — that keeps the host process's other threads
 *  (the main event loop) smoothly scheduled on platforms with coarse CPU
 *  time-slicing. */
const PROGRESS_DOCS = 2048;
/** Segment/postings write coalescing. */
const FLUSH_BYTES = 1 << 20;
/** Estimated RAM per (term, docID) aggregation entry plus per-term overhead:
 *  the budget's accounting currency (approximation, not an exact RSS). */
const AGG_ENTRY_BYTES = 56;
const AGG_TERM_BYTES = 96;

// ---- live-set reconstruction ----------------------------------------------------

interface LiveLoc {
  file: 'snapshot' | 'wal';
  off: number;
  len: number;
}

function readAtSync(fd: number, off: number, len: number): Buffer {
  if (len === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const r = fsSync.readSync(fd, buf, got, len - got, off + got);
    if (r === 0) throw new Error('text build: short read past EOF');
    got += r;
  }
  return buf;
}

/** Apply one frame to the live loc map, mirroring recovery's frameToOps
 *  (expired SET → DEL, BATCH unrolled with whole-batch skip on a malformed
 *  body). Value bytes are never copied — only their locations. Returns true
 *  when the frame was an expired-SET drop. */
function applyFrame(f: FrameRef, file: 'snapshot' | 'wal', fd: number, live: Map<string, LiveLoc>, now: number): boolean {
  let droppedExpired = false;
  const applySet = (key: Buffer, valueOff: number, valLen: number, expireAt: number): void => {
    const k = key.toString('binary');
    if (expireAt && expireAt <= now) {
      live.delete(k);
      droppedExpired = true;
      return;
    }
    live.set(k, { file, off: valueOff, len: valLen });
  };
  const applyDel = (key: Buffer): void => {
    live.delete(key.toString('binary'));
  };
  if (f.type === TYPE_SET) {
    applySet(f.key, f.valueOff, f.valLen, f.expireAt);
  } else if (f.type === TYPE_DEL) {
    applyDel(f.key);
  } else if (f.type === TYPE_BATCH) {
    let ops;
    try {
      ops = scanBatchOpRefs(readAtSync(fd, f.valueOff, f.valLen), f.valueOff);
    } catch {
      return false; // malformed batch with a valid outer CRC: skip whole (frameToOps)
    }
    for (const op of ops) {
      if (op.type === TYPE_SET) applySet(op.key, op.valueOff, op.valLen, op.expireAt);
      else if (op.type === TYPE_DEL) applyDel(op.key);
    }
  }
  return droppedExpired;
}

// ---- postings segment writer / reader ------------------------------------------

/** Append one index's sorted aggregation as a segment file (sorted term
 *  records in the native postings record framing). `syncIo` selects
 *  writeSync (worker thread) over thread-pool writes (inline fallback) —
 *  see TextBuildCoreSpec.syncIo. */
async function flushSegment(segPath: string, agg: Map<string, Map<number, number>>, syncIo: boolean): Promise<void> {
  const terms = [...agg.keys()].sort();
  const fh = await fsp.open(segPath, 'w');
  let batch: Buffer[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const buf = Buffer.concat(batch);
    batch = [];
    batchBytes = 0;
    let written = 0;
    while (written < buf.length) {
      const n = syncIo ? fsSync.writeSync(fh.fd, buf, written) : (await fh.write(buf, written)).bytesWritten;
      if (n === 0) throw new Error('text build: segment write made no progress');
      written += n;
    }
  };
  try {
    for (const term of terms) {
      const entries = agg.get(term)!;
      const rec = encodeRecord(term, entries.size, encodePostingList(entries));
      batch.push(rec);
      batchBytes += rec.length;
      if (batchBytes >= FLUSH_BYTES) await flush();
    }
    await flush();
    if (syncIo) fsSync.fsyncSync(fh.fd);
    else await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Sequential reader over one sorted segment file. */
class SegmentReader {
  private fd: number;
  private buf = Buffer.allocUnsafe(1 << 20);
  private bufStart = 0;
  private bufLen = 0;
  private pos = 0;
  private readonly size: number;
  current: { term: string; df: number; payload: Buffer } | null = null;

  private constructor(segPath: string) {
    this.fd = fsSync.openSync(segPath, 'r');
    this.size = fsSync.fstatSync(this.fd).size;
  }

  static async open(segPath: string): Promise<SegmentReader> {
    const r = new SegmentReader(segPath);
    await r.advance();
    return r;
  }

  private async fill(): Promise<void> {
    const end = this.bufStart + this.bufLen;
    if (this.pos < end) {
      this.buf.copyWithin(0, this.pos - this.bufStart, end);
      this.bufLen = end - this.pos;
      this.bufStart = this.pos;
    } else {
      this.bufStart = this.pos;
      this.bufLen = 0;
    }
    while (this.bufLen < this.buf.length && this.bufStart + this.bufLen < this.size) {
      const n = fsSync.readSync(this.fd, this.buf, this.bufLen, Math.min(this.buf.length - this.bufLen, this.size - this.bufStart - this.bufLen), this.bufStart + this.bufLen);
      if (n === 0) break;
      this.bufLen += n;
    }
  }

  /** Advance to the next record; current becomes null at EOF. */
  async advance(): Promise<void> {
    for (;;) {
      const avail = this.bufStart + this.bufLen - this.pos;
      if (avail >= 2) {
        const o = this.pos - this.bufStart;
        const termLen = this.buf.readUInt16LE(o);
        // record length: 2 + term + 4 df + 4 payloadLen + payload + 4 crc
        if (avail >= 2 + termLen + 8) {
          const payloadLen = this.buf.readUInt32LE(o + 2 + termLen + 4);
          const recLen = 2 + termLen + 8 + payloadLen + 4;
          if (avail >= recLen) {
            const recBuf = Buffer.from(this.buf.subarray(o, o + recLen));
            const rec = decodeRecord(recBuf);
            this.current = { term: rec.term, df: rec.df, payload: Buffer.from(rec.payload) };
            this.pos += recLen;
            return;
          }
        }
      }
      if (this.bufStart + this.bufLen >= this.size && this.pos >= this.bufStart + this.bufLen) {
        this.current = null;
        return;
      }
      await this.fill();
    }
  }

  close(): void {
    fsSync.closeSync(this.fd);
  }
}

// ---- raw postings writer --------------------------------------------------------

/** Streams postings records to the target file with a running whole-file
 *  crc32 (the integrity record the generation manifest carries). `syncIo`
 *  selects writeSync (worker thread) over thread-pool writes. */
class RawPostingsWriter {
  private batch: Buffer[] = [];
  private batchBytes = 0;
  private crc = 0;
  private off = 0;
  private fh: fsp.FileHandle | null = null;

  private constructor(
    private readonly filePath: string,
    private readonly syncIo: boolean,
  ) {}

  static async open(filePath: string, opts: { syncIo?: boolean } = {}): Promise<RawPostingsWriter> {
    const w = new RawPostingsWriter(filePath, opts.syncIo ?? false);
    w.fh = await fsp.open(filePath, 'w');
    return w;
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    const buf = Buffer.concat(this.batch);
    this.batch = [];
    this.batchBytes = 0;
    this.crc = crc32(buf, this.crc);
    let written = 0;
    while (written < buf.length) {
      const n = this.syncIo ? fsSync.writeSync(this.fh!.fd, buf, written) : (await this.fh!.write(buf, written)).bytesWritten;
      if (n === 0) throw new Error('text build: postings write made no progress');
      written += n;
    }
  }

  async write(rec: Buffer): Promise<number> {
    const at = this.off;
    this.batch.push(rec);
    this.batchBytes += rec.length;
    this.off += rec.length;
    if (this.batchBytes >= FLUSH_BYTES) await this.flush();
    return at;
  }

  async finish(): Promise<{ bytes: number; crc32: number }> {
    try {
      await this.flush();
      if (this.syncIo) fsSync.fsyncSync(this.fh!.fd);
      else await this.fh!.sync();
      return { bytes: this.off, crc32: this.crc >>> 0 };
    } finally {
      await this.fh!.close().catch(() => {});
    }
  }

  async abort(): Promise<void> {
    await this.fh!.close().catch(() => {});
  }
}

// ---- base docs image (worker-produced doc table) ---------------------------------

const BASE_DOCS_MAGIC = 'MDTB';
const BASE_DOCS_VERSION = 1;

/** The base doc table produced by the worker: docID -> key (undefined = the
 *  docID was never assigned beyond this count — worker bases are dense) and
 *  docID -> token count. The main thread reads it back to attach the base;
 *  the generation's final docs image (delta/tombstones included) is written
 *  by the main thread after the queue replay, from the live index. */
async function writeBaseDocsImage(
  filePath: string,
  keys: (string | undefined)[],
  docLens: Map<number, number>,
): Promise<{ bytes: number; crc32: number }> {
  const w = await GenFileWriter.open(filePath, BASE_DOCS_MAGIC, BASE_DOCS_VERSION);
  try {
    await w.writeRecord((b) => b.u64(keys.length));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const len = docLens.get(i) ?? 0;
      await w.writeRecord((b) => {
        if (k === undefined) b.u8(0);
        else {
          b.u8(1);
          b.key(k);
        }
        b.u32(len);
      });
    }
    return await w.finish();
  } catch (e) {
    await w.abort();
    throw e;
  }
}

/** Read back a base docs image (main thread, at rebase attach time). */
export function readBaseDocsImage(r: ByteReader): { keys: (string | undefined)[]; docLens: Map<number, number> } {
  const count = r.u64();
  const keys: (string | undefined)[] = [];
  const docLens = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const present = r.u8();
    if (present === 1) {
      keys.push(r.key());
      const len = r.u32();
      if (len !== 0) docLens.set(i, len);
    } else if (present === 0) {
      keys.push(undefined);
      r.u32(); // unused for holes
    } else {
      throw new Error(`base docs image: unknown presence tag ${present}`);
    }
  }
  if (!r.done) throw new Error('base docs image: trailing bytes');
  return { keys, docLens };
}

/** Sliced variant (stage 6): identical result, with event-loop yields every
 *  `yieldEvery` docs so a million-doc table never parses in one synchronous
 *  run. */
export async function readBaseDocsImageAsync(
  r: ByteReader,
  yieldEvery = 65536,
): Promise<{ keys: (string | undefined)[]; docLens: Map<number, number> }> {
  const count = r.u64();
  const keys: (string | undefined)[] = [];
  const docLens = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const present = r.u8();
    if (present === 1) {
      keys.push(r.key());
      const len = r.u32();
      if (len !== 0) docLens.set(i, len);
    } else if (present === 0) {
      keys.push(undefined);
      r.u32(); // unused for holes
    } else {
      throw new Error(`base docs image: unknown presence tag ${present}`);
    }
    if (i % yieldEvery === yieldEvery - 1) await new Promise((res) => setImmediate(res));
  }
  if (!r.done) throw new Error('base docs image: trailing bytes');
  return { keys, docLens };
}

export { BASE_DOCS_MAGIC, BASE_DOCS_VERSION };

// ---- per-index build state --------------------------------------------------------

interface IndexBuildState {
  spec: WorkerTextIndexSpec;
  tokenizer: (text: string) => string[];
  agg: Map<string, Map<number, number>>;
  aggEntries: number;
  aggBytes: number;
  /** docID -> token count FOR THIS INDEX (tokenizers differ per index). */
  docLens: Map<number, number>;
  segments: string[];
  seq: number;
}

function tokenizerFor(name: WorkerTokenizerName): (text: string) => string[] {
  // Mirrors MiniDb's textIndexTokenizers mapping for the BUILT-IN tokenizers
  // (custom function tokenizers cannot cross the worker boundary — such
  // indexes stay on the main-thread staged build).
  if (name === 'ngram') return createNgramTokenizer();
  return tokenize;
}

// ---- the build --------------------------------------------------------------------

/** Run the whole pinned-source text build (see the file header). Async; the
 *  caller hosts it in a worker thread or inline. */
export async function buildTextArtifacts(spec: TextBuildCoreSpec): Promise<TextBuildCoreResult> {
  const throwIfAborted = (): void => {
    if (spec.signal?.aborted) throw abortError();
  };
  const now = Date.now();
  const live = new Map<string, LiveLoc>();
  let expiredSkipped = 0;

  // Pass 1: reconstruct the live key set (locations only) from the pinned
  // source. Both fds are identity-checked against the anchors — a rotation
  // that raced the main thread's checkpoint fails the build here.
  if (spec.snapshotPath !== null) {
    const fd = fsSync.openSync(spec.snapshotPath, 'r');
    try {
      const st = fsSync.fstatSync(fd);
      if (st.dev !== spec.snapshotDev || st.ino !== spec.snapshotIno) {
        throw new Error('text build: snapshot anchor mismatch (rotated)');
      }
      const r = await scanFrameRefsFdAsync(fd, { onCorrupt: 'resync', signal: spec.signal });
      for (const f of r.frames) if (applyFrame(f, 'snapshot', fd, live, now)) expiredSkipped++;
    } finally {
      fsSync.closeSync(fd);
    }
  }
  {
    const fd = fsSync.openSync(spec.walPath, 'r');
    try {
      const st = fsSync.fstatSync(fd);
      if (st.dev !== spec.walDev || st.ino !== spec.walIno) {
        throw new Error('text build: WAL anchor mismatch (rotated)');
      }
      const r = await scanFrameRefsFdAsync(fd, { onCorrupt: 'resync', endOffset: spec.walOffset, signal: spec.signal });
      // The pinned prefix must scan clean to exactly the checkpoint: a torn
      // or truncated WAL below the checkpoint means the checkpoint moved
      // under us (in-place recovery) — fail the build, never guess.
      if (r.eofOffset !== spec.walOffset) {
        throw new Error(`text build: WAL prefix does not reach the checkpoint (${r.eofOffset} != ${spec.walOffset})`);
      }
      for (const f of r.frames) if (applyFrame(f, 'wal', fd, live, now)) expiredSkipped++;
    } finally {
      fsSync.closeSync(fd);
    }
  }
  throwIfAborted();

  // Pass 2: process documents in STORAGE order (snapshot first, then by
  // ascending value offset): the per-doc value reads below become sequential
  // I/O (kernel readahead applies, and adjacent values coalesce into shared
  // reads) instead of one random positioned read per key — measured to cut
  // the syscall rate ~10x, which also keeps the host's event loop responsive
  // on platforms where a dense syscall stream delays loop wakeups. docIDs
  // are dense and deterministic in this order (the WAL's append order is
  // fixed), and every postings list stays docID-ascending across the k-way
  // merge (segment seq ascends with docID). Only indexable documents (JSON
  // objects, the MiniDb rule) get a docID, exactly like the main-thread
  // staged build.
  const ordered = [...live.entries()].sort((a, b) =>
    a[1].file < b[1].file ? -1 : a[1].file > b[1].file ? 1 : a[1].off - b[1].off,
  );
  const states = spec.indexes.map((indexSpec) => ({
    spec: indexSpec,
    tokenizer: tokenizerFor(indexSpec.tokenizer),
    agg: new Map<string, Map<number, number>>(),
    aggEntries: 0,
    aggBytes: 0,
    docLens: new Map<number, number>(),
    segments: [] as string[],
    seq: 0,
  })) as IndexBuildState[];
  const keys: (string | undefined)[] = [];
  let docsIndexed = 0;
  let progressDocs = 0;

  const fds = new Map<'snapshot' | 'wal', number>();
  const fdFor = (file: 'snapshot' | 'wal'): number => {
    let fd = fds.get(file);
    if (fd === undefined) {
      fd = fsSync.openSync(file === 'snapshot' ? spec.snapshotPath! : spec.walPath, 'r');
      fds.set(file, fd);
    }
    return fd;
  };

  const flushState = async (st: IndexBuildState): Promise<void> => {
    if (st.aggEntries === 0) return;
    const segPath = `${st.spec.postingsPath}.seg-${String(st.seq++).padStart(4, '0')}`;
    await flushSegment(segPath, st.agg, spec.syncIo ?? false);
    st.segments.push(segPath);
    st.agg.clear();
    st.aggEntries = 0;
    st.aggBytes = 0;
  };

  // Coalesced value reads: values written back-to-back (the common WAL
  // append pattern) are fetched with ONE positioned read per run instead of
  // one per document. A run stops at a file switch, a gap, or the cap.
  const READ_RUN_GAP = 4096;
  const READ_RUN_CAP = 1 << 20;
  const fileSizes = new Map<'snapshot' | 'wal', number>();
  const sizeOf = (file: 'snapshot' | 'wal'): number => {
    let s = fileSizes.get(file);
    if (s === undefined) {
      s = fsSync.fstatSync(fdFor(file)).size;
      fileSizes.set(file, s);
    }
    return s;
  };
  let runBuf: Buffer | null = null;
  let runFile: 'snapshot' | 'wal' | null = null;
  let runStart = 0; // absolute offset of runBuf[0]
  const valueAt = (file: 'snapshot' | 'wal', off: number, len: number): Buffer => {
    if (runBuf === null || runFile !== file || off < runStart || off + len > runStart + runBuf.length) {
      // Start a new run: cover this value plus whatever follows contiguously
      // (capped at EOF — the pinned WAL may be shorter than the cap).
      const runLen = Math.min(READ_RUN_CAP, Math.max(len, READ_RUN_GAP), sizeOf(file) - off);
      runBuf = readAtSync(fdFor(file), off, runLen);
      runFile = file;
      runStart = off;
    }
    return runBuf.subarray(off - runStart, off - runStart + len);
  };

  try {
    for (const [kstr, loc] of ordered) {
      const raw = valueAt(loc.file, loc.off, loc.len);
      let doc: unknown;
      try {
        doc = JSON.parse(raw.toString('utf8'));
      } catch {
        doc = undefined; // not a JSON value: not indexable (mirrors MiniDb)
      }
      if (doc === null || typeof doc !== 'object') continue;
      const docID = keys.length;
      keys.push(kstr);
      for (const st of states) {
        const text = extractText(st.spec.fields, doc);
        const tokens = st.tokenizer(text);
        st.docLens.set(docID, tokens.length);
        if (tokens.length === 0) continue;
        const counts = new Map<string, number>();
        for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
        for (const [t, c] of counts) {
          let m = st.agg.get(t);
          if (!m) {
            st.agg.set(t, (m = new Map()));
            st.aggBytes += AGG_TERM_BYTES + Buffer.byteLength(t, 'utf8');
          }
          m.set(docID, c); // docIDs ascend -> insertion order is sorted
          st.aggEntries++;
          st.aggBytes += AGG_ENTRY_BYTES;
        }
        // Budget check between documents (never mid-document): an index over
        // budget flushes its aggregation as one sorted segment. This is the
        // build's memory ceiling — peak RAM stays O(budget), not O(pairs).
        if (st.aggBytes >= spec.memoryBudgetBytes) await flushState(st);
      }
      docsIndexed++;
      progressDocs++;
      if (progressDocs >= PROGRESS_DOCS) {
        progressDocs = 0;
        throwIfAborted();
        // Yield this thread (see WORKER_YIELD_DOCS): breaks the tokenization
        // run into short CPU slices instead of one multi-hundred-ms burst.
        await new Promise((r) => setImmediate(r));
        spec.onProgress?.({
          docs: docID + 1,
          terms: states.reduce((a, s) => a + s.agg.size, 0),
          segments: states.reduce((a, s) => a + s.segments.length, 0),
        });
      }
    }

    throwIfAborted();

    // Final: write postings (directly, or via the k-way external merge),
    // then the dictionary image and the base doc table.
    const results: TextBuildCoreIndexResult[] = [];
    for (const st of states) {
      // Flush the remaining aggregation as the last segment when a merge is
      // needed; a build with zero segments writes straight from RAM.
      if (st.segments.length > 0) await flushState(st);

      const dict = new Map<string, { off: number; len: number; df: number }>();
      const writer = await RawPostingsWriter.open(st.spec.postingsPath, { syncIo: spec.syncIo ?? false });
      let postingsInfo: { bytes: number; crc32: number };
      try {
        if (st.segments.length === 0) {
          const terms = [...st.agg.keys()].sort();
          for (const term of terms) {
            const entries = st.agg.get(term)!;
            const rec = encodeRecord(term, entries.size, encodePostingList(entries));
            const at = await writer.write(rec);
            dict.set(term, { off: at, len: rec.length, df: entries.size });
          }
        } else {
          await mergeSegments(st.segments, writer, dict);
        }
        postingsInfo = await writer.finish();
      } catch (e) {
        await writer.abort();
        throw e;
      } finally {
        for (const segPath of st.segments) await fsp.rm(segPath, { force: true }).catch(() => {});
      }
      throwIfAborted();

      const dictionaryInfo = await writeTextDictionaryImage(
        st.spec.dictionaryPath,
        (function* (): Generator<{ term: string; off: number; len: number; df: number }> {
          for (const [term, e] of dict) yield { term, off: e.off, len: e.len, df: e.df };
        })(),
      );
      const baseDocsInfo = await writeBaseDocsImage(st.spec.baseDocsPath, keys, st.docLens);
      results.push({
        name: st.spec.name,
        liveCount: docsIndexed,
        dictTerms: dict.size,
        postingsInfo,
        dictionaryInfo,
        baseDocsInfo,
        segmentsFlushed: st.segments.length,
      });
      spec.onProgress?.({ docs: keys.length, terms: dict.size, segments: st.segments.length });
    }

    return {
      indexes: results,
      scannedLiveKeys: live.size,
      expiredSkipped,
      docsIndexed,
    };
  } finally {
    for (const fd of fds.values()) fsSync.closeSync(fd);
  }
}

/** K-way external merge of sorted segment files into the postings file:
 *  docIDs ascend within and across segments (they are assigned in key order
 *  and segments flush in docID order), so a term's lists concatenate without
 *  a re-sort; only the delta chains are re-encoded jointly. */
async function mergeSegments(
  segments: string[],
  writer: RawPostingsWriter,
  dict: Map<string, { off: number; len: number; df: number }>,
): Promise<void> {
  const readers = await Promise.all(segments.map((p) => SegmentReader.open(p)));
  try {
    for (;;) {
      let minTerm: string | null = null;
      for (const r of readers) {
        const cur = r.current;
        if (cur !== null && (minTerm === null || cur.term < minTerm)) minTerm = cur.term;
      }
      if (minTerm === null) break;
      // Collect every segment's list for this term (segment order = docID
      // order), decode, concatenate, and re-encode jointly. Only ONE term's
      // combined list lives in memory at a time — the format's inherent floor.
      const merged: [number, number][] = [];
      for (const r of readers) {
        const cur = r.current;
        if (cur === null || cur.term !== minTerm) continue;
        const pairs = decodePostingList(cur.payload);
        for (const p of pairs) merged.push(p);
        await r.advance();
      }
      const rec = encodeRecord(minTerm, merged.length, encodePostingList(merged));
      const at = await writer.write(rec);
      dict.set(minTerm, { off: at, len: rec.length, df: merged.length });
    }
  } finally {
    for (const r of readers) r.close();
  }
}

/** The tmp-dir sibling segment files a cancelled/failed build may strand
 *  (matched for cleanup by the caller; the generation tmp sweep covers them
 *  on the next open regardless). */
export function isTextBuildSegmentFile(name: string): boolean {
  return /^text-.*\.postings\.seg-\d+$/.test(path.basename(name));
}
