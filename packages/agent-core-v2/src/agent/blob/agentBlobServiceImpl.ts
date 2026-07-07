/**
 * `blob` domain — `IAgentBlobService` implementation.
 *
 * Offloads large inline media payloads into content-addressed blobs and
 * loads them back on read; persists bytes through `IBlobStore` under the
 * agent's `scope('blobs')` root, matching the v1 `<agentDir>/blobs/<sha256>`
 * layout. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import type { ContentPart } from '#/app/llmProtocol';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { IBlobStore } from '#/persistence/interface/blobStore';
import {
  BLOBREF_PROTOCOL,
  IAgentBlobService,
  MISSING_MEDIA_PLACEHOLDER,
} from './agentBlobService';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;

export class AgentBlobServiceImpl implements IAgentBlobService {
  declare readonly _serviceBrand: undefined;

  private readonly storageScope: string;
  private readonly cache = new Map<string, Buffer>();
  private readonly cacheSizes = new Map<string, number>();
  private currentCacheSize = 0;

  constructor(
    @IBlobStore private readonly blobs: IBlobStore,
    @IAgentScopeContext agentCtx: IAgentScopeContext,
  ) {
    this.storageScope = agentCtx.scope('blobs');
  }

  protected get threshold(): number {
    return DEFAULT_THRESHOLD;
  }

  protected get maxCacheSize(): number {
    return DEFAULT_MAX_CACHE_SIZE;
  }

  isBlobRef(url: string): boolean {
    return url.startsWith(BLOBREF_PROTOCOL);
  }

  async offloadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.offloadContentPart(part);
      if (next !== part) changed = true;
      out.push(next);
    }
    return changed ? out : parts;
  }

  async loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]> {
    let changed = false;
    const out: ContentPart[] = [];
    for (const part of parts) {
      const next = await this.loadContentPart(part);
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

  private async loadContentPart(part: ContentPart): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string' || !this.isBlobRef(url)) continue;

      const newUrl = await this.loadBlobRefUrl(url);
      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl ?? MISSING_MEDIA_PLACEHOLDER };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  private async loadBlobRefUrl(url: string): Promise<string | undefined> {
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

    const payload = await this.blobs.get(this.storageScope, hash).catch(() => undefined);
    if (payload !== undefined) {
      this.setCache(hash, Buffer.from(payload));
    }
    return payload !== undefined ? Buffer.from(payload) : undefined;
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
    const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
    const binary = Buffer.from(base64Payload, 'base64');
    await this.blobs.put(this.storageScope, hash, binary);
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentBlobService,
  AgentBlobServiceImpl,
  InstantiationType.Delayed,
  'agentBlob',
);
