/**
 * `blob` domain — `IAgentBlobService` implementation.
 *
 * Offloads large inline media payloads into content-addressed blobs and
 * loads them back on read; persists bytes through `IBlobStore` under the
 * agent's `scope('blobs')` root, matching the v1 `<agentDir>/blobs/<sha256>`
 * layout. Bound at Agent scope.
 */

import { createHash } from 'node:crypto';
import type { ContentPart } from '#/kosong/contract/message';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IBlobStore } from '#/persistence/interface/blobStore';
import {
  BLOBREF_PROTOCOL,
  IAgentBlobService,
  MISSING_MEDIA_PLACEHOLDER,
} from './agentBlobService';
import { ByteLruCache } from './byteLruCache';

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_MAX_CACHE_SIZE = 50 * 1024 * 1024;
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;

export class AgentBlobServiceImpl implements IAgentBlobService {
  declare readonly _serviceBrand: undefined;

  private readonly storageScope: string;
  private readonly cache = new ByteLruCache(DEFAULT_MAX_CACHE_SIZE);

  constructor(
    @IBlobStore private readonly blobs: IBlobStore,
    @IAgentScopeContext agentCtx: IAgentScopeContext,
  ) {
    this.storageScope = agentCtx.scope('blobs');
  }

  protected get threshold(): number {
    return DEFAULT_THRESHOLD;
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

  private offloadContentPart(part: ContentPart): Promise<ContentPart> {
    return this.rewriteMediaUrls(part, (url) => this.maybeOffloadString(url));
  }

  private loadContentPart(part: ContentPart): Promise<ContentPart> {
    return this.rewriteMediaUrls(part, async (url) => {
      if (!this.isBlobRef(url)) return url;
      return (await this.loadBlobRefUrl(url)) ?? MISSING_MEDIA_PLACEHOLDER;
    });
  }

  private async rewriteMediaUrls(
    part: ContentPart,
    transformUrl: (url: string) => Promise<string>,
  ): Promise<ContentPart> {
    let updated: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(part)) {
      const mediaObj = asMediaContainer(value);
      if (mediaObj === undefined) continue;

      const url = mediaObj.url;
      if (typeof url !== 'string') continue;

      const newUrl = await transformUrl(url);
      if (newUrl === url) continue;

      if (updated === undefined) updated = { ...part };
      updated[key] = { ...(value as object), url: newUrl };
    }
    return updated === undefined ? part : (updated as unknown as ContentPart);
  }

  private async loadBlobRefUrl(url: string): Promise<string | undefined> {
    const ref = parseBlobRef(url);
    if (ref === undefined) return undefined;

    const payload = await this.readBlob(ref.hash);
    if (payload === undefined) return undefined;

    return formatDataUri(ref.mimeType, payload);
  }

  private async readBlob(hash: string): Promise<Buffer | undefined> {
    const cached = this.cache.get(hash);
    if (cached !== undefined) return cached;

    const payload = await this.blobs.get(this.storageScope, hash).catch(() => undefined);
    if (payload === undefined) return undefined;

    const buffer = Buffer.from(payload);
    this.cache.set(hash, buffer);
    return buffer;
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
    this.cache.set(hash, binary);
    return formatBlobRef(mimeType, hash);
  }
}

function formatBlobRef(mimeType: string, hash: string): string {
  return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
}

function parseBlobRef(url: string): { mimeType: string; hash: string } | undefined {
  if (!url.startsWith(BLOBREF_PROTOCOL)) return undefined;
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIdx = rest.indexOf(';');
  if (semiIdx === -1) return undefined;
  const hash = rest.slice(semiIdx + 1);
  if (hash.length === 0) return undefined;
  return { mimeType: rest.slice(0, semiIdx), hash };
}

function formatDataUri(mimeType: string, payload: Buffer): string {
  return `data:${mimeType};base64,${payload.toString('base64')}`;
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
  InstantiationType.Eager,
  'agentBlob',
);
