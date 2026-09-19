import type { AudioURLPart, ContentPart, ImageURLPart, VideoURLPart } from '#/llm/message';
import type { LlmModel, ModelCapability } from '#/llm/model';
import type { Provider } from '#/llm/provider';

import type { MediaUploadCache } from './cache';
import { mediaKindForMime, mediaMimeForPath, type MediaKind } from './mime';
import { parseMediaRefUrl } from './ref';
import type { MediaContent, MediaSource } from './source';
import type { MediaFileRef } from './upload';

export type MediaPart = ImageURLPart | AudioURLPart | VideoURLPart;

export interface MediaLowerPorts {
  readonly source: MediaSource;
  readonly cache: MediaUploadCache;
  readonly providers: () => readonly Provider[];
}

export interface MediaLowerContext {
  readonly model: LlmModel;
  readonly signal: AbortSignal;
  readonly source?: MediaSource;
  readonly cache?: MediaUploadCache;
  readonly providers?: () => readonly Provider[];
}

export type MaterializedMedia =
  | { readonly form: 'inline'; readonly mimeType: string; readonly data: string }
  | { readonly form: 'file'; readonly url: string; readonly id?: string }
  | { readonly form: 'omit'; readonly text: string };

const VIDEO_UNAVAILABLE_TEXT = '[video omitted: media unavailable]';
const IMAGE_UNAVAILABLE_TEXT = '[image omitted: media unavailable]';
const AUDIO_UNAVAILABLE_TEXT = '[audio omitted: media unavailable]';

const NEVER_ABORTED = new AbortController().signal;

export function isMediaPart(part: ContentPart): part is MediaPart {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

export function mediaContextOf(input: {
  readonly model: LlmModel;
  readonly signal?: AbortSignal;
  readonly media?: MediaLowerPorts;
}): MediaLowerContext {
  return {
    model: input.model,
    signal: input.signal ?? NEVER_ABORTED,
    source: input.media?.source,
    cache: input.media?.cache,
    providers: input.media?.providers,
  };
}

export function createMediaLowerer(
  ctx: MediaLowerContext,
): (part: MediaPart) => Promise<MaterializedMedia> {
  const imageMemo = new Map<string, MaterializedMedia>();
  return (part) => materializeMediaPart(part, ctx, imageMemo);
}

function kindOf(part: MediaPart): MediaKind | 'audio' {
  if (part.type === 'image_url') return 'image';
  if (part.type === 'video_url') return 'video';
  return 'audio';
}

function urlOf(part: MediaPart): string {
  if (part.type === 'image_url') return part.imageUrl.url;
  if (part.type === 'video_url') return part.videoUrl.url;
  return part.audioUrl.url;
}

function unavailableText(kind: MediaKind | 'audio'): MaterializedMedia {
  if (kind === 'video') return { form: 'omit', text: VIDEO_UNAVAILABLE_TEXT };
  if (kind === 'audio') return { form: 'omit', text: AUDIO_UNAVAILABLE_TEXT };
  return { form: 'omit', text: IMAGE_UNAVAILABLE_TEXT };
}

function capabilityAllows(capability: ModelCapability | undefined, kind: MediaKind | 'audio'): boolean {
  if (kind === 'image') return capability?.image_in === true;
  if (kind === 'video') return capability?.video_in === true;
  return capability?.audio_in === true;
}

function mimeMatchesKind(mimeType: string, kind: MediaKind | 'audio'): boolean {
  if (kind === 'audio') return mimeType.startsWith('audio/');
  return mediaKindForMime(mimeType) === kind;
}

function resolveMimeType(content: MediaContent, kind: MediaKind | 'audio'): string | undefined {
  if (content.mimeType !== undefined) {
    return mimeMatchesKind(content.mimeType, kind) ? content.mimeType : undefined;
  }
  if (content.filename === undefined) return undefined;
  const mimeType = mediaMimeForPath(content.filename);
  return mimeType !== undefined && mimeMatchesKind(mimeType, kind) ? mimeType : undefined;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | undefined {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma < 0) return undefined;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  if (data.length === 0) return undefined;
  const semi = meta.indexOf(';');
  const mimeType = (semi < 0 ? meta : meta.slice(0, semi)).trim();
  return mimeType.length > 0 ? { mimeType, data } : undefined;
}

function toInline(bytes: Uint8Array, mimeType: string): MaterializedMedia {
  return { form: 'inline', mimeType, data: Buffer.from(bytes).toString('base64') };
}

function isMediaUploadAuthError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown; status?: unknown }).statusCode;
  if (statusCode === 401 || statusCode === 403) return true;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function providersOf(ctx: MediaLowerContext): Map<string, Provider> {
  return new Map((ctx.providers?.() ?? []).map((provider) => [provider.id, provider]));
}

async function materializeLocal(
  ref: string,
  kind: MediaKind | 'audio',
  ctx: MediaLowerContext,
  imageMemo: Map<string, MaterializedMedia>,
): Promise<MaterializedMedia> {
  if (kind === 'image') {
    const memoed = imageMemo.get(ref);
    if (memoed !== undefined) return memoed;
    const content = await ctx.source?.get(ref);
    const mimeType = content === undefined ? undefined : resolveMimeType(content, 'image');
    if (content === undefined || mimeType === undefined) return unavailableText('image');
    const part = toInline(content.bytes, mimeType);
    imageMemo.set(ref, part);
    return part;
  }
  if (kind === 'audio') {
    const content = await ctx.source?.get(ref);
    const mimeType = content === undefined ? undefined : resolveMimeType(content, 'audio');
    if (content === undefined || mimeType === undefined) return unavailableText('audio');
    return toInline(content.bytes, mimeType);
  }
  const providerKey = ctx.model.provider;
  const cached = await ctx.cache?.get(ref, providerKey);
  if (cached !== undefined) return { form: 'file', url: cached.url, id: cached.id };
  const content = await ctx.source?.get(ref);
  const mimeType = content === undefined ? undefined : resolveMimeType(content, 'video');
  if (content === undefined || mimeType === undefined) return unavailableText('video');
  const provider = providersOf(ctx).get(providerKey);
  const uploader = provider?.media?.uploadVideo;
  if (uploader !== undefined) {
    try {
      const uploaded: MediaFileRef = await uploader(
        { data: content.bytes, mimeType, filename: content.filename },
        { model: ctx.model, signal: ctx.signal },
      );
      await ctx.cache?.put(ref, providerKey, uploaded);
      return { form: 'file', url: uploaded.url, id: uploaded.id };
    } catch (error) {
      if (ctx.signal.aborted || isMediaUploadAuthError(error)) throw error;
    }
  }
  if (provider?.media?.inlineVideo === true) {
    return toInline(content.bytes, mimeType);
  }
  return unavailableText('video');
}

export async function materializeMediaPart(
  part: MediaPart,
  ctx: MediaLowerContext,
  imageMemo: Map<string, MaterializedMedia> = new Map(),
): Promise<MaterializedMedia> {
  const kind = kindOf(part);
  if (!capabilityAllows(ctx.model.capability, kind)) return unavailableText(kind);
  const url = urlOf(part);
  const data = parseDataUrl(url);
  if (data !== undefined) {
    return mimeMatchesKind(data.mimeType, kind)
      ? { form: 'inline', mimeType: data.mimeType, data: data.data }
      : unavailableText(kind);
  }
  const ref = parseMediaRefUrl(url);
  if (ref !== undefined) return materializeLocal(ref, kind, ctx, imageMemo);
  return { form: 'file', url };
}

export function dataUrlOf(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}
