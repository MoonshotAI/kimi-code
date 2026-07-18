// src/crc32.ts
//
// Table-based CRC-32 (IEEE 802.3, polynomial 0xEDB88320, reflected).
// This matches the algorithm used by Node's zlib, PNG, gzip, etc.
//
// Used by the WAL and snapshot frames to detect torn/corrupted records on
// recovery. Pure JS, no native deps. The 256-entry table is built lazily once
// and reused, so hot-path calls are just a handful of XOR/shifts per byte.

const POLY = 0xedb88320;
let TABLE: Uint32Array | null = null;

function buildTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
}

/**
 * Compute / continue a CRC-32 over `buf`.
 *
 * @param buf  bytes to checksum
 * @param prev previous crc value (for streaming / incremental use)
 * @returns unsigned 32-bit crc
 */
export function crc32(buf: Buffer | Uint8Array, prev = 0): number {
  if (TABLE === null) TABLE = buildTable();
  let c = prev ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Exposed for tests only.
export const _private = {
  buildTable,
  get table(): Uint32Array | null {
    return TABLE;
  },
};
