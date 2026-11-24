import {
  isMediaPart,
  mediaKeyOf,
  mediaOmissionOf,
  mediaPlaceholderText,
  omitMediaPart,
  type ContentPart,
  type MediaPart,
  type Message,
} from '#/llm/message';
import type {
  LlmRecovery,
  LlmRecoveryEntry,
  LlmRequestRewrite,
} from '#/llm/policy/recovery';
import { sha256Hex } from '#/utils/hash';

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

export const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url: mediaPlaceholderText('image', 'degraded'),
  audio_url: mediaPlaceholderText('audio', 'degraded'),
  video_url: mediaPlaceholderText('video', 'degraded'),
} as const;

export const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url: mediaPlaceholderText('image', 'stripped'),
  audio_url: mediaPlaceholderText('audio', 'stripped'),
  video_url: mediaPlaceholderText('video', 'stripped'),
} as const;

export type MediaReplacement = (part: MediaPart) => ContentPart | undefined;

function isDegradableMediaPart(part: ContentPart): part is MediaPart {
  return isMediaPart(part) && mediaOmissionOf(part) === undefined;
}

function mapMediaParts(
  messages: readonly Message[],
  shouldReplace: (part: MediaPart) => boolean,
  replace: (part: MediaPart) => ContentPart,
): readonly Message[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !shouldReplace(part)) return part;
      changed = true;
      messageChanged = true;
      return replace(part);
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

function replaceMediaParts(
  messages: readonly Message[],
  placeholders: Record<MediaPart['type'], string>,
  shouldReplace: (part: MediaPart) => boolean,
  replacement?: MediaReplacement,
): readonly Message[] {
  return mapMediaParts(
    messages,
    shouldReplace,
    (part) => replacement?.(part) ?? { type: 'text', text: placeholders[part.type] },
  );
}

export function countMediaParts(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
}

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

function mediaParts(messages: readonly Message[]): readonly MediaPart[] {
  return messages.flatMap((message) => message.content.filter(isDegradableMediaPart));
}

function recoveryMediaKey(part: MediaPart): string {
  return sha256Hex(new TextEncoder().encode(mediaKeyOf(part)));
}

function recoveryEntry(
  action: 'degraded' | 'stripped',
  parts: readonly MediaPart[],
): LlmRecoveryEntry | undefined {
  if (parts.length === 0) return undefined;
  const occurrences = new Map<string, number>();
  const selected = new Set<string>();
  for (const part of parts) {
    const mediaKey = recoveryMediaKey(part);
    const occurrence = occurrences.get(mediaKey) ?? 0;
    occurrences.set(mediaKey, occurrence + 1);
    selected.add(action === 'degraded' ? `${mediaKey}:${String(occurrence)}` : mediaKey);
  }
  const reuseKey = sha256Hex(new TextEncoder().encode(JSON.stringify([
    action,
    [...selected].toSorted(),
  ])));
  return {
    strategy: MEDIA_RECOVERY_ID,
    action,
    rewrite: rewriteMessages((current) => {
      const currentOccurrences = new Map<string, number>();
      return mapMediaParts(
        current,
        (part) => {
          const mediaKey = recoveryMediaKey(part);
          const occurrence = currentOccurrences.get(mediaKey) ?? 0;
          currentOccurrences.set(mediaKey, occurrence + 1);
          return selected.has(action === 'degraded' ? `${mediaKey}:${String(occurrence)}` : mediaKey);
        },
        (part) => omitMediaPart(part, action),
      );
    }),
    reuse: { key: reuseKey },
  };
}

function degradeEntry(messages: readonly Message[]): LlmRecoveryEntry | undefined {
  const count = Math.max(0, countMediaParts(messages) - MEDIA_DEGRADE_KEEP_RECENT);
  return recoveryEntry('degraded', mediaParts(messages).slice(0, count));
}

function stripEntry(messages: readonly Message[]): LlmRecoveryEntry | undefined {
  return recoveryEntry('stripped', mediaParts(messages));
}

export function createMediaDegradeRecovery(): LlmRecovery {
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
        const degraded = degradeEntry(messages);
        if (degraded !== undefined) return degraded;
      }
      return stripEntry(messages);
    },
  };
}
