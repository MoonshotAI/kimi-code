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
  if (part.type !== 'image_url' && part.type !== 'video_url') return undefined;
  const kind = part.type === 'image_url' ? 'image' : 'video';
  const url = part.type === 'image_url' ? part.imageUrl.url : part.videoUrl.url;
  const ref = parseMediaRefUrl(url);
  return ref === undefined ? undefined : { kind, ref };
}
