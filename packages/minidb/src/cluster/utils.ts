// src/cluster/utils.ts
//
// Hashing, shard directory naming, and shared small helpers.

export const CLUSTER_META_FILE = 'cluster.meta.json';
export const CLUSTER_INDEX_FILE = 'cluster.indexes.json';
const SHARD_DIR_PREFIX = 'shard-';

/** Zero-padded shard directory name, e.g. shard-03 for shardCount <= 100. The
 *  width grows with the shard count so directory listings stay sorted. */
export function shardDirName(shardId: number, shardCount: number): string {
  const width = Math.max(2, String(Math.max(shardCount - 1, 0)).length);
  return `${SHARD_DIR_PREFIX}${String(shardId).padStart(width, '0')}`;
}

/** MurmurHash3 x86 32-bit: stable, fast, and with a proper avalanche so the
 *  low bits (which is all `hash % shardCount` uses) stay uniform even for
 *  sequential or highly-similar keys. Zero dependencies. */
export function stableHash32(key: string, seed = 0): number {
  const data = Buffer.from(key, 'utf8');
  const len = data.length;
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  const roundedEnd = len & ~3;
  for (let i = 0; i < roundedEnd; i += 4) {
    let k1 = data.readUInt32LE(i);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }

  let k1 = 0;
  const tail = len & 3;
  if (tail === 3) k1 ^= data[roundedEnd + 2]! << 16;
  if (tail >= 2) k1 ^= data[roundedEnd + 1]! << 8;
  if (tail >= 1) {
    k1 ^= data[roundedEnd]!;
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  h1 ^= len;
  // fmix32 finalizer.
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

/** Route a key to its shard. Pure function of (key, shardCount), so every
 *  process agrees on placement without coordination. */
export function shardFor(key: string, shardCount: number): number {
  if (!(shardCount >= 1) || !Number.isInteger(shardCount)) {
    throw new RangeError(`shardCount must be a positive integer, got ${shardCount}`);
  }
  return stableHash32(key) % shardCount;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
