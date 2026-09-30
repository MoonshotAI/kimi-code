import type { ResolvedEndpoint } from '#/llm/endpoint';
import {
  mediaKindOfPart,
  mediaPlaceholderText,
  type MediaKind,
  type MediaOmission,
  type MediaPart,
  type MediaSource,
} from '#/llm/message';
import {
  acceptsMime,
  acceptsSource,
  mediaSupportAt,
  type MediaKindSupport,
  type MediaPosition,
  type MediaSupport,
} from '#/llm/protocol/rules/media';
import { capabilityAccepts, type LlmFiles, type LlmModelSpec } from '#/llm/request';

import { mediaKindForMime, mediaMimeForPath, sniffMediaMime } from './mime';
import type { Placeholder, RefStore, StoredContent, UploadCache } from './ports';
import type { StoreRefSession } from './session';

export type Materialized =
  | { readonly form: 'media'; readonly source: MediaSource }
  | { readonly form: 'omit'; readonly text: string };

export interface ResolveContext {
  readonly model: LlmModelSpec;
  readonly endpoint: ResolvedEndpoint;
  readonly account: string;
  readonly media: MediaSupport;
  readonly signal: AbortSignal;
  readonly session: StoreRefSession;
  readonly store: RefStore;
  readonly cache: UploadCache;
  readonly placeholder?: Placeholder;
  readonly files?: LlmFiles;
}

export class UploadAuthError extends Error {
  constructor(
    readonly statusCode: number,
    options?: { cause?: unknown },
  ) {
    super(`Media upload request failed with status ${statusCode}`, options);
    this.name = 'UploadAuthError';
  }
}

export async function omittedText(
  part: MediaPart,
  omission: MediaOmission,
  ctx: ResolveContext,
): Promise<Materialized> {
  const kind = mediaKindOfPart(part);
  const ref = part.source.kind === 'store' ? part.source.ref : undefined;
  const custom = await ctx.placeholder?.({ kind, reason: omission, ref });
  return { form: 'omit', text: custom ?? mediaPlaceholderText(kind, omission) };
}

function unavailableText(kind: MediaKind): Materialized {
  return { form: 'omit', text: mediaPlaceholderText(kind, 'unavailable') };
}

function resolveMimeType(content: StoredContent, kind: MediaKind): string | undefined {
  const sniffed = sniffMediaMime(content.bytes);
  const declared =
    content.mimeType ??
    (content.filename === undefined ? undefined : mediaMimeForPath(content.filename));
  const candidates = kind === 'image' ? [sniffed, declared] : [declared, sniffed];
  return candidates.find((mimeType) => mimeType !== undefined && mediaKindForMime(mimeType) === kind);
}

function isFresh(expiresAt: number | undefined): boolean {
  return expiresAt === undefined || expiresAt > Date.now();
}

function referenceBytes(source: MediaSource): number {
  return source.kind === 'url' ? source.url.length : source.kind === 'file' ? source.id.length : 0;
}

function uploadAuthStatusCode(error: unknown): number | undefined {
  const statusCode = (error as { statusCode?: unknown; status?: unknown }).statusCode;
  if (statusCode === 401 || statusCode === 403) return statusCode;
  const status = (error as { status?: unknown }).status;
  if (status === 401 || status === 403) return status;
  return undefined;
}

const BASE64_CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

async function materializeStored(
  part: MediaPart,
  ref: string,
  spec: MediaKindSupport,
  ctx: ResolveContext,
): Promise<Materialized> {
  const kind = mediaKindOfPart(part);
  const accountKey = `${kind}\0${ctx.account}`;
  const memoKey = `${accountKey}\0${ref}`;
  const memoed = ctx.session.memo.get(memoKey);
  if (memoed !== undefined && isFresh(memoed.expiresAt) && acceptsSource(spec, memoed.source)) {
    return { form: 'media', source: memoed.source };
  }
  const remember = (source: MediaSource, bytes: number, expiresAt?: number): Materialized => {
    ctx.session.memo.set(memoKey, { source, expiresAt }, bytes);
    return { form: 'media', source };
  };

  const files = ctx.files?.kinds.has(kind) === true ? ctx.files : undefined;
  if (files !== undefined) {
    const cached = await ctx.cache.get(ref, accountKey);
    if (cached !== undefined && isFresh(cached.expiresAt) && acceptsSource(spec, cached.source)) {
      return remember(cached.source, referenceBytes(cached.source), cached.expiresAt);
    }
  }
  const content = await ctx.store.get(ref);
  const mimeType = content === undefined ? undefined : resolveMimeType(content, kind);
  if (content === undefined || mimeType === undefined) return unavailableText(kind);
  if (!acceptsMime(spec, mimeType)) return omittedText(part, 'stripped', ctx);
  if (files !== undefined) {
    try {
      const uploaded = await files.upload(
        { kind, data: content.bytes, mimeType, filename: content.filename },
        { endpoint: ctx.endpoint, signal: ctx.signal },
      );
      if (acceptsSource(spec, uploaded.source)) {
        await ctx.cache.put(ref, accountKey, uploaded);
        return remember(uploaded.source, referenceBytes(uploaded.source), uploaded.expiresAt);
      }
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      const authStatus = uploadAuthStatusCode(error);
      if (authStatus !== undefined) throw new UploadAuthError(authStatus, { cause: error });
    }
  }
  if (!spec.sources.includes('inline')) return unavailableText(kind);
  const inline: MediaSource = { kind: 'inline', mimeType, data: toBase64(content.bytes) };
  return remember(inline, content.bytes.byteLength);
}

export async function materializePart(
  part: MediaPart,
  position: MediaPosition,
  ctx: ResolveContext,
): Promise<Materialized> {
  const source = part.source;
  if (part.omitted !== undefined) return omittedText(part, part.omitted, ctx);
  const kind = mediaKindOfPart(part);
  const spec = mediaSupportAt(ctx.media, kind, position);
  if (spec === undefined || !capabilityAccepts(ctx.model.capability, kind)) {
    return { form: 'media', source };
  }
  switch (source.kind) {
    case 'inline':
      return mediaKindForMime(source.mimeType) === kind ? { form: 'media', source } : unavailableText(kind);
    case 'store':
      return materializeStored(part, source.ref, spec, ctx);
    case 'url':
    case 'file':
      return { form: 'media', source };
  }
}
