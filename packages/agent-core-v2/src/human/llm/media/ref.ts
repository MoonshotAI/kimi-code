import type { ContentPart } from '#/llm/message';

const MEDIA_REF_SCHEME = 'media://';

export interface MediaRef {
  readonly kind: 'image' | 'video';
  readonly ref: string;
}

export function buildMediaRefUrl(ref: string): string {
  return `${MEDIA_REF_SCHEME}${ref}`;
}

export function parseMediaRefUrl(url: string): string | undefined {
  if (!url.startsWith(MEDIA_REF_SCHEME)) return undefined;
  const ref = url.slice(MEDIA_REF_SCHEME.length);
  return ref.length > 0 ? ref : undefined;
}

export function mediaRefFromPart(part: ContentPart): MediaRef | undefined {
  if (part.type === 'image_url') {
    const ref = parseMediaRefUrl(part.imageUrl.url);
    return ref === undefined ? undefined : { kind: 'image', ref };
  }
  if (part.type === 'video_url') {
    const ref = parseMediaRefUrl(part.videoUrl.url);
    return ref === undefined ? undefined : { kind: 'video', ref };
  }
  return undefined;
}
