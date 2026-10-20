import { BlobIntegrityError, type BlobCache, type BlobStore } from '#/blob/index';
import type { UploadedMedia } from '#/llm/request';

import type { RefStore, UploadCache } from '../ports';

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseUploaded(value: unknown): UploadedMedia | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const data = value as {
    source?: { kind?: unknown; url?: unknown; id?: unknown; mimeType?: unknown };
    expiresAt?: unknown;
  };
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : undefined;
  const source = data.source;
  if (source?.kind === 'url' && nonEmpty(source.url)) {
    return { source: { kind: 'url', url: source.url }, expiresAt };
  }
  if (source?.kind === 'file' && nonEmpty(source.id) && nonEmpty(source.mimeType)) {
    return { source: { kind: 'file', id: source.id, mimeType: source.mimeType }, expiresAt };
  }
  return undefined;
}

export function createBlobRefStore(blobs: BlobStore): RefStore {
  return {
    get: async (ref) => {
      try {
        return await blobs.get(ref);
      } catch (error) {
        if (error instanceof BlobIntegrityError) return undefined;
        throw error;
      }
    },
  };
}

export function createBlobUploadCache(cache: BlobCache): UploadCache {
  const keyOf = (ref: string, accountKey: string): string => `${ref}\0${accountKey}`;
  return {
    get: async (ref, accountKey) => parseUploaded(await cache.get(keyOf(ref, accountKey)).catch(() => undefined)),
    put: async (ref, accountKey, uploaded) => {
      await cache.put(keyOf(ref, accountKey), uploaded).catch(() => undefined);
    },
  };
}
