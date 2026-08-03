// src/text-postings.ts
//
// On-disk postings storage for the full-text index (larger-than-RAM).
//
// Each term's postings list (sorted `(docID, freq)` pairs) is stored as one
// append-only record in a flat file. The in-memory term dictionary maps
// `term -> { off, len, df }` and points at these records, so the bulk of the
// index (every (doc, term) pair) lives on disk and is read on demand, while
// only the small dictionary stays in RAM.
//
// Record frame (little-endian), CRC-verified:
//   off        size  field
//    0          2   termLen   uint16
//    2          t   term      utf8
//    2+t        4   df        uint32 (document frequency at build time)
//    6+t        4   payloadLen uint32
//   10+t        p   payload   delta+varint encoded (docID, freq) pairs
//   10+t+p      4   crc32     over [termLen .. payload]
//
// Payload encoding: docIDs are sorted ascending and delta-encoded; both the
// deltas and the freqs are varint-coded (LEB128, unsigned). This is pure JS
// and gives ~5-10x compression for dense docID ranges.

import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';

const HEADER_LEN = 2 + 4 + 4; // termLen + df + payloadLen (term is variable)
const CRC_LEN = 4;

// ---- varint (unsigned LEB128, uint32) ------------------------------------

function encodeVarintInto(n: number, out: number[]): void {
  n >>>= 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
}

function decodeVarint(buf: Buffer, cur: { i: number }): number {
  let r = 0;
  let shift = 0;
  for (;;) {
    const b = buf[cur.i++];
    if (b === undefined) throw new Error('postings: truncated varint');
    r |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return r >>> 0;
    shift += 7;
    if (shift > 35) throw new Error('postings: varint too long');
  }
}

// ---- posting list codec ---------------------------------------------------

/** Encode a sorted (by docID asc) list of [docID, freq] pairs. */
export function encodePostingList(entries: readonly (readonly [number, number])[]): Buffer {
  const bytes: number[] = [];
  encodeVarintInto(entries.length, bytes);
  let prev = 0;
  for (const [docID, freq] of entries) {
    encodeVarintInto(docID - prev, bytes);
    encodeVarintInto(freq, bytes);
    prev = docID;
  }
  return Buffer.from(bytes);
}

/** Decode a payload back into [docID, freq] pairs (ascending docID). */
export function decodePostingList(buf: Buffer): [number, number][] {
  const cur = { i: 0 };
  const count = decodeVarint(buf, cur);
  const out = Array.from<[number, number]>({ length: count });
  let prev = 0;
  for (let k = 0; k < count; k++) {
    const d = decodeVarint(buf, cur);
    const freq = decodeVarint(buf, cur);
    prev += d;
    out[k] = [prev, freq];
  }
  return out;
}

// ---- record frame codec ---------------------------------------------------

export interface DecodedRecord {
  term: string;
  df: number;
  payload: Buffer;
}

/** Encode one term's record frame (with CRC trailer). */
export function encodeRecord(term: string, df: number, payload: Buffer): Buffer {
  const termBuf = Buffer.from(term, 'utf8');
  if (termBuf.length > 0xffff) throw new RangeError('postings: term too long');
  const bodyLen = HEADER_LEN + termBuf.length + payload.length;
  const body = Buffer.alloc(bodyLen);
  let o = 0;
  body.writeUInt16LE(termBuf.length, o);
  o += 2;
  termBuf.copy(body, o);
  o += termBuf.length;
  body.writeUInt32LE(df >>> 0, o);
  o += 4;
  body.writeUInt32LE(payload.length, o);
  o += 4;
  payload.copy(body, o);
  const crc = crc32(body);
  const out = Buffer.alloc(bodyLen + CRC_LEN);
  body.copy(out, 0);
  out.writeUInt32LE(crc >>> 0, bodyLen);
  return out;
}

/** Decode + CRC-verify a record frame. */
export function decodeRecord(buf: Buffer): DecodedRecord {
  if (buf.length < HEADER_LEN + CRC_LEN) throw new Error('postings: record too short');
  const stored = buf.readUInt32LE(buf.length - CRC_LEN);
  const calc = crc32(buf.subarray(0, buf.length - CRC_LEN));
  if (stored !== calc) throw new Error('postings: record crc mismatch');
  let o = 0;
  const termLen = buf.readUInt16LE(o);
  o += 2;
  if (o + termLen + 4 + 4 > buf.length - CRC_LEN) throw new Error('postings: record term length out of bounds');
  const term = buf.toString('utf8', o, o + termLen);
  o += termLen;
  const df = buf.readUInt32LE(o);
  o += 4;
  const payloadLen = buf.readUInt32LE(o);
  o += 4;
  if (o + payloadLen > buf.length - CRC_LEN) throw new Error('postings: record payload length out of bounds');
  const payload = buf.subarray(o, o + payloadLen);
  return { term, df, payload };
}

// ---- postings file --------------------------------------------------------

/** A pointer to one term's record in the postings file. */
export interface PostingEntry {
  off: number;
  len: number;
  df: number;
}

/**
 * Append-only postings file with synchronous positioned reads. Synchronous I/O
 * is deliberate: `TextIndex.search()` is synchronous (so `db.search()` /
 * `db.query()` keep their sync API), and hot records are served from the OS
 * page cache or the in-memory LRU cache anyway.
 */
export class PostingsFile {
  private fd: number | null = null;

  private constructor(readonly path: string) {}

  /**
   * Open an existing postings file for positioned reads. Throws if the file is
   * missing — callers treat a missing file as an empty index. Read-only: the
   * file is only ever rewritten wholesale by {@link rebuildSync}, so the fd
   * stays valid until the next rebuild (which the caller must close + reopen).
   */
  static open(filePath: string): PostingsFile {
    const pf = new PostingsFile(filePath);
    pf.fd = fs.openSync(filePath, 'r');
    return pf;
  }

  get open(): boolean {
    return this.fd !== null;
  }

  /** Read + decode one term's postings record by dictionary pointer. */
  read(entry: PostingEntry): [number, number][] {
    if (this.fd === null) throw new Error('postings file is closed');
    const buf = Buffer.alloc(entry.len);
    let got = 0;
    while (got < entry.len) {
      const r = fs.readSync(this.fd, buf, got, entry.len - got, entry.off + got);
      if (r === 0) throw new Error('postings: short read past EOF');
      got += r;
    }
    const rec = decodeRecord(buf);
    return decodePostingList(rec.payload);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Build a fresh postings file from an iterator of `{ term, entries }`
   * (entries must be sorted by docID asc). Writes to `<path>.tmp`, fsyncs, and
   * atomically renames over `<path>`. Returns the new term dictionary. The old
   * file (if any) is replaced only after the new one is fully durable, so a
   * crash mid-build leaves the previous file intact.
   */
  static rebuildSync(
    filePath: string,
    iter: Iterable<{ term: string; entries: readonly (readonly [number, number])[] }>,
  ): Map<string, PostingEntry> {
    const tmp = filePath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    const dict = new Map<string, PostingEntry>();
    let off = 0;
    try {
      for (const { term, entries } of iter) {
        if (entries.length === 0) continue;
        const payload = encodePostingList(entries);
        const rec = encodeRecord(term, entries.length, payload);
        let written = 0;
        while (written < rec.length) {
          const w = fs.writeSync(fd, rec, written, rec.length - written, off + written);
          if (w === 0) throw new Error('postings: rebuild write made no progress');
          written += w;
        }
        dict.set(term, { off, len: rec.length, df: entries.length });
        off += rec.length;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    // Best-effort directory fsync so the rename survives a crash.
    try {
      const dfd = fs.openSync(path.dirname(filePath), 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* some platforms disallow fsync on a directory */
    }
    return dict;
  }
}
