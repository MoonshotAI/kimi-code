// src/gen-codec.ts
//
// Binary codecs for the per-file payloads of a persistent index generation
// (stage 5): the store image and every derived-index image. Each file is a
// self-describing envelope — 4-byte magic, u32 format version, payload, and a
// trailing crc32 over everything before it — so a torn or mismatched write is
// detected at load and only ever costs that one file (a corrupt store image
// rejects the whole generation; a corrupt index image rebuilds that index
// from the loaded store; neither touches the authoritative snapshot/WAL).
//
// Writers stream to disk in ~1 MiB writev batches with a running crc (large
// store images never sit wholly in RAM twice); readers load the whole file —
// the payload becomes in-memory state anyway — and verify the crc up front.
//
// Key encoding pitfall: MiniDb's canonical key strings are BINARY strings
// (each char code == one utf8 byte of the key). They are always written as
// raw bytes (u16 length + Buffer.from(k, 'binary')); writing them as utf8
// would corrupt every non-ASCII key. Genuine text (index names, fields,
// scalar keys, group/order strings, terms) is written as utf8.
//
// Internal to the package — NOT re-exported from the root entry point.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { crc32 } from './crc32.ts';
import type { ValueRef } from './store.js';

/** Thrown by every reader on a malformed/truncated/crc-mismatched generation
 *  file. Distinct from CorruptFrameError so the loader can route precisely. */
export class GenerationCorruptError extends Error {
  readonly code = 'GENERATION_CORRUPT';
  constructor(message: string) {
    super(message);
    this.name = 'GenerationCorruptError';
  }
}

// ---- byte-level writer/reader ----------------------------------------------

/** Growable record encoder; one generation file record must fit one chunk. */
class ByteWriter {
  buf: Buffer;
  off = 0;

  constructor(sizeHint = 64) {
    this.buf = Buffer.allocUnsafe(sizeHint);
  }

  ensure(n: number): void {
    if (this.off + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.off + n) cap *= 2;
    const next = Buffer.allocUnsafe(cap);
    this.buf.copy(next, 0, 0, this.off);
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf.writeUInt8(v, this.off);
    this.off += 1;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf.writeUInt16LE(v, this.off);
    this.off += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf.writeUInt32LE(v >>> 0, this.off);
    this.off += 4;
  }

  u64(v: number): void {
    this.ensure(8);
    this.buf.writeBigUInt64LE(BigInt(v), this.off);
    this.off += 8;
  }

  i64(v: number): void {
    this.ensure(8);
    this.buf.writeBigInt64LE(BigInt(v), this.off);
    this.off += 8;
  }

  f64(v: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.off);
    this.off += 8;
  }

  bytes(b: Buffer): void {
    this.ensure(b.length);
    b.copy(this.buf, this.off);
    this.off += b.length;
  }

  /** A canonical (binary) key string: u16 byte length + raw bytes. */
  key(kstr: string): void {
    const b = Buffer.from(kstr, 'binary');
    this.u16(b.length);
    this.bytes(b);
  }

  /** A genuine text string: u32 utf8 byte length + utf8 bytes. */
  text(s: string): void {
    const b = Buffer.from(s, 'utf8');
    this.u32(b.length);
    this.bytes(b);
  }

  /** A term (bounded by the text index's uint16 limit): u16 + utf8. */
  term(s: string): void {
    const b = Buffer.from(s, 'utf8');
    this.u16(b.length);
    this.bytes(b);
  }
}

export class ByteReader {
  off = 0;

  constructor(readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.off + n > this.buf.length) throw new GenerationCorruptError('generation file truncated');
  }

  u8(): number {
    this.need(1);
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const v = Number(this.buf.readBigUInt64LE(this.off));
    this.off += 8;
    return v;
  }

  i64(): number {
    this.need(8);
    const v = Number(this.buf.readBigInt64LE(this.off));
    this.off += 8;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  key(): string {
    const n = this.u16();
    return this.bytes(n).toString('binary');
  }

  text(): string {
    const n = this.u32();
    return this.bytes(n).toString('utf8');
  }

  term(): string {
    const n = this.u16();
    return this.bytes(n).toString('utf8');
  }

  get done(): boolean {
    return this.off === this.buf.length;
  }
}

// ---- file envelope + streaming writer --------------------------------------

const FLUSH_BYTES = 1 << 20;

/** Streaming generation-file writer: envelope header, ~1 MiB writev batches,
 *  running crc32, fsync on finish. The crc/bytes it reports feed the
 *  manifest's per-file integrity records. */
export class GenFileWriter {
  private readonly chunks: Buffer[] = [];
  private queued = 0;
  private crc = 0;
  bytes = 0;
  private readonly rec = new ByteWriter(256);

  private constructor(
    private readonly fh: FileHandle,
    magic: string,
    version: number,
  ) {
    const w = new ByteWriter(8);
    for (let i = 0; i < 4; i++) w.u8(magic.codePointAt(i));
    w.u32(version);
    const head = w.buf.subarray(0, w.off);
    this.chunks.push(Buffer.from(head));
    this.queued = head.length;
  }

  static async open(path: string, magic: string, version: number): Promise<GenFileWriter> {
    if (magic.length !== 4) throw new RangeError('generation file magic must be 4 chars');
    const fh = await fs.open(path, 'w');
    try {
      return new GenFileWriter(fh, magic, version);
    } catch (error) {
      await fh.close().catch(() => {});
      throw error;
    }
  }

  /** Encode one record with `encode(w)` and queue it for the next batch. */
  async writeRecord(encode: (w: ByteWriter) => void): Promise<void> {
    const w = this.rec;
    w.off = 0;
    encode(w);
    const b = Buffer.from(w.buf.subarray(0, w.off));
    this.chunks.push(b);
    this.queued += b.length;
    if (this.queued >= FLUSH_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.chunks.length === 0) return;
    const bufs = this.chunks.splice(0);
    this.queued = 0;
    for (const b of bufs) this.crc = crc32(b, this.crc);
    // Index-based consumption walk: a flush can carry tens of thousands of
    // tiny record buffers (the text docs image averages ~14 B/record), and a
    // shift()-per-buffer loop is O(n²) on the main thread — measured 20+s of
    // self time across one 1M-doc generation publish, surfacing as the
    // multi-second event-loop stalls at the publish tail.
    let idx = 0;
    let off = 0;
    while (idx < bufs.length) {
      const toWrite = off > 0 ? [bufs[idx]!.subarray(off), ...bufs.slice(idx + 1)] : idx === 0 ? bufs : bufs.slice(idx);
      const { bytesWritten } = await this.fh.writev(toWrite);
      if (bytesWritten === 0) throw new Error('generation file writev made no progress (short write)');
      this.bytes += bytesWritten;
      let rem = bytesWritten;
      while (rem > 0 && idx < bufs.length) {
        const left = bufs[idx]!.length - off;
        if (rem < left) {
          off += rem;
          rem = 0;
        } else {
          rem -= left;
          idx++;
          off = 0;
        }
      }
    }
  }

  /** Flush, append the crc trailer, fsync, close. Returns the manifest's
   *  per-file integrity record ({ bytes, crc32 }). */
  async finish(): Promise<{ bytes: number; crc32: number }> {
    try {
      await this.flush();
      const trailer = Buffer.allocUnsafe(4);
      trailer.writeUInt32LE(this.crc >>> 0, 0);
      let written = 0;
      while (written < 4) {
        const { bytesWritten } = await this.fh.write(trailer, written);
        if (bytesWritten === 0) throw new Error('generation file write made no progress (short write)');
        written += bytesWritten;
      }
      this.bytes += 4;
      await this.fh.sync();
      return { bytes: this.bytes, crc32: this.crc >>> 0 };
    } finally {
      await this.fh.close().catch(() => {});
    }
  }

  /** Abort without finishing: close (the caller removes the tmp file). */
  async abort(): Promise<void> {
    await this.fh.close().catch(() => {});
  }
}

/** A verified generation file: the payload reader plus the whole-file
 *  integrity record (byte length + crc32) for cross-checking against the
 *  manifest. */
export interface VerifiedGenerationFile {
  payload: ByteReader;
  bytes: number;
  crc32: number;
}

/** Read + verify one whole generation file: magic, version, and the crc
 *  trailer. Returns the payload reader and the computed integrity record. */
export async function readGenerationFile(path: string, magic: string, version: number): Promise<VerifiedGenerationFile> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch (error) {
    throw new GenerationCorruptError(`generation file unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return parseGenerationBuffer(buf, magic, version);
}

/** Pure-buffer variant of readGenerationFile (tests, in-memory verification). */
export function parseGenerationBuffer(buf: Buffer, magic: string, version: number): VerifiedGenerationFile {
  if (buf.length < 8 + 4) throw new GenerationCorruptError('generation file too short');
  for (let i = 0; i < 4; i++) {
    if (buf.readUInt8(i) !== magic.codePointAt(i)) throw new GenerationCorruptError(`bad magic (want ${magic})`);
  }
  if (buf.readUInt32LE(4) !== version) throw new GenerationCorruptError(`unsupported file version (want ${version})`);
  const stored = buf.readUInt32LE(buf.length - 4);
  const calc = crc32(buf.subarray(0, buf.length - 4));
  if (stored !== calc) throw new GenerationCorruptError('generation file crc mismatch');
  return { payload: new ByteReader(buf.subarray(8, buf.length - 4)), bytes: buf.length, crc32: stored };
}

/** Read + verify a generation file AND cross-check it against the manifest's
 *  integrity record — a file swapped in from another generation (or a
 *  manifest from another build) is caught here. */
export async function readGenerationFileChecked(
  path: string,
  magic: string,
  version: number,
  expected: { bytes: number; crc32: number },
): Promise<ByteReader> {
  const f = await readGenerationFile(path, magic, version);
  if (f.bytes !== expected.bytes || f.crc32 !== expected.crc32) {
    throw new GenerationCorruptError('generation file does not match manifest record');
  }
  return f.payload;
}

/** Sliced variant of readGenerationFileChecked (stage 6): the file is read
 *  and crc'd in 1 MiB slices with event-loop yields, so verifying a large
 *  dictionary/docs image never blocks the loop for the whole pass. The
 *  payload still lands in RAM wholesale (it becomes in-memory state), only
 *  the read + verification is sliced. */
export async function readGenerationFileCheckedAsync(
  path: string,
  magic: string,
  version: number,
  expected: { bytes: number; crc32: number },
): Promise<ByteReader> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch (error) {
    throw new GenerationCorruptError(`generation file unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  if (buf.length < 8 + 4) throw new GenerationCorruptError('generation file too short');
  for (let i = 0; i < 4; i++) {
    if (buf.readUInt8(i) !== magic.codePointAt(i)) throw new GenerationCorruptError(`bad magic (want ${magic})`);
  }
  if (buf.readUInt32LE(4) !== version) throw new GenerationCorruptError(`unsupported file version (want ${version})`);
  const stored = buf.readUInt32LE(buf.length - 4);
  let crc = 0;
  const SLICE = 1 << 20;
  for (let pos = 0; pos < buf.length - 4; pos += SLICE) {
    crc = crc32(buf.subarray(pos, Math.min(pos + SLICE, buf.length - 4)), crc);
    await new Promise((r) => setImmediate(r));
  }
  if (stored !== crc) throw new GenerationCorruptError('generation file crc mismatch');
  if (buf.length !== expected.bytes || stored !== expected.crc32) {
    throw new GenerationCorruptError('generation file does not match manifest record');
  }
  return new ByteReader(buf.subarray(8, buf.length - 4));
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Verify a raw file against the manifest's integrity record by streaming
 *  its bytes (bounded memory — used for the postings files, which have no
 *  envelope of their own and are otherwise only verified lazily, per-record,
 *  at search time). One sequential read: cheap insurance that a corrupt base
 *  is discarded and rebuilt at OPEN, not discovered mid-query. */
export function verifyFileIntegritySync(path: string, expected: { bytes: number; crc32: number }): void {
  const fd = fsSync.openSync(path, 'r');
  try {
    const st = fsSync.fstatSync(fd);
    if (st.size !== expected.bytes) throw new GenerationCorruptError('file size does not match manifest record');
    let crc = 0;
    const buf = Buffer.allocUnsafe(1 << 16);
    let pos = 0;
    while (pos < st.size) {
      const n = fsSync.readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (n === 0) throw new GenerationCorruptError('file shrank during integrity check');
      crc = crc32(buf.subarray(0, n), crc);
      pos += n;
    }
    if ((crc >>> 0) !== expected.crc32) throw new GenerationCorruptError('file crc does not match manifest record');
  } finally {
    fsSync.closeSync(fd);
  }
}

/** The read/verify chunk size of verifyFileIntegrityAsync: one crc32 slice per
 *  chunk, then a yield — a large postings file verifies in bounded ~ms
 *  slices instead of one synchronous pass. */
const VERIFY_CHUNK_BYTES = 1 << 20;

/** Async sliced variant of verifyFileIntegritySync (the open-time main-thread
 *  path): bounded 1 MiB positioned reads, a crc32 slice and an event-loop
 *  yield per chunk, so verifying a large postings file never blocks the loop
 *  for the whole pass. Identical error semantics. */
export async function verifyFileIntegrityAsync(path: string, expected: { bytes: number; crc32: number }): Promise<void> {
  const fh = await fs.open(path, 'r');
  try {
    const st = await fh.stat();
    if (st.size !== expected.bytes) throw new GenerationCorruptError('file size does not match manifest record');
    let crc = 0;
    const buf = Buffer.allocUnsafe(Math.min(VERIFY_CHUNK_BYTES, Math.max(st.size, 1)));
    let pos = 0;
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (bytesRead === 0) throw new GenerationCorruptError('file shrank during integrity check');
      crc = crc32(buf.subarray(0, bytesRead), crc);
      pos += bytesRead;
      await yieldToLoop();
    }
    if ((crc >>> 0) !== expected.crc32) throw new GenerationCorruptError('file crc does not match manifest record');
  } finally {
    await fh.close().catch(() => {});
  }
}

// ---- store image ------------------------------------------------------------

const STORE_MAGIC = 'MDGS';
// v4: the dt header fields are u32 (column count, metaLen, column-name
// length) — the v3 u8/u16 widths threw a RangeError mid-build on extreme
// shapes (many/wide dt columns), and every later build would fail the same
// deterministic way. v3: binary dt (no JSON per record). v2: `{"dt":...}`
// meta JSON. Older files are rejected as a whole (unsupported version),
// never silently misread.
export const STORE_VERSION = 4;

/** One record of the store image: the exact data needed to rebuild a
 *  StoreRecord. `ref` is a memory ref (inline value bytes) or a disk ref into
 *  the generation's snapshot / the anchored WAL. `metaBytes` is the record's
 *  Store-side dt accounting value (byte length of the `{"dt":...}` meta JSON,
 *  0 for none) — precomputed at build time so the load never re-stringifies. */
export interface StoreImageRecord {
  kstr: string;
  ref: ValueRef;
  expireAt: number;
  dt: Record<string, number> | null;
  /** Read side: the record's Store-side dt accounting value (0 for none).
   *  Ignored on write (recomputed from `dt`). */
  metaBytes?: number;
}

const TAG_INLINE = 0;
const TAG_SNAPSHOT_LOC = 1;
const TAG_WAL_LOC = 2;

/** The Store's dt accounting value for one record (mirrors Store.metaBytes:
 *  byte length of the canonical `{"dt":...}` meta JSON, 0 for none). */
function dtMetaBytes(dt: Record<string, number> | null): number {
  return dt ? Buffer.byteLength(JSON.stringify({ dt }), 'utf8') : 0;
}

/** Stream the store image to `path`. `records` must yield live records in
 *  ascending canonical-key order (the load path bulk-builds the ordered index
 *  from file order). Returns the manifest file info + the record count. */
export async function writeStoreImage(
  path: string,
  records: Iterable<StoreImageRecord>,
): Promise<{ bytes: number; crc32: number; count: number }> {
  const w = await GenFileWriter.open(path, STORE_MAGIC, STORE_VERSION);
  let count = 0;
  try {
    for (const r of records) {
      await w.writeRecord((b) => {
        b.key(r.kstr);
        b.i64(r.expireAt);
        const cols = r.dt ? Object.entries(r.dt) : [];
        b.u32(dtMetaBytes(r.dt));
        b.u32(cols.length);
        for (const [name, ms] of cols) {
          const nb = Buffer.from(name, 'utf8');
          b.u32(nb.length);
          b.bytes(nb);
          b.f64(ms);
        }
        if (r.ref.kind === 'memory') {
          b.u8(TAG_INLINE);
          b.u32(r.ref.value.length);
          b.bytes(r.ref.value);
        } else {
          b.u8(r.ref.loc.file === 'snapshot' ? TAG_SNAPSHOT_LOC : TAG_WAL_LOC);
          b.u64(r.ref.loc.off);
          b.u32(r.ref.loc.len);
        }
      });
      count++;
    }
    const info = await w.finish();
    return { ...info, count };
  } catch (error) {
    await w.abort();
    throw error;
  }
}

/** Parse a store image payload, yielding records in file (sorted) order.
 *  Values are COPIED out of the shared file buffer (the store must own its
 *  memory refs) and metaBytes carries the exact Store accounting hint. */
export function* readStoreImage(r: ByteReader): Generator<StoreImageRecord> {
  while (!r.done) {
    const kstr = r.key();
    const expireAt = r.i64();
    const metaBytes = r.u32();
    const colCount = r.u32();
    let dt: Record<string, number> | null = null;
    if (colCount > 0) {
      dt = {};
      for (let i = 0; i < colCount; i++) {
        const nameLen = r.u32();
        const name = r.bytes(nameLen).toString('utf8');
        dt[name] = r.f64();
      }
    }
    const tag = r.u8();
    let ref: ValueRef;
    if (tag === TAG_INLINE) {
      const len = r.u32();
      ref = { kind: 'memory', value: Buffer.from(r.bytes(len)) };
    } else if (tag === TAG_SNAPSHOT_LOC || tag === TAG_WAL_LOC) {
      const off = r.u64();
      const len = r.u32();
      ref = { kind: 'disk', loc: { file: tag === TAG_SNAPSHOT_LOC ? 'snapshot' : 'wal', off, len } };
    } else {
      throw new GenerationCorruptError(`store image: unknown value tag ${tag}`);
    }
    yield { kstr, ref, expireAt, dt, metaBytes };
  }
}

// ---- dt index image ---------------------------------------------------------

const DT_MAGIC = 'MDGD';
const DT_VERSION = 1;

export interface DtImageColumn {
  name: string;
  /** (ms, key) pairs sorted ascending — the skiplist's natural order. */
  entries: { ms: number; key: string }[];
}

export async function writeDtIndexImage(path: string, cols: DtImageColumn[]): Promise<{ bytes: number; crc32: number }> {
  const w = await GenFileWriter.open(path, DT_MAGIC, DT_VERSION);
  try {
    await w.writeRecord((b) => b.u32(cols.length));
    for (const c of cols) {
      await w.writeRecord((b) => {
        b.text(c.name);
        b.u64(c.entries.length);
      });
      for (const e of c.entries) {
        await w.writeRecord((b) => {
          b.f64(e.ms);
          b.key(e.key);
        });
      }
    }
    return await w.finish();
  } catch (error) {
    await w.abort();
    throw error;
  }
}

export function readDtIndexImage(r: ByteReader): DtImageColumn[] {
  const colCount = r.u32();
  const cols: DtImageColumn[] = [];
  for (let i = 0; i < colCount; i++) {
    const name = r.text();
    const n = r.u64();
    const entries: DtImageColumn['entries'] = [];
    for (let j = 0; j < n; j++) entries.push({ ms: r.f64(), key: r.key() });
    cols.push({ name, entries });
  }
  if (!r.done) throw new GenerationCorruptError('dt index image: trailing bytes');
  return cols;
}

// ---- secondary index image --------------------------------------------------

const SECONDARY_MAGIC = 'MDSI';
const SECONDARY_VERSION = 1;

export interface SecondaryImageIndex {
  name: string;
  field: string;
  type: 'equality' | 'range';
  unique: boolean;
  sparse: boolean;
  /** Equality state: (scalarKey -> pks). Null for range indexes. */
  equality: { scalarKey: string; pks: string[] }[] | null;
  /** Range state: (value, pk) pairs sorted ascending. Null for equality. */
  range: { value: number; pk: string }[] | null;
}

export async function writeSecondaryIndexImage(
  path: string,
  indexes: SecondaryImageIndex[],
): Promise<{ bytes: number; crc32: number }> {
  const w = await GenFileWriter.open(path, SECONDARY_MAGIC, SECONDARY_VERSION);
  try {
    await w.writeRecord((b) => b.u32(indexes.length));
    for (const idx of indexes) {
      await w.writeRecord((b) => {
        b.text(idx.name);
        b.text(idx.field);
        b.u8(idx.type === 'range' ? 2 : 1);
        b.u8((idx.unique ? 1 : 0) | (idx.sparse ? 2 : 0));
      });
      if (idx.type === 'equality') {
        const values = idx.equality ?? [];
        await w.writeRecord((b) => b.u64(values.length));
        for (const v of values) {
          await w.writeRecord((b) => {
            b.text(v.scalarKey);
            b.u64(v.pks.length);
          });
          for (const pk of v.pks) await w.writeRecord((b) => b.key(pk));
        }
      } else {
        const entries = idx.range ?? [];
        await w.writeRecord((b) => b.u64(entries.length));
        for (const e of entries) {
          await w.writeRecord((b) => {
            b.f64(e.value);
            b.key(e.pk);
          });
        }
      }
    }
    return await w.finish();
  } catch (error) {
    await w.abort();
    throw error;
  }
}

export function readSecondaryIndexImage(r: ByteReader): SecondaryImageIndex[] {
  const count = r.u32();
  const out: SecondaryImageIndex[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.text();
    const field = r.text();
    const typeTag = r.u8();
    const flags = r.u8();
    const type = typeTag === 2 ? 'range' : typeTag === 1 ? 'equality' : null;
    if (type === null) throw new GenerationCorruptError(`secondary image: unknown index type ${typeTag}`);
    let equality: SecondaryImageIndex['equality'] = null;
    let range: SecondaryImageIndex['range'] = null;
    if (type === 'equality') {
      equality = [];
      const valueCount = r.u64();
      for (let v = 0; v < valueCount; v++) {
        const scalarKey = r.text();
        const pkCount = r.u64();
        const pks: string[] = [];
        for (let p = 0; p < pkCount; p++) pks.push(r.key());
        equality.push({ scalarKey, pks });
      }
    } else {
      range = [];
      const n = r.u64();
      for (let j = 0; j < n; j++) range.push({ value: r.f64(), pk: r.key() });
    }
    out.push({ name, field, type, unique: (flags & 1) !== 0, sparse: (flags & 2) !== 0, equality, range });
  }
  if (!r.done) throw new GenerationCorruptError('secondary index image: trailing bytes');
  return out;
}

/** Sliced variant of readSecondaryIndexImage (stage 6): identical result,
 *  with event-loop yields every `yieldEvery` parsed entries so a large image
 *  never parses in one synchronous run. */
export async function readSecondaryIndexImageAsync(r: ByteReader, yieldEvery = 32768): Promise<SecondaryImageIndex[]> {
  const count = r.u32();
  const out: SecondaryImageIndex[] = [];
  let n = 0;
  const tick = async (): Promise<void> => {
    if (++n % yieldEvery === 0) await yieldToLoop();
  };
  for (let i = 0; i < count; i++) {
    const name = r.text();
    const field = r.text();
    const typeTag = r.u8();
    const flags = r.u8();
    const type = typeTag === 2 ? 'range' : typeTag === 1 ? 'equality' : null;
    if (type === null) throw new GenerationCorruptError(`secondary image: unknown index type ${typeTag}`);
    let equality: SecondaryImageIndex['equality'] = null;
    let range: SecondaryImageIndex['range'] = null;
    if (type === 'equality') {
      equality = [];
      const valueCount = r.u64();
      for (let v = 0; v < valueCount; v++) {
        const scalarKey = r.text();
        const pkCount = r.u64();
        const pks: string[] = [];
        for (let p = 0; p < pkCount; p++) {
          pks.push(r.key());
          await tick();
        }
        equality.push({ scalarKey, pks });
      }
    } else {
      range = [];
      const m = r.u64();
      for (let j = 0; j < m; j++) {
        range.push({ value: r.f64(), pk: r.key() });
        await tick();
      }
    }
    out.push({ name, field, type, unique: (flags & 1) !== 0, sparse: (flags & 2) !== 0, equality, range });
  }
  if (!r.done) throw new GenerationCorruptError('secondary index image: trailing bytes');
  return out;
}

// ---- compound index image ---------------------------------------------------

const COMPOUND_MAGIC = 'MDCI';
const COMPOUND_VERSION = 1;

export type CompoundImageGroupValue = number | string | boolean | null;

export interface CompoundImageIndex {
  name: string;
  groupBy: string;
  orderBy: string;
  orderType: 'number' | 'string';
  groups: { group: CompoundImageGroupValue; entries: { order: number | string; pk: string }[] }[];
}

const GTAG_NUMBER = 1;
const GTAG_STRING = 2;
const GTAG_FALSE = 3;
const GTAG_TRUE = 4;
const GTAG_NULL = 5;

function writeGroupValue(b: ByteWriter, v: CompoundImageGroupValue): void {
  if (v === null) {
    b.u8(GTAG_NULL);
  } else if (typeof v === 'number') {
    b.u8(GTAG_NUMBER);
    b.f64(v);
  } else if (typeof v === 'string') {
    b.u8(GTAG_STRING);
    b.text(v);
  } else if (v === false) {
    b.u8(GTAG_FALSE);
  } else {
    b.u8(GTAG_TRUE);
  }
}

function readGroupValue(r: ByteReader): CompoundImageGroupValue {
  const tag = r.u8();
  if (tag === GTAG_NUMBER) return r.f64();
  if (tag === GTAG_STRING) return r.text();
  if (tag === GTAG_FALSE) return false;
  if (tag === GTAG_TRUE) return true;
  if (tag === GTAG_NULL) return null;
  throw new GenerationCorruptError(`compound image: unknown group tag ${tag}`);
}

export async function writeCompoundIndexImage(
  path: string,
  indexes: CompoundImageIndex[],
): Promise<{ bytes: number; crc32: number }> {
  const w = await GenFileWriter.open(path, COMPOUND_MAGIC, COMPOUND_VERSION);
  try {
    await w.writeRecord((b) => b.u32(indexes.length));
    for (const idx of indexes) {
      await w.writeRecord((b) => {
        b.text(idx.name);
        b.text(idx.groupBy);
        b.text(idx.orderBy);
        b.u8(idx.orderType === 'string' ? 2 : 1);
        b.u64(idx.groups.length);
      });
      for (const g of idx.groups) {
        await w.writeRecord((b) => {
          writeGroupValue(b, g.group);
          b.u64(g.entries.length);
        });
        for (const e of g.entries) {
          await w.writeRecord((b) => {
            if (idx.orderType === 'string') b.text(String(e.order));
            else b.f64(Number(e.order));
            b.key(e.pk);
          });
        }
      }
    }
    return await w.finish();
  } catch (error) {
    await w.abort();
    throw error;
  }
}

export function readCompoundIndexImage(r: ByteReader): CompoundImageIndex[] {
  const count = r.u32();
  const out: CompoundImageIndex[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.text();
    const groupBy = r.text();
    const orderBy = r.text();
    const ot = r.u8();
    const orderType = ot === 2 ? 'string' : ot === 1 ? 'number' : null;
    if (orderType === null) throw new GenerationCorruptError(`compound image: unknown order type ${ot}`);
    const groupCount = r.u64();
    const groups: CompoundImageIndex['groups'] = [];
    for (let g = 0; g < groupCount; g++) {
      const group = readGroupValue(r);
      const n = r.u64();
      const entries: { order: number | string; pk: string }[] = [];
      for (let j = 0; j < n; j++) {
        const order = orderType === 'string' ? r.text() : r.f64();
        entries.push({ order, pk: r.key() });
      }
      groups.push({ group, entries });
    }
    out.push({ name, groupBy, orderBy, orderType, groups });
  }
  if (!r.done) throw new GenerationCorruptError('compound index image: trailing bytes');
  return out;
}

/** Sliced variant of readCompoundIndexImage (stage 6): identical result, with
 *  event-loop yields every `yieldEvery` parsed entries. */
export async function readCompoundIndexImageAsync(r: ByteReader, yieldEvery = 32768): Promise<CompoundImageIndex[]> {
  const count = r.u32();
  const out: CompoundImageIndex[] = [];
  let n = 0;
  const tick = async (): Promise<void> => {
    if (++n % yieldEvery === 0) await yieldToLoop();
  };
  for (let i = 0; i < count; i++) {
    const name = r.text();
    const groupBy = r.text();
    const orderBy = r.text();
    const ot = r.u8();
    const orderType = ot === 2 ? 'string' : ot === 1 ? 'number' : null;
    if (orderType === null) throw new GenerationCorruptError(`compound image: unknown order type ${ot}`);
    const groupCount = r.u64();
    const groups: CompoundImageIndex['groups'] = [];
    for (let g = 0; g < groupCount; g++) {
      const group = readGroupValue(r);
      const m = r.u64();
      const entries: { order: number | string; pk: string }[] = [];
      for (let j = 0; j < m; j++) {
        const order = orderType === 'string' ? r.text() : r.f64();
        entries.push({ order, pk: r.key() });
        await tick();
      }
      groups.push({ group, entries });
    }
    out.push({ name, groupBy, orderBy, orderType, groups });
  }
  if (!r.done) throw new GenerationCorruptError('compound index image: trailing bytes');
  return out;
}

// ---- text index images ------------------------------------------------------

const TEXT_DICT_MAGIC = 'MDTD';
const TEXT_DICT_VERSION = 1;
const TEXT_DOCS_MAGIC = 'MDTC';
const TEXT_DOCS_VERSION = 1;

export interface TextDictImageEntry {
  term: string;
  off: number;
  len: number;
  df: number;
}

export async function writeTextDictionaryImage(
  path: string,
  entries: Iterable<TextDictImageEntry>,
): Promise<{ bytes: number; crc32: number }> {
  const w = await GenFileWriter.open(path, TEXT_DICT_MAGIC, TEXT_DICT_VERSION);
  try {
    for (const e of entries) {
      await w.writeRecord((b) => {
        b.term(e.term);
        b.u64(e.off);
        b.u32(e.len);
        b.u32(e.df);
      });
    }
    return await w.finish();
  } catch (error) {
    await w.abort();
    throw error;
  }
}

export function readTextDictionaryImage(r: ByteReader): TextDictImageEntry[] {
  const out: TextDictImageEntry[] = [];
  while (!r.done) out.push({ term: r.term(), off: r.u64(), len: r.u32(), df: r.u32() });
  return out;
}

/** Sliced variant (stage 6): identical result, with event-loop yields every
 *  `yieldEvery` entries so a million-term dictionary never parses in one
 *  synchronous run. */
export async function readTextDictionaryImageAsync(r: ByteReader, yieldEvery = 65536): Promise<TextDictImageEntry[]> {
  const out: TextDictImageEntry[] = [];
  let n = 0;
  while (!r.done) {
    out.push({ term: r.term(), off: r.u64(), len: r.u32(), df: r.u32() });
    if (++n % yieldEvery === 0) await new Promise((res) => setImmediate(res));
  }
  return out;
}

/** The per-doc table plus the write-buffer state of a text index: docID ->
 *  key (undefined = hole), docID -> token count, the live-doc count N, the
 *  tombstoned docIDs, and the in-memory delta (term -> (docID -> freq)).
 *  Serializing the delta + tombstones makes the loaded index EXACTLY equal to
 *  the live one at seal time — including writes that landed while the
 *  generation was being built. */
export interface TextDocsImage {
  keys: (string | undefined)[];
  docLens: (number | undefined)[];
  liveCount: number;
  removed: number[];
  delta: { term: string; docs: { docID: number; freq: number }[] }[];
}

export async function writeTextDocsImage(path: string, image: TextDocsImage): Promise<{ bytes: number; crc32: number }> {
  const w = await GenFileWriter.open(path, TEXT_DOCS_MAGIC, TEXT_DOCS_VERSION);
  try {
    await w.writeRecord((b) => {
      b.u64(image.keys.length);
      b.u64(image.liveCount);
      b.u64(image.removed.length);
      b.u64(image.delta.length);
    });
    for (let i = 0; i < image.keys.length; i++) {
      const k = image.keys[i];
      await w.writeRecord((b) => {
        if (k === undefined) {
          b.u8(0);
        } else {
          b.u8(1);
          b.key(k);
        }
        b.u32(image.docLens[i] ?? 0);
      });
    }
    for (const id of image.removed) await w.writeRecord((b) => b.u32(id));
    for (const d of image.delta) {
      await w.writeRecord((b) => {
        b.term(d.term);
        b.u64(d.docs.length);
      });
      for (const doc of d.docs) {
        await w.writeRecord((b) => {
          b.u32(doc.docID);
          b.u32(doc.freq);
        });
      }
    }
    return await w.finish();
  } catch (error) {
    await w.abort();
    throw error;
  }
}

export function readTextDocsImage(r: ByteReader): TextDocsImage {
  const docCount = r.u64();
  const liveCount = r.u64();
  const removedCount = r.u64();
  const deltaCount = r.u64();
  const keys: (string | undefined)[] = [];
  const docLens: (number | undefined)[] = [];
  for (let i = 0; i < docCount; i++) {
    const present = r.u8();
    if (present === 1) {
      keys.push(r.key());
      docLens.push(r.u32());
    } else if (present === 0) {
      keys.push(undefined);
      const len = r.u32();
      docLens.push(len === 0 ? undefined : len);
    } else {
      throw new GenerationCorruptError(`text docs image: unknown presence tag ${present}`);
    }
  }
  const removed: number[] = [];
  for (let i = 0; i < removedCount; i++) removed.push(r.u32());
  const delta: TextDocsImage['delta'] = [];
  for (let i = 0; i < deltaCount; i++) {
    const term = r.term();
    const n = r.u64();
    const docs: { docID: number; freq: number }[] = [];
    for (let j = 0; j < n; j++) docs.push({ docID: r.u32(), freq: r.u32() });
    delta.push({ term, docs });
  }
  if (!r.done) throw new GenerationCorruptError('text docs image: trailing bytes');
  return { keys, docLens, liveCount, removed, delta };
}

/** Sliced variant of readTextDocsImage (stage 6): identical result, with
 *  event-loop yields every `yieldEvery` parsed entries so a large doc table
 *  or delta never parses in one synchronous run. */
export async function readTextDocsImageAsync(r: ByteReader, yieldEvery = 32768): Promise<TextDocsImage> {
  const docCount = r.u64();
  const liveCount = r.u64();
  const removedCount = r.u64();
  const deltaCount = r.u64();
  let n = 0;
  const tick = async (): Promise<void> => {
    if (++n % yieldEvery === 0) await yieldToLoop();
  };
  const keys: (string | undefined)[] = [];
  const docLens: (number | undefined)[] = [];
  for (let i = 0; i < docCount; i++) {
    const present = r.u8();
    if (present === 1) {
      keys.push(r.key());
      docLens.push(r.u32());
    } else if (present === 0) {
      keys.push(undefined);
      const len = r.u32();
      docLens.push(len === 0 ? undefined : len);
    } else {
      throw new GenerationCorruptError(`text docs image: unknown presence tag ${present}`);
    }
    await tick();
  }
  const removed: number[] = [];
  for (let i = 0; i < removedCount; i++) {
    removed.push(r.u32());
    await tick();
  }
  const delta: TextDocsImage['delta'] = [];
  for (let i = 0; i < deltaCount; i++) {
    const term = r.term();
    const m = r.u64();
    const docs: { docID: number; freq: number }[] = [];
    for (let j = 0; j < m; j++) {
      docs.push({ docID: r.u32(), freq: r.u32() });
      await tick();
    }
    delta.push({ term, docs });
  }
  if (!r.done) throw new GenerationCorruptError('text docs image: trailing bytes');
  return { keys, docLens, liveCount, removed, delta };
}
