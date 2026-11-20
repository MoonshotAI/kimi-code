import { TestkitError } from '#/errors';

const encoder = new TextEncoder();

export interface ChunkingOptions {
  readonly seed: number;
  readonly maxBytes?: number;
}

export type Splitter = (data: string) => readonly Uint8Array[];

export function validateChunking(options: ChunkingOptions): void {
  const { seed, maxBytes } = options;
  if (!Number.isSafeInteger(seed)) throw new TestkitError(`chunking.seed must be an integer, got ${String(seed)}`);
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new TestkitError(`chunking.maxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
}

export function byteSplitter(options: ChunkingOptions, lane: string, laneIndex: number): Splitter {
  const maxBytes = options.maxBytes ?? 16;
  const next = mulberry32(seedFor(options.seed, `${lane}#${laneIndex}`));
  return (data) => {
    const bytes = encoder.encode(data);
    const pieces: Uint8Array[] = [];
    for (let start = 0; start < bytes.length;) {
      const size = 1 + Math.floor(next() * maxBytes);
      pieces.push(bytes.subarray(start, start + size));
      start += size;
    }
    return pieces;
  };
}

function seedFor(seed: number, key: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (const character of key) hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193) >>> 0;
  return hash;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
