import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { ContentPart } from '@moonshot-ai/kosong';

import { registerSingleton, SyncDescriptor } from '../../../di';
import {
  BLOBREF_PROTOCOL,
  IBlobStoreService,
  MISSING_MEDIA_PLACEHOLDER,
  type BlobStoreServiceOptions,
} from './blobStore';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;

export class BlobStoreService implements IBlobStoreService {
  private readonly blobsDir: string | undefined;
  private readonly threshold: number;
  private readonly maxCacheSize: number;
  private readonly cache = new Map<string, Buffer>();
  private readonly cacheSizes = new Map<string, number>();
  private currentCacheSize = 0;

  constructor(options: BlobStoreServiceOptions = {}) {
    this.blobsDir = options.blobsDir;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  isBlobRef(url: string): boolean {
    return url.startsWith(BLOBREF_PROTOCOL);
  }

  async offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    if (this.blobsDir === undefined) return parts;

    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.offloadContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
  }

  async rehydrateParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    if (this.blobsDir === undefined) return parts;

    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.rehydrateContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
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

  private async rehydrateContentPart(part: ContentPart): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string' || !this.isBlobRef(url)) continue;

      const newUrl = await this.rehydrateBlobRefUrl(url);
      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl ?? MISSING_MEDIA_PLACEHOLDER };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  private async rehydrateBlobRefUrl(url: string): Promise<string | undefined> {
    const rest = url.slice(BLOBREF_PROTOCOL.length);
    const semiIdx = rest.indexOf(';');
    if (semiIdx === -1) return undefined;

    const mimeType = rest.slice(0, semiIdx);
    const hash = rest.slice(semiIdx + 1);
    if (hash.length === 0) return undefined;

    const payload = await this.readBlob(hash);
    if (payload === undefined) return undefined;

    return `data:${mimeType};base64,${payload.toString('base64')}`;
  }

  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached;
    }
    if (this.blobsDir === undefined) return undefined;

    const payload = await readFile(join(this.blobsDir, hash)).catch(() => undefined);
    if (payload !== undefined) {
      this.setCache(hash, payload);
    }
    return payload;
  }

  private async maybeOffloadString(value: string): Promise<string> {
    if (this.isBlobRef(value)) return value;

    const match = DATA_URI_HEADER_RE.exec(value);
    if (match === null) return value;

    const mimeType = match[1]!;
    const payload = value.slice(match[0].length);
    if (payload.length < this.threshold) return value;

    return this.writeBlob(mimeType, payload);
  }

  private async writeBlob(mimeType: string, base64Payload: string): Promise<string> {
    const blobsDir = this.blobsDir;
    if (blobsDir === undefined) return `data:${mimeType};base64,${base64Payload}`;

    await mkdir(blobsDir, { recursive: true, mode: 0o700 });
    const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
    const blobPath = join(blobsDir, hash);
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
      if (code !== 'EEXIST') throw error;
    }
    this.setCache(hash, binary);
    return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
  }

  private setCache(hash: string, payload: Buffer): void {
    const size = payload.byteLength;
    if (this.cache.has(hash)) {
      const oldSize = this.cacheSizes.get(hash) ?? 0;
      this.currentCacheSize += size - oldSize;
      this.cache.delete(hash);
    } else {
      if (size > this.maxCacheSize) return;
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

registerSingleton(IBlobStoreService, new SyncDescriptor(BlobStoreService, [], true));
