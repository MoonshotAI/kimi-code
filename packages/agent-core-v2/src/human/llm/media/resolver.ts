import type { ModelCapability } from '#/llm/capability';
import type { ContentPart, Message, VideoURLPart } from '#/llm/message';
import type { Provider } from '#/llm/provider/definition';
import type { MessageResolveContext, MessageResolver } from '#/llm/requester/machine';

import type { MediaUploadCache } from './cache';
import { mediaKindForMime, mediaMimeForPath, type MediaKind } from './mime';
import { mediaRefFromPart } from './ref';
import type { MediaContent, MediaSource } from './source';

export interface MediaRefResolverDeps {
  readonly providers: readonly Provider[];
  readonly source: MediaSource;
  readonly cache: MediaUploadCache;
}

const VIDEO_UNAVAILABLE_TEXT = '[video omitted: media unavailable]';
const IMAGE_UNAVAILABLE_TEXT = '[image omitted: media unavailable]';

function resolveMimeType(content: MediaContent, kind: MediaKind): string | undefined {
  if (content.mimeType !== undefined) {
    return mediaKindForMime(content.mimeType) === kind ? content.mimeType : undefined;
  }
  if (content.filename === undefined) return undefined;
  const mimeType = mediaMimeForPath(content.filename);
  return mimeType !== undefined && mediaKindForMime(mimeType) === kind ? mimeType : undefined;
}

function dataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function unavailableText(kind: 'image' | 'video'): ContentPart {
  return { type: 'text', text: kind === 'video' ? VIDEO_UNAVAILABLE_TEXT : IMAGE_UNAVAILABLE_TEXT };
}

function isMediaUploadAuthError(error: unknown): boolean {
  const statusCode = (error as { statusCode?: unknown; status?: unknown }).statusCode;
  if (statusCode === 401 || statusCode === 403) return true;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function hasMediaRef(message: Message): boolean {
  return message.content.some((part) => mediaRefFromPart(part) !== undefined);
}

export function createMediaRefResolver(deps: MediaRefResolverDeps): MessageResolver {
  const providers = new Map(deps.providers.map((provider) => [provider.id, provider]));
  const imageMemo = new Map<string, ContentPart>();

  const resolveImagePart = async (
    ref: string,
    capability: ModelCapability | undefined,
  ): Promise<ContentPart> => {
    if (capability?.image_in !== true) return unavailableText('image');
    const memoed = imageMemo.get(ref);
    if (memoed !== undefined) return memoed;
    const content = await deps.source.get(ref);
    const mimeType = content === undefined ? undefined : resolveMimeType(content, 'image');
    if (content === undefined || mimeType === undefined) return unavailableText('image');
    const part: ContentPart = {
      type: 'image_url',
      imageUrl: { url: dataUrl(content.bytes, mimeType) },
    };
    imageMemo.set(ref, part);
    return part;
  };

  const resolveVideoPart = async (
    ref: string,
    ctx: MessageResolveContext,
    provider: Provider | undefined,
    capability: ModelCapability | undefined,
  ): Promise<ContentPart> => {
    if (capability?.video_in !== true) return unavailableText('video');
    const providerKey = ctx.model.provider;
    const cached = await deps.cache.get(ref, providerKey);
    if (cached !== undefined) return cached;
    const content = await deps.source.get(ref);
    const mimeType = content === undefined ? undefined : resolveMimeType(content, 'video');
    if (content === undefined || mimeType === undefined) return unavailableText('video');
    const uploader = provider?.media?.uploadVideo;
    if (uploader !== undefined) {
      try {
        const part: VideoURLPart = await uploader(
          { data: content.bytes, mimeType, filename: content.filename },
          { model: ctx.model, signal: ctx.signal },
        );
        await deps.cache.put(ref, providerKey, part);
        return part;
      } catch (error) {
        if (ctx.signal.aborted || isMediaUploadAuthError(error)) throw error;
      }
    }
    if (provider?.media?.inlineVideo === true) {
      return { type: 'video_url', videoUrl: { url: dataUrl(content.bytes, mimeType) } };
    }
    return unavailableText('video');
  };

  return {
    id: 'media-ref',
    resolve: async (messages, ctx) => {
      if (!messages.some(hasMediaRef)) return messages;
      const provider = providers.get(ctx.model.provider);
      const capability = ctx.model.capability;
      const out: Message[] = [];
      for (const message of messages) {
        if (!hasMediaRef(message)) {
          out.push(message);
          continue;
        }
        const content: ContentPart[] = [];
        for (const part of message.content) {
          const ref = mediaRefFromPart(part);
          if (ref === undefined) {
            content.push(part);
            continue;
          }
          content.push(
            ref.kind === 'image'
              ? await resolveImagePart(ref.ref, capability)
              : await resolveVideoPart(ref.ref, ctx, provider, capability),
          );
        }
        out.push({ ...message, content });
      }
      return out;
    },
  };
}
