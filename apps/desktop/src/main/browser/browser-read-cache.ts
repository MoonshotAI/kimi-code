import { randomUUID } from 'node:crypto';
import type { BrowserErrorCode } from '../../shared/browser-automation';

export class BrowserReadError extends Error {
  constructor(readonly code: BrowserErrorCode, message: string) { super(message); }
}

export class BrowserReadCache<T> {
  private readonly entries = new Map<string, { owner: string; createdAt: number; value: T; bytes: number }>();
  constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly ttlMs = 120_000) {}

  put(owner: string, value: T, bytes = Buffer.byteLength(JSON.stringify(value)), key: string = randomUUID()): string {
    this.prune();
    if (bytes > this.maxBytes) throw new BrowserReadError('OUTPUT_LIMIT', 'Snapshot exceeds the storage budget; narrow the scope.');
    this.entries.set(key, { owner, createdAt: Date.now(), value, bytes });
    while (this.entries.size > 32 || [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) > this.maxBytes) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    return key;
  }

  get(owner: string, key: string): T {
    this.prune();
    const entry = this.entries.get(key);
    if (entry?.owner !== owner) throw new BrowserReadError('SNAPSHOT_EXPIRED', 'Snapshot is unavailable for this tab; capture again.');
    return entry.value;
  }

  private prune(): void {
    for (const [key, entry] of this.entries) if (Date.now() - entry.createdAt >= this.ttlMs) this.entries.delete(key);
  }
}

export function readCursor(cursor: string): { key: string; offset: number } {
  const match = /^([a-f0-9-]{36}):(\d+)$/.exec(cursor);
  const offset = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(offset)) throw new BrowserReadError('SNAPSHOT_EXPIRED', 'Invalid snapshot cursor; capture again.');
  return { key: match[1]!, offset };
}
