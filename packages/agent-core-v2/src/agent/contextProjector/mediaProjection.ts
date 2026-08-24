import { createHash } from 'node:crypto';

import type { ContentPart, Message } from '#/kosong/contract/message';

import type { MediaStripSnapshot } from './contextProjector';

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url:
    '[An image attached to an earlier message was removed to fit the provider request size limit. You have NOT seen this image — do not describe or guess its contents. If it matters, ask the user to re-send it or to point you at the file so you can read it with ReadMediaFile.]',
  audio_url:
    '[An audio clip attached to an earlier message was removed to fit the provider request size limit. You have NOT heard it — do not describe or guess its contents.]',
  video_url:
    '[A video attached to an earlier message was removed to fit the provider request size limit. You have NOT seen it — do not describe or guess its contents.]',
} as const;

export const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url:
    '[An image attached to this message was removed before sending because the provider could not accept it (unsupported or unreadable image data). You have NOT seen this image — do not describe or guess its contents. Tell the user the image failed to reach you and suggest re-sending it as PNG or JPEG.]',
  audio_url:
    '[An audio clip attached to this message was removed before sending because the provider could not accept it. You have NOT heard it — do not describe or guess its contents.]',
  video_url:
    '[A video attached to this message was removed before sending because the provider could not accept it. You have NOT seen it — do not describe or guess its contents.]',
} as const;

type MediaPlaceholderSet = typeof MEDIA_DEGRADED_PLACEHOLDERS | typeof MEDIA_STRIPPED_PLACEHOLDERS;

type DegradableMediaPart = Extract<
  ContentPart,
  { readonly type: keyof MediaPlaceholderSet }
>;

interface MediaContainer {
  readonly url: string;
  readonly id?: string;
}

interface MediaStripSnapshotData {
  readonly keys: ReadonlySet<string>;
}

type MediaContainerKeyCache = Partial<Record<DegradableMediaPart['type'], string>>;

const MEDIA_CONTAINER_KEY_CACHE = new WeakMap<MediaContainer, MediaContainerKeyCache>();

function isDegradableMediaPart(
  part: ContentPart,
): part is DegradableMediaPart {
  return part.type in MEDIA_DEGRADED_PLACEHOLDERS;
}

function mediaContainer(part: DegradableMediaPart): MediaContainer {
  if (part.type === 'image_url') return part.imageUrl;
  if (part.type === 'audio_url') return part.audioUrl;
  return part.videoUrl;
}

function mediaStripKey(part: DegradableMediaPart): string {
  const container = mediaContainer(part);
  let cache = MEDIA_CONTAINER_KEY_CACHE.get(container);
  const cached = cache?.[part.type];
  if (cached !== undefined) return cached;

  const key = createHash('sha256')
    .update(part.type)
    .update('\0')
    .update(container.id ?? '')
    .update('\0')
    .update(container.url)
    .digest('hex');
  if (cache === undefined) {
    cache = {};
    MEDIA_CONTAINER_KEY_CACHE.set(container, cache);
  }
  cache[part.type] = key;
  return key;
}

function mediaStripSnapshotKeys(snapshot: MediaStripSnapshot): ReadonlySet<string> {
  return (snapshot as unknown as MediaStripSnapshotData).keys;
}

export function captureMediaStripSnapshot(
  messages: readonly Message[],
): MediaStripSnapshot {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isDegradableMediaPart(part)) keys.add(mediaStripKey(part));
    }
  }
  return Object.freeze({ keys }) as unknown as MediaStripSnapshot;
}

export function stripMediaPartsBySnapshot(
  messages: readonly Message[],
  snapshot: MediaStripSnapshot,
): readonly Message[] {
  const keys = mediaStripSnapshotKeys(snapshot);
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !keys.has(mediaStripKey(part))) return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: MEDIA_STRIPPED_PLACEHOLDERS[part.type] };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

export function degradeOlderMediaParts(
  messages: readonly Message[],
  keepRecent: number,
  placeholders: MediaPlaceholderSet = MEDIA_DEGRADED_PLACEHOLDERS,
): readonly Message[] {
  const mediaCount = messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
  let toDegrade = Math.max(0, mediaCount - keepRecent);
  if (toDegrade === 0) return messages;

  return messages.map((message) => {
    if (toDegrade === 0 || !message.content.some(isDegradableMediaPart)) return message;
    const content = message.content.map((part): ContentPart => {
      if (toDegrade === 0 || !isDegradableMediaPart(part)) return part;
      toDegrade -= 1;
      return { type: 'text', text: placeholders[part.type] };
    });
    return { ...message, content };
  });
}
