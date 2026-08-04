// src/value-codec.ts
//
// Value codecs (buffer/string/json) and the small key/byte helpers shared
// across the database: canonical key byte-strings, range canonicalization,
// dt normalization, and the atomic sidecar-file write used by the index
// definition files.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fsyncDir } from './compaction.js';
import { SNAPSHOT_FILE, WAL_FILE } from './generation.js';
import type { RangeOptions } from './skiplist.js';
import type { ValueMode } from './recovery.js';
import type { ValueCodec, ValueCodecName, ValueModeSetting } from './types.js';

export const BUFFER: ValueCodec<Buffer> = {
  encode: (v) => {
    if (!Buffer.isBuffer(v)) throw new TypeError('value must be a Buffer (use valueCodec: "string" or "json")');
    return v;
  },
  // Return a copy so a caller mutating the result cannot corrupt the stored
  // value (the store keeps the same Buffer reference internally).
  decode: (b) => Buffer.from(b),
};
export const STRING: ValueCodec<string> = {
  encode: (v) => Buffer.from(String(v), 'utf8'),
  decode: (b) => b.toString('utf8'),
};
export const JSON_CODEC: ValueCodec<unknown> = {
  encode: (v) => Buffer.from(JSON.stringify(v), 'utf8'),
  decode: (b) => JSON.parse(b.toString('utf8')),
};
export const CODECS: Record<ValueCodecName, ValueCodec<unknown>> = { buffer: BUFFER, string: STRING, json: JSON_CODEC };
export const MAX_KEY_LEN = 128;

export function toBuf(key: string | Buffer): Buffer {
  return Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
}
// Canonical byte-string form of a key: each char's code unit equals one byte of
// the key's UTF-8 encoding. The store and every derived index key their maps by
// this string, so a string key and the Buffer of its UTF-8 bytes (which is what
// the WAL/snapshot store) map to the same entry. Without this, a multi-byte
// (non-ASCII) string key is stored under one name (UTF-8 bytes, via the Buffer
// path) but looked up under another (the raw UTF-16 string), so get/del/scan and
// every index miss it.
export function toKStr(key: string | Buffer): string {
  return typeof key === 'string' ? Buffer.from(key, 'utf8').toString('binary') : key.toString('binary');
}
// Inverse of toKStr: turn a canonical byte-string back into the original UTF-8
// string for keys returned to callers (scan / findEq / dtRange / ...).
export function fromKStr(k: string): string {
  return Buffer.from(k, 'binary').toString('utf8');
}
// Canonicalize the string bounds of a range scan so they compare correctly
// against the canonically-keyed ordered index.
export function canonRange(opts: RangeOptions<string>): RangeOptions<string> {
  const out: RangeOptions<string> = { ...opts };
  if (out.gte !== undefined) out.gte = toKStr(out.gte);
  if (out.gt !== undefined) out.gt = toKStr(out.gt);
  if (out.lte !== undefined) out.lte = toKStr(out.lte);
  if (out.lt !== undefined) out.lt = toKStr(out.lt);
  return out;
}

export function normDt(dt?: Record<string, number | string> | null): Record<string, number> | null {
  if (!dt) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(dt)) {
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isFinite(ms)) out[k] = ms;
  }
  return Object.keys(out).length ? out : null;
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

// Distinct tmp name per write (`tmp-${pid}-${seq}`, the lockfile sidecarSeq
// pattern): the per-sidecar mutation chains are the real serialization fix,
// unique tmps are defense in depth — no write can ever rename (or strand)
// another in-flight write's tmp, and a crashed predecessor's leftovers match
// the open-time isStaleTmpFile cleanup.
let sidecarTmpSeq = 0;

/** Write a small metadata file atomically (unique tmp + rename + strict
 *  directory fsync), so a crash cannot leave a torn definition file that
 *  would force openers into error/rebuild — and a successful return means
 *  the rename is crash-durable (the stage-9 strict fsyncDir mode; a platform
 *  without directory fsync degrades via fsyncDir itself). A strict fsync
 *  failure propagates even though the renamed bytes may already be visible:
 *  persist = crash-durable by definition, so the caller treats the mutation
 *  as failed and keeps its previous in-memory state (the same ambiguity rule
 *  as a WAL commit-point failure). */
export async function writeFileAtomic(
  file: string,
  data: string,
  opts: { stats?: { dirFsyncUnsupported?: boolean } } = {},
): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${++sidecarTmpSeq}`;
  try {
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, file);
  } finally {
    // A successful rename already moved the tmp away (this rm is a no-op); a
    // failed write/rename must not strand it.
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  await fsyncDir(path.dirname(file), { strict: true, stats: opts.stats });
}

export async function resolveValueMode(mode: ValueModeSetting, dir: string, maxMemoryBytes: number | null): Promise<ValueMode> {
  if (mode !== 'auto') return mode;
  if (maxMemoryBytes === null) return 'memory';
  const total = (await fileSize(path.join(dir, SNAPSHOT_FILE))) + (await fileSize(path.join(dir, WAL_FILE)));
  return total > maxMemoryBytes ? 'disk' : 'memory';
}
