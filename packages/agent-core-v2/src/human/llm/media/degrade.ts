import type { ContentPart, Message } from '#/llm/message';
import type { LlmRecovery } from '#/llm/requester/recovery';

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url:
    '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  audio_url:
    '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
} as const;

const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url:
    '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
  audio_url: '[audio omitted for provider compatibility; re-read the file to hear it]',
  video_url: '[video omitted for provider compatibility; re-read the file to view it]',
} as const;

type DegradableMediaPart = Extract<
  ContentPart,
  { readonly type: keyof typeof MEDIA_DEGRADED_PLACEHOLDERS }
>;

function isDegradableMediaPart(part: ContentPart): part is DegradableMediaPart {
  return part.type in MEDIA_DEGRADED_PLACEHOLDERS;
}

function replaceMediaParts(
  messages: readonly Message[],
  placeholders: Record<DegradableMediaPart['type'], string>,
  shouldReplace: (part: DegradableMediaPart) => boolean,
): readonly Message[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !shouldReplace(part)) return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: placeholders[part.type] };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

export function degradeOlderMediaParts(
  messages: readonly Message[],
  keepRecent: number,
): readonly Message[] {
  const mediaCount = messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
  let toDegrade = Math.max(0, mediaCount - keepRecent);
  if (toDegrade === 0) return messages;
  return replaceMediaParts(messages, MEDIA_DEGRADED_PLACEHOLDERS, () => {
    if (toDegrade === 0) return false;
    toDegrade -= 1;
    return true;
  });
}

export function stripMediaParts(messages: readonly Message[]): readonly Message[] {
  return replaceMediaParts(messages, MEDIA_STRIPPED_PLACEHOLDERS, () => true);
}

const MEDIA_RECOVERY_ID = 'media-degrade';

export function createMediaDegradeRecovery(): LlmRecovery {
  return {
    id: MEDIA_RECOVERY_ID,
    propose: ({ error, messages, applied }) => {
      const done = new Set(
        applied.filter((r) => r.strategy === MEDIA_RECOVERY_ID).map((r) => r.action),
      );
      if (error.kind === 'image_format') {
        if (!done.has('stripped')) {
          const stripped = stripMediaParts(messages);
          if (stripped !== messages) return { action: 'stripped', messages: stripped };
        }
        return undefined;
      }
      if (error.kind !== 'request_too_large') return undefined;
      if (!done.has('degraded')) {
        const degraded = degradeOlderMediaParts(messages, MEDIA_DEGRADE_KEEP_RECENT);
        if (degraded !== messages) return { action: 'degraded', messages: degraded };
      }
      if (!done.has('stripped')) {
        const stripped = stripMediaParts(messages);
        if (stripped !== messages) return { action: 'stripped', messages: stripped };
      }
      return undefined;
    },
  };
}
