import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { AgentRecord } from './types';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const BLOBREF_PROTOCOL = 'blobref:';
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

export interface BlobStoreOptions {
  readonly blobsDir: string;
  readonly threshold?: number;
  readonly maxCacheSize?: number;
}

export class BlobStore {
  private readonly blobsDir: string;
  private readonly threshold: number;
  private readonly maxCacheSize: number;
  private readonly cache = new Map<string, Buffer>();
  private readonly cacheSizes = new Map<string, number>();
  private currentCacheSize = 0;

  constructor(options: BlobStoreOptions) {
    this.blobsDir = options.blobsDir;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  async offload(record: AgentRecord): Promise<AgentRecord> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer': {
        const input = await this.offloadParts(record.input);
        return input === record.input ? record : { ...record, input };
      }
      case 'context.append_message': {
        const content = await this.offloadParts(record.message.content);
        return content === record.message.content
          ? record
          : { ...record, message: { ...record.message, content } };
      }
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type !== 'tool.result' || typeof event.result.output === 'string') {
          return record;
        }
        const output = await this.offloadParts(event.result.output);
        if (output === event.result.output) return record;
        return {
          ...record,
          event: {
            ...event,
            result: { ...event.result, output },
          },
        };
      }
      default:
        return record;
    }
  }

  private async offloadParts(parts: readonly ContentPart[]): Promise<ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.offloadContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : (parts as ContentPart[]);
  }

  async rehydrate(record: AgentRecord): Promise<void> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        await this.rehydrateParts(record.input);
        break;
      case 'context.append_message':
        await this.rehydrateParts(record.message.content);
        break;
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type === 'tool.result' && typeof event.result.output !== 'string') {
          await this.rehydrateParts(event.result.output);
        }
        break;
      }
      default:
        break;
    }
  }

  async rehydrateParts(parts: readonly ContentPart[]): Promise<void> {
    for (const part of parts) {
      await this.rehydrateContentPart(part);
    }
  }

  private async offloadContentPart(part: ContentPart): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string') continue;

      const newUrl = await this.maybeOffloadString(url);
      if (newUrl === url) continue;

      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  private async rehydrateContentPart(part: ContentPart): Promise<void> {
    const record = part as unknown as Record<string, unknown>;
    for (const value of Object.values(record)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string' || !isBlobRef(url)) continue;

      const newUrl = await this.rehydrateBlobRefUrl(url);
      mediaObj.url = newUrl ?? MISSING_MEDIA_PLACEHOLDER;
    }
  }

  private async rehydrateBlobRefUrl(url: string): Promise<string | undefined> {
    const rest = url.slice(BLOBREF_PROTOCOL.length);
    const semiIdx = rest.indexOf(';');
    if (semiIdx === -1) {
      return undefined;
    }
    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    if (hash.length === 0) {
      return undefined;
    }
    const payload = await this.readBlob(hash);
    if (payload === undefined) {
      return undefined;
    }
    return `data:${mimeType};base64,${payload.toString('base64')}`;
  }

  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      // Move the entry to the end so it lives longer than less-recently-used items.
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    const payload = await readFile(join(this.blobsDir, hash)).catch(() => undefined);
    if (payload !== undefined) {
      this.setCache(hash, payload);
    }
    return payload;
  }

  private async maybeOffloadString(value: string): Promise<string> {
    if (value.startsWith(BLOBREF_PROTOCOL)) {
      return value;
    }
    const match = DATA_URI_HEADER_RE.exec(value);
    if (match === null) {
      return value;
    }
    const mimeType = match[1]!;
    const payload = value.slice(match[0].length);
    if (payload.length < this.threshold) {
      return value;
    }
    return this.writeBlob(mimeType, payload);
  }

  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    await mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
    const blobPath = join(this.blobsDir, hash);
    const binary = Buffer.from(base64Payload, 'base64');
    try {
      const fh = await open(blobPath, 'wx');
      try {
        await fh.writeFile(binary);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EEXIST means the identical payload was already written; deduplication.
      if (code !== 'EEXIST') throw error;
    }
    this.setCache(hash, binary);
    return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
  }

  private setCache(hash: string, payload: Buffer): void {
    const size = payload.byteLength;
    const alreadyCached = this.cache.has(hash);
    if (alreadyCached) {
      const oldSize = this.cacheSizes.get(hash) ?? 0;
      this.currentCacheSize += size - oldSize;
      // Re-insert to update LRU position.
      this.cache.delete(hash);
    } else {
      if (size > this.maxCacheSize) {
        // Skip caching a single blob that exceeds the entire cap.
        return;
      }
      while (this.currentCacheSize + size > this.maxCacheSize && this.cache.size > 0) {
        this.evictLRU();
      }
      this.currentCacheSize += size;
    }
    this.cache.set(hash, payload);
    this.cacheSizes.set(hash, size);
  }

  private evictLRU(): void {
    const lru = this.cache.keys().next().value;
    if (lru === undefined) return;
    const size = this.cacheSizes.get(lru) ?? 0;
    this.currentCacheSize -= size;
    this.cache.delete(lru);
    this.cacheSizes.delete(lru);
  }
}

function asMediaContainer(value: unknown): { url: unknown } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return 'url' in obj ? (obj as { url: unknown }) : undefined;
}
