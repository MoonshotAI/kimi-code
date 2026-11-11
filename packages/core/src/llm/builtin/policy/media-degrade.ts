/**
 * Built-in media recovery. When a request is too large, media parts other than the most recent ones
 * are replaced with placeholders; if that is not enough, or the provider rejects an image format, all
 * media in the request are stripped.
 */
import { mediaKeyOf, type ContentPart, type MediaPart, type Message } from '#/llm/message';
import type {
  LlmRecovery,
  LlmRecoveryEntry,
  LlmRequestRewrite,
} from '#/llm/policy/recovery';
import { sha256Hex } from '#/utils/hash';

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

export const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url:
    '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  audio_url:
    '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
} as const;

export const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
  audio_url: '[audio omitted for provider compatibility; re-read the file to hear it]',
  video_url: '[video omitted for provider compatibility; re-read the file to view it]',
} as const;

type DegradableMediaPart = Extract<
  ContentPart,
  { readonly type: keyof typeof MEDIA_DEGRADED_PLACEHOLDERS }
>;

export type MediaReplacement = (part: MediaPart) => ContentPart | undefined;

function isDegradableMediaPart(part: ContentPart): part is DegradableMediaPart {
  return part.type in MEDIA_DEGRADED_PLACEHOLDERS;
}

function replaceMediaParts(
  messages: readonly Message[],
  placeholders: Record<DegradableMediaPart['type'], string>,
  shouldReplace: (part: DegradableMediaPart) => boolean,
  replacement?: MediaReplacement,
): readonly Message[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !shouldReplace(part)) return part;
      changed = true;
      messageChanged = true;
      return replacement?.(part) ?? { type: 'text' as const, text: placeholders[part.type] };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

export function countMediaParts(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
}

/**
 * Replaces the first `count` media parts in message order with degraded-size placeholders, or with
 * `replacement` when provided; later media and non-media content stay unchanged.
 *
 * @example
 * const first = { type: 'image_url', imageUrl: { url: 'https://example.com/first.png' } };
 * const second = { type: 'image_url', imageUrl: { url: 'https://example.com/second.png' } };
 * const degraded = {
 *   type: 'text',
 *   text: '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
 * };
 * // With `count = 1`:
 * // Input:
 * [{ role: 'user', content: [first, second] }] // ←
 * // Output:
 * [{ role: 'user', content: [degraded, second] }] // ←
 */
export function degradeLeadingMediaParts(
  messages: readonly Message[],
  count: number,
  replacement?: MediaReplacement,
): readonly Message[] {
  let toDegrade = count;
  return replaceMediaParts(
    messages,
    MEDIA_DEGRADED_PLACEHOLDERS,
    () => {
      if (toDegrade === 0) return false;
      toDegrade -= 1;
      return true;
    },
    replacement,
  );
}

/**
 * Keeps the most recent `keepRecent` media parts intact and degrades every earlier media part,
 * preserving message order and all non-media content.
 *
 * @example
 * const older = { type: 'image_url', imageUrl: { url: 'https://example.com/older.png' } };
 * const recent = { type: 'image_url', imageUrl: { url: 'https://example.com/recent.png' } };
 * const degraded = {
 *   type: 'text',
 *   text: '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
 * };
 * // With `keepRecent = 1`:
 * // Input:
 * [{ role: 'user', content: [older, recent] }] // ←
 * // Output:
 * [{ role: 'user', content: [degraded, recent] }] // ←
 */
export function degradeOlderMediaParts(
  messages: readonly Message[],
  keepRecent: number,
  replacement?: MediaReplacement,
): readonly Message[] {
  return degradeLeadingMediaParts(
    messages,
    Math.max(0, countMediaParts(messages) - keepRecent),
    replacement,
  );
}

export function captureMediaKeys(messages: readonly Message[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isDegradableMediaPart(part)) keys.add(mediaKeyOf(part));
    }
  }
  return keys;
}

/**
 * Replaces media parts whose `mediaKeyOf` is in `keys` with provider-compatibility placeholders, or
 * with `replacement` when provided; by default, strips every media part in the input.
 *
 * @example
 * const image = { type: 'image_url', imageUrl: { url: 'https://example.com/chart.png' } };
 * const stripped = {
 *   type: 'text',
 *   text: '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
 * };
 * // With the default `keys = captureMediaKeys(messages)`:
 * // Input:
 * [{ role: 'user', content: [image] }] // ←
 * // Output:
 * [{ role: 'user', content: [stripped] }] // ←
 */
export function stripMediaParts(
  messages: readonly Message[],
  keys: ReadonlySet<string> = captureMediaKeys(messages),
  replacement?: MediaReplacement,
): readonly Message[] {
  return replaceMediaParts(
    messages,
    MEDIA_STRIPPED_PLACEHOLDERS,
    (part) => keys.has(mediaKeyOf(part)),
    replacement,
  );
}

const MEDIA_RECOVERY_ID = 'media-degrade';
const IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS = [
  /unsupported media type for base64 image/i,
  /invalid data url for image/i,
] as const;

function rewriteMessages(
  rewrite: (messages: readonly Message[]) => readonly Message[],
): LlmRequestRewrite {
  return (request) => {
    const messages = rewrite(request.content.messages);
    return messages === request.content.messages
      ? request
      : { ...request, content: { ...request.content, messages } };
  };
}

function mediaParts(messages: readonly Message[]): readonly DegradableMediaPart[] {
  return messages.flatMap((message) => message.content.filter(isDegradableMediaPart));
}

function recoveryMediaKey(part: MediaPart): string {
  return sha256Hex(new TextEncoder().encode(mediaKeyOf(part)));
}

function recoveryEntry(
  action: 'degraded' | 'stripped',
  parts: readonly DegradableMediaPart[],
  placeholders: Record<DegradableMediaPart['type'], string>,
  replacement?: MediaReplacement,
): LlmRecoveryEntry | undefined {
  if (parts.length === 0) return undefined;
  const occurrences = new Map<string, number>();
  const replacements = new Map<string, ContentPart>();
  for (const part of parts) {
    const mediaKey = recoveryMediaKey(part);
    const occurrence = occurrences.get(mediaKey) ?? 0;
    occurrences.set(mediaKey, occurrence + 1);
    const key = action === 'degraded' ? `${mediaKey}:${String(occurrence)}` : mediaKey;
    replacements.set(key, replacement?.(part) ?? { type: 'text', text: placeholders[part.type] });
  }
  const reuseKey = sha256Hex(new TextEncoder().encode(JSON.stringify([
    action,
    [...replacements.keys()].toSorted(),
  ])));
  return {
    strategy: MEDIA_RECOVERY_ID,
    action,
    rewrite: rewriteMessages((current) => {
      const currentOccurrences = new Map<string, number>();
      return replaceMediaParts(
        current,
        placeholders,
        (part) => {
          const mediaKey = recoveryMediaKey(part);
          const occurrence = currentOccurrences.get(mediaKey) ?? 0;
          currentOccurrences.set(mediaKey, occurrence + 1);
          const key = action === 'degraded' ? `${mediaKey}:${String(occurrence)}` : mediaKey;
          return replacements.has(key);
        },
        (part) => {
          const mediaKey = recoveryMediaKey(part);
          const occurrence = (currentOccurrences.get(mediaKey) ?? 1) - 1;
          const key = action === 'degraded' ? `${mediaKey}:${String(occurrence)}` : mediaKey;
          return replacements.get(key);
        },
      );
    }),
    reuse: { key: reuseKey },
  };
}

function degradeEntry(
  messages: readonly Message[],
  replacement?: MediaReplacement,
): LlmRecoveryEntry | undefined {
  const count = Math.max(0, countMediaParts(messages) - MEDIA_DEGRADE_KEEP_RECENT);
  return recoveryEntry(
    'degraded',
    mediaParts(messages).slice(0, count),
    MEDIA_DEGRADED_PLACEHOLDERS,
    replacement,
  );
}

function stripEntry(
  messages: readonly Message[],
  replacement?: MediaReplacement,
): LlmRecoveryEntry | undefined {
  return recoveryEntry('stripped', mediaParts(messages), MEDIA_STRIPPED_PLACEHOLDERS, replacement);
}

export function createMediaDegradeRecovery(replacement?: MediaReplacement): LlmRecovery {
  return {
    propose: ({ error, request, appliedRecoveries }) => {
      const imageFormat =
        error.kind === 'image_format' ||
        ((error.kind === 'provider' || error.kind === 'syntax') &&
          IMAGE_FORMAT_PROVIDER_MESSAGE_PATTERNS.some((pattern) => pattern.test(error.message)));
      if (error.kind !== 'request_too_large' && !imageFormat) return undefined;
      const messages = request.content.messages;
      const stripped = appliedRecoveries.some(
        (recovery) => recovery.strategy === MEDIA_RECOVERY_ID && recovery.action === 'stripped',
      );
      if (error.kind === 'request_too_large' && !stripped) {
        const degraded = degradeEntry(messages, replacement);
        if (degraded !== undefined) return degraded;
      }
      return stripEntry(messages, replacement);
    },
  };
}
