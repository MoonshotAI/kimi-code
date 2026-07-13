// src/codec.ts
//
// Binary record format shared by the WAL and the snapshot.
//
// Frame (little-endian):
//
//   off        size  field
//    0          2   magic     = 0x4D 0x44 ("MD")  — sync marker
//    2          1   type      — 1 = SET, 2 = DEL (tombstone), 3 = BATCH
//    3          1   flags     — reserved (0)
//    4          2   keyLen    — uint16, key length in bytes (max 64 KiB)
//    6          4   valLen    — uint32, value length in bytes (0 for DEL)
//   10          4   metaLen   — uint32, optional metadata length in bytes (0 if none)
//   14          8   expireAt  — int64, ms since epoch; 0 = no expiry
//   22        keyLen  key
//  22+k       valLen  value
//  22+k+v     metaLen  meta     — optional metadata blob (used for dt columns, etc.)
//  22+k+v+m      4   crc32    — CRC-32 TRAILER over [type .. meta]
//
// The fixed-size header (22 bytes) lets a reader compute the full frame length
// (22 + keyLen + valLen + metaLen + 4) before reading the payload.

import fs from 'node:fs';
import { crc32 } from './crc32.js';

export const MAGIC = Buffer.from([0x4d, 0x44]); // "MD"
export const TYPE_SET = 1;
export const TYPE_DEL = 2;
export const TYPE_BATCH = 3;
export const HEADER_SIZE = 22; // bytes before the payload (key)
export const CRC_SIZE = 4;
export const MAX_KEY_LEN = 0xffff; // uint16
export const MAX_VAL_LEN = 0xffffffff; // uint32

/** A decoded record frame. */
export interface Frame {
  type: number;
  key: Buffer;
  value: Buffer;
  meta: Buffer | null;
  expireAt: number;
}

export interface EncodeFrameInput {
  type: number;
  key: Buffer;
  value?: Buffer | null;
  meta?: Buffer | null;
  expireAt?: number | bigint;
}

/** A single op inside a BATCH frame body. */
export interface BatchOp {
  type: number;
  key: Buffer;
  value: Buffer | null;
  meta: Buffer | null;
  expireAt: number;
}

export interface ParseResult {
  frames: Frame[];
  corruptRanges: [number, number][];
  eofOffset: number;
}

/** A frame scanned for recovery in valueMode:'disk'. The value is reported as an
 *  absolute file offset/length instead of being copied into memory. */
export interface FrameRef {
  type: number;
  key: Buffer;
  meta: Buffer | null;
  expireAt: number;
  frameOff: number;
  valueOff: number;
  valLen: number;
  frameLen: number;
}

export interface ScanFrameRefsResult {
  frames: FrameRef[];
  corruptRanges: [number, number][];
  eofOffset: number;
}

/** A BATCH sub-op scanned for recovery in valueMode:'disk'. */
export interface BatchOpRef {
  type: number;
  key: Buffer;
  meta: Buffer | null;
  expireAt: number;
  valueOff: number;
  valLen: number;
}

export class CorruptFrameError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'CorruptFrameError';
    this.offset = offset; // absolute byte offset in the stream where the bad frame starts
  }
}

const EMPTY: Buffer = Buffer.alloc(0);

/**
 * Encode one record into a single Buffer.
 */
export function encodeFrame({
  type,
  key,
  value = null,
  meta = null,
  expireAt = 0,
}: EncodeFrameInput): Buffer {
  if (!Buffer.isBuffer(key)) throw new TypeError('key must be a Buffer');
  if (key.length > MAX_KEY_LEN) throw new RangeError('key too large');
  const val: Buffer = value ?? EMPTY;
  const met: Buffer = meta ?? EMPTY;
  if (type === TYPE_SET && !Buffer.isBuffer(val)) throw new TypeError('value must be a Buffer for SET');
  if (!Buffer.isBuffer(met)) throw new TypeError('meta must be a Buffer');
  if (val.length > MAX_VAL_LEN) throw new RangeError('value too large');
  if (met.length > MAX_VAL_LEN) throw new RangeError('meta too large');

  const frame = Buffer.allocUnsafe(HEADER_SIZE + key.length + val.length + met.length + CRC_SIZE);

  let o = 0;
  MAGIC.copy(frame, o); o += 2;
  frame.writeUInt8(type, o); o += 1;
  frame.writeUInt8(0, o); o += 1; // flags
  frame.writeUInt16LE(key.length, o); o += 2;
  frame.writeUInt32LE(val.length, o); o += 4;
  frame.writeUInt32LE(met.length, o); o += 4;
  frame.writeBigInt64LE(BigInt(expireAt ?? 0), o); o += 8;
  key.copy(frame, o); o += key.length;
  val.copy(frame, o); o += val.length;
  met.copy(frame, o); o += met.length;

  // CRC trailer over everything after magic, before the crc field.
  const c = crc32(frame.subarray(2, o));
  frame.writeUInt32LE(c, o);
  return frame;
}

/**
 * Encode a list of ops into a batch body (used as the `value` of a TYPE_BATCH
 * frame). The whole body is protected by the outer frame's CRC, so a batch is
 * one atomic unit: it either applies fully or is skipped entirely on recovery.
 *
 * Body layout:
 *   count(2) | [ op(1) | keyLen(2) | valLen(4) | metaLen(4) | expireAt(8) |
 *               key | value | meta ] ...
 */
const SUB_HEADER = 1 + 2 + 4 + 4 + 8;

export function encodeBatchOps(ops: BatchOp[]): Buffer {
  let total = 2;
  for (const op of ops) {
    total += SUB_HEADER + op.key.length + (op.value ? op.value.length : 0) + (op.meta ? op.meta.length : 0);
  }
  const body = Buffer.allocUnsafe(total);
  let o = 0;
  body.writeUInt16LE(ops.length, o); o += 2;
  for (const op of ops) {
    const key = op.key;
    const val: Buffer = op.value ?? EMPTY;
    const met: Buffer = op.meta ?? EMPTY;
    body.writeUInt8(op.type, o); o += 1;
    body.writeUInt16LE(key.length, o); o += 2;
    body.writeUInt32LE(val.length, o); o += 4;
    body.writeUInt32LE(met.length, o); o += 4;
    body.writeBigInt64LE(BigInt(op.expireAt ?? 0), o); o += 8;
    key.copy(body, o); o += key.length;
    val.copy(body, o); o += val.length;
    met.copy(body, o); o += met.length;
  }
  return body;
}

export function decodeBatchOps(body: Buffer): BatchOp[] {
  const ops: BatchOp[] = [];
  let o = 0;
  if (body.length < 2) return ops;
  const count = body.readUInt16LE(o); o += 2;
  for (let i = 0; i < count; i++) {
    if (o + SUB_HEADER > body.length) throw new RangeError('batch op header truncated');
    const type = body.readUInt8(o); o += 1;
    const keyLen = body.readUInt16LE(o); o += 2;
    const valLen = body.readUInt32LE(o); o += 4;
    const metaLen = body.readUInt32LE(o); o += 4;
    const expireAt = Number(body.readBigInt64LE(o)); o += 8;
    if (o + keyLen + valLen + metaLen > body.length) throw new RangeError('batch op payload truncated');
    const key = Buffer.from(body.subarray(o, o + keyLen)); o += keyLen;
    const value = Buffer.from(body.subarray(o, o + valLen)); o += valLen;
    const meta = metaLen ? Buffer.from(body.subarray(o, o + metaLen)) : null; o += metaLen;
    ops.push({ type, key, value, meta, expireAt });
  }
  return ops;
}

/**
 * Streaming frame parser. Feed it arbitrary chunks (e.g. from a file read
 * stream); it yields whole frames and buffers partial trailing bytes for the
 * next feed(). Tracks absolute stream offset so a corrupt frame can be located
 * and the file truncated there.
 */
export class FrameParser {
  private pending: Buffer = EMPTY;
  private offset = 0; // absolute offset of the next byte to be consumed

  *feed(chunk: Buffer): Generator<Frame> {
    let buf: Buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let pos = 0;

    while (true) {
      if (buf.length - pos < HEADER_SIZE) break;

      if (buf[pos] !== MAGIC[0] || buf[pos + 1] !== MAGIC[1]) {
        const next = buf.indexOf(MAGIC, pos + 1);
        if (next === -1) throw new CorruptFrameError('magic not found', this.offset + pos);
        pos = next;
        continue;
      }

      const type = buf.readUInt8(pos + 2);
      const keyLen = buf.readUInt16LE(pos + 4);
      const valLen = buf.readUInt32LE(pos + 6);
      const metaLen = buf.readUInt32LE(pos + 10);
      const frameLen = HEADER_SIZE + keyLen + valLen + metaLen + CRC_SIZE;

      if (buf.length - pos < frameLen) break; // incomplete payload/crc, wait for more

      const storedCrc = buf.readUInt32LE(pos + frameLen - CRC_SIZE);
      const computedCrc = crc32(buf.subarray(pos + 2, pos + frameLen - CRC_SIZE));
      if (storedCrc !== computedCrc) {
        throw new CorruptFrameError(`crc mismatch at offset ${this.offset + pos}`, this.offset + pos);
      }

      const expireAt = Number(buf.readBigInt64LE(pos + 14));
      const keyStart = pos + HEADER_SIZE;
      const key = buf.subarray(keyStart, keyStart + keyLen);
      const value = buf.subarray(keyStart + keyLen, keyStart + keyLen + valLen);
      const metaStart = keyStart + keyLen + valLen;
      const meta = metaLen ? buf.subarray(metaStart, metaStart + metaLen) : null;

      yield {
        type,
        key: Buffer.from(key),
        value: Buffer.from(value),
        meta: meta ? Buffer.from(meta) : null,
        expireAt,
      };

      pos += frameLen;
      this.offset += frameLen;
    }

    this.pending = pos < buf.length ? Buffer.from(buf.subarray(pos)) : EMPTY;
  }

  /**
   * Signal end-of-stream. If any bytes are still buffered (a partial frame),
   * they are a torn tail left by a crash: throw CorruptFrameError at the offset
   * where valid data ends, so recovery can truncate the file there. Returns the
   * clean EOF offset (total valid bytes) when there is no leftover.
   */
  finish(): number {
    if (this.pending.length > 0) {
      const off = this.offset;
      const n = this.pending.length;
      this.pending = EMPTY;
      throw new CorruptFrameError(`torn tail: ${n} trailing byte(s)`, off);
    }
    return this.offset;
  }
}

/**
 * Try to read and validate one frame at `pos`.
 * @returns the parsed frame + its byte length, or null when there is no valid,
 *   complete frame at `pos` (no magic, incomplete, insane length, or CRC mismatch).
 */
function readFrameAt(buf: Buffer, pos: number): { frame: Frame; frameLen: number } | null {
  if (buf.length - pos < HEADER_SIZE) return null;
  if (buf[pos] !== MAGIC[0] || buf[pos + 1] !== MAGIC[1]) return null;
  const keyLen = buf.readUInt16LE(pos + 4);
  const valLen = buf.readUInt32LE(pos + 6);
  const metaLen = buf.readUInt32LE(pos + 10);
  if (keyLen > MAX_KEY_LEN) return null;
  const frameLen = HEADER_SIZE + keyLen + valLen + metaLen + CRC_SIZE;
  if (frameLen < HEADER_SIZE + CRC_SIZE) return null; // length overflow
  if (buf.length - pos < frameLen) return null; // incomplete
  const stored = buf.readUInt32LE(pos + frameLen - CRC_SIZE);
  const computed = crc32(buf.subarray(pos + 2, pos + frameLen - CRC_SIZE));
  if (stored !== computed) return null; // bad crc

  const expireAt = Number(buf.readBigInt64LE(pos + 14));
  const keyStart = pos + HEADER_SIZE;
  const key = buf.subarray(keyStart, keyStart + keyLen);
  const value = buf.subarray(keyStart + keyLen, keyStart + keyLen + valLen);
  const metaStart = keyStart + keyLen + valLen;
  const meta = metaLen ? buf.subarray(metaStart, metaStart + metaLen) : null;
  return {
    frame: {
      type: buf.readUInt8(pos + 2),
      key: Buffer.from(key),
      value: Buffer.from(value),
      meta: meta ? Buffer.from(meta) : null,
      expireAt,
    },
    frameLen,
  };
}

const CRC_CHUNK = 1 << 20;
const MAGIC_SCAN_CHUNK = 1 << 20;

function readExactSync(fd: number, buf: Buffer, pos: number): void {
  let got = 0;
  while (got < buf.length) {
    const r = fs.readSync(fd, buf, got, buf.length - got, pos + got);
    if (r === 0) throw new Error('codec: short read past EOF');
    got += r;
  }
}

function readFrameRefAt(fd: number, pos: number, size: number): FrameRef | null {
  if (size - pos < HEADER_SIZE) return null;
  const header = Buffer.allocUnsafe(HEADER_SIZE);
  readExactSync(fd, header, pos);
  if (header[0] !== MAGIC[0] || header[1] !== MAGIC[1]) return null;

  const type = header.readUInt8(2);
  const keyLen = header.readUInt16LE(4);
  const valLen = header.readUInt32LE(6);
  const metaLen = header.readUInt32LE(10);
  if (keyLen > MAX_KEY_LEN) return null;
  const frameLen = HEADER_SIZE + keyLen + valLen + metaLen + CRC_SIZE;
  if (frameLen < HEADER_SIZE + CRC_SIZE) return null; // length overflow
  if (size - pos < frameLen) return null; // incomplete

  let crc = 0;
  let crcPos = pos + 2;
  let crcLeft = frameLen - CRC_SIZE - 2;
  while (crcLeft > 0) {
    const len = Math.min(CRC_CHUNK, crcLeft);
    const buf = Buffer.allocUnsafe(len);
    readExactSync(fd, buf, crcPos);
    crc = crc32(buf, crc);
    crcPos += len;
    crcLeft -= len;
  }
  const storedCrcBuf = Buffer.allocUnsafe(CRC_SIZE);
  readExactSync(fd, storedCrcBuf, pos + frameLen - CRC_SIZE);
  if (storedCrcBuf.readUInt32LE(0) !== crc) return null;

  const keyStart = pos + HEADER_SIZE;
  const valueOff = keyStart + keyLen;
  const metaStart = valueOff + valLen;
  const key = Buffer.allocUnsafe(keyLen);
  if (keyLen) readExactSync(fd, key, keyStart);
  let meta: Buffer | null = null;
  if (metaLen) {
    meta = Buffer.allocUnsafe(metaLen);
    readExactSync(fd, meta, metaStart);
  }

  return {
    type,
    key,
    meta,
    expireAt: Number(header.readBigInt64LE(14)),
    frameOff: pos,
    valueOff,
    valLen,
    frameLen,
  };
}

function findMagicSync(fd: number, start: number, size: number): number {
  const buf = Buffer.allocUnsafe(MAGIC_SCAN_CHUNK);
  let pos = start;
  while (pos < size) {
    const len = Math.min(MAGIC_SCAN_CHUNK, size - pos);
    const n = fs.readSync(fd, buf, 0, len, pos);
    if (n === 0) return -1;
    const idx = buf.subarray(0, n).indexOf(MAGIC);
    if (idx >= 0) return pos + idx;
    if (n < MAGIC.length) break;
    pos += n - (MAGIC.length - 1);
  }
  return -1;
}

/** Scan an open snapshot/WAL fd into frame refs without copying values. */
export function scanFrameRefsFd(
  fd: number,
  { onCorrupt = 'resync' }: { onCorrupt?: 'resync' | 'strict' } = {},
): ScanFrameRefsResult {
  const size = fs.fstatSync(fd).size;
  const frames: FrameRef[] = [];
  const corruptRanges: [number, number][] = [];
  let pos = 0;

  while (pos < size) {
    const r = readFrameRefAt(fd, pos, size);
    if (r) {
      frames.push(r);
      pos += r.frameLen;
      continue;
    }

    if (onCorrupt === 'strict') {
      corruptRanges.push([pos, size]);
      break;
    }

    const badStart = pos;
    let resume = -1;
    let scan = pos + 1;
    while (scan < size - 1) {
      scan = findMagicSync(fd, scan, size);
      if (scan === -1) break;
      if (readFrameRefAt(fd, scan, size)) {
        resume = scan;
        break;
      }
      scan++;
    }
    corruptRanges.push([badStart, resume === -1 ? size : resume]);
    if (resume === -1) break;
    pos = resume;
  }

  return { frames, corruptRanges, eofOffset: pos };
}

/** Scan a snapshot/WAL file into frame refs without copying values. */
export function scanFrameRefsFile(
  filePath: string,
  opts: { onCorrupt?: 'resync' | 'strict' } = {},
): ScanFrameRefsResult {
  const fd = fs.openSync(filePath, 'r');
  try {
    return scanFrameRefsFd(fd, opts);
  } finally {
    fs.closeSync(fd);
  }
}

/** Scan BATCH body op refs without copying op values. `bodyOff` is the absolute
 *  file offset where the BATCH body (the outer frame's value) starts. */
export function scanBatchOpRefs(body: Buffer, bodyOff: number): BatchOpRef[] {
  const ops: BatchOpRef[] = [];
  let o = 0;
  if (body.length < 2) return ops;
  const count = body.readUInt16LE(o);
  o += 2;
  for (let i = 0; i < count; i++) {
    if (o + SUB_HEADER > body.length) throw new RangeError('batch op header truncated');
    const type = body.readUInt8(o);
    o += 1;
    const keyLen = body.readUInt16LE(o);
    o += 2;
    const valLen = body.readUInt32LE(o);
    o += 4;
    const metaLen = body.readUInt32LE(o);
    o += 4;
    const expireAt = Number(body.readBigInt64LE(o));
    o += 8;
    if (o + keyLen + valLen + metaLen > body.length) throw new RangeError('batch op payload truncated');
    const key = Buffer.from(body.subarray(o, o + keyLen));
    const valueOff = bodyOff + o + keyLen;
    o += keyLen + valLen;
    const meta = metaLen ? Buffer.from(body.subarray(o, o + metaLen)) : null;
    o += metaLen;
    ops.push({ type, key, valueOff, valLen, meta, expireAt });
  }
  return ops;
}

/**
 * Parse a complete buffer into frames, with configurable corruption handling.
 *
 *  - onCorrupt = 'resync' (default): a bad/incomplete frame is skipped and the
 *    parser resynchronizes to the next valid frame. Only the corrupted bytes are
 *    lost; everything after the next valid frame is recovered.
 *  - onCorrupt = 'strict': stop at the first bad frame and treat the entire tail
 *    as lost. Frames before the first bad frame are kept.
 */
export function parseBuffer(
  buf: Buffer,
  { onCorrupt = 'resync' }: { onCorrupt?: 'resync' | 'strict' } = {},
): ParseResult {
  const frames: Frame[] = [];
  const corruptRanges: [number, number][] = [];
  let pos = 0;

  while (pos < buf.length) {
    const r = readFrameAt(buf, pos);
    if (r) {
      frames.push(r.frame);
      pos += r.frameLen;
      continue;
    }

    if (onCorrupt === 'strict') {
      corruptRanges.push([pos, buf.length]);
      break;
    }

    // Resync: scan forward for the next frame that validates.
    const badStart = pos;
    let resume = -1;
    let scan = pos + 1;
    while (scan < buf.length - 1) {
      scan = buf.indexOf(MAGIC, scan);
      if (scan === -1) break;
      if (readFrameAt(buf, scan)) {
        resume = scan;
        break;
      }
      scan++;
    }
    corruptRanges.push([badStart, resume === -1 ? buf.length : resume]);
    if (resume === -1) break;
    pos = resume;
  }

  return { frames, corruptRanges, eofOffset: pos };
}
