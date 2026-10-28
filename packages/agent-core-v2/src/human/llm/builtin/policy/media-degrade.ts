import { mediaKeyOf, type ContentPart, type MediaPart, type Message } from '#/llm/message';
import type {
  LlmRecovery,
  LlmRecoveryEntry,
  LlmRecoveryRecord,
  LlmRequestRewrite,
} from '#/llm/policy/recovery';

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
  image_url:
    '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
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
      return replacement?.(part) ?? { type: 'text', text: placeholders[part.type] };
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

export function degradeLeadingMediaParts(
  messages: readonly Message[],
  count: number,
  replacement?: MediaReplacement,
): readonly Message[] {
  let toDegrade = count;
  if (toDegrade <= 0) return messages;
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

function degradeEntry(
  messages: readonly Message[],
  appliedRecoveries: readonly LlmRecoveryRecord[],
  replacement?: MediaReplacement,
): LlmRecoveryEntry | undefined {
  const count = Math.max(0, countMediaParts(messages) - MEDIA_DEGRADE_KEEP_RECENT);
  const alreadyDegraded = appliedRecoveries.some(
    (recovery) => recovery.strategy === MEDIA_RECOVERY_ID && recovery.action === 'degraded',
  );
  if (count === 0 && alreadyDegraded) return undefined;
  return {
    strategy: MEDIA_RECOVERY_ID,
    action: 'degraded',
    rewrite:
      count === 0
        ? undefined
        : rewriteMessages((current) => degradeLeadingMediaParts(current, count, replacement)),
  };
}

function stripEntry(
  messages: readonly Message[],
  appliedRecoveries: readonly LlmRecoveryRecord[],
  replacement?: MediaReplacement,
): LlmRecoveryEntry | undefined {
  const keys = captureMediaKeys(messages);
  const alreadyStripped = appliedRecoveries.some(
    (recovery) => recovery.strategy === MEDIA_RECOVERY_ID && recovery.action === 'stripped',
  );
  if (keys.size === 0 && alreadyStripped) return undefined;
  return {
    strategy: MEDIA_RECOVERY_ID,
    action: 'stripped',
    rewrite:
      keys.size === 0
        ? undefined
        : rewriteMessages((current) => stripMediaParts(current, keys, replacement)),
  };
}

export function createMediaDegradeRecovery(replacement?: MediaReplacement): LlmRecovery {
  return {
    propose: ({ error, request, appliedRecoveries }) => {
      if (error.kind !== 'request_too_large' && error.kind !== 'image_format') return undefined;
      const messages = request.content.messages;
      const stripped = appliedRecoveries.some(
        (recovery) => recovery.strategy === MEDIA_RECOVERY_ID && recovery.action === 'stripped',
      );
      if (error.kind === 'request_too_large' && !stripped) {
        const degraded = degradeEntry(messages, appliedRecoveries, replacement);
        if (degraded !== undefined) return degraded;
      }
      return stripEntry(messages, appliedRecoveries, replacement);
    },
  };
}
