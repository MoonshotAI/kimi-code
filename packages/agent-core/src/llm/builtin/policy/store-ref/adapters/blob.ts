import type { UploadedMedia } from '#/llm/request';

import { sha256Hex } from '../hash';
import type { UploadCache } from '../ports';

export interface BlobBackend {
  has(ref: string): Promise<boolean>;
  read(ref: string): Promise<Uint8Array>;
  write(ref: string, data: Uint8Array): Promise<void>;
}

const CACHE_PREFIX = 'media-upload';

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseCachedPart(raw: string): UploadedMedia | undefined {
  try {
    const data = JSON.parse(raw) as {
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
  } catch {
    return undefined;
  }
}

export function createBlobUploadCache(blobs: BlobBackend): UploadCache {
  const key = (ref: string, accountKey: string) =>
    sha256Hex(new TextEncoder().encode(`${CACHE_PREFIX}\0${ref}\0${accountKey}`));
  return {
    get: async (ref, accountKey) => {
      const refKey = await key(ref, accountKey);
      if (!(await blobs.has(refKey))) return undefined;
      const raw = await blobs.read(refKey).catch(() => undefined);
      if (raw === undefined) return undefined;
      return parseCachedPart(new TextDecoder().decode(raw));
    },
    put: async (ref, accountKey, uploaded) => {
      const refKey = await key(ref, accountKey);
      await blobs
        .write(refKey, new TextEncoder().encode(JSON.stringify(uploaded)))
        .catch(() => undefined);
    },
  };
}
