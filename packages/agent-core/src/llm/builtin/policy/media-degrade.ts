import { isMediaPart, mediaKeyOf, type MediaOmission, type MediaPart, type Message } from '#/llm/message';
import type { LlmMessageRewrite, LlmRecovery, LlmRecoveryEntry } from '#/llm/policy/recovery';

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

function markMediaParts(
  messages: readonly Message[],
  omission: MediaOmission,
  shouldMark: (part: MediaPart) => boolean,
): readonly Message[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (!isMediaPart(part) || part.omitted === omission || !shouldMark(part)) return part;
      changed = true;
      messageChanged = true;
      return { ...part, omitted: omission };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

function liveMediaCount(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) =>
      count + message.content.filter((part) => isMediaPart(part) && part.omitted === undefined).length,
    0,
  );
}

export function degradeOlderMediaParts(
  messages: readonly Message[],
  keepRecent: number,
): readonly Message[] {
  let toDegrade = Math.max(0, liveMediaCount(messages) - keepRecent);
  if (toDegrade === 0) return messages;
  return markMediaParts(messages, 'degraded', (part) => {
    if (toDegrade === 0 || part.omitted !== undefined) return false;
    toDegrade -= 1;
    return true;
  });
}

export function captureMediaKeys(messages: readonly Message[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isMediaPart(part)) keys.add(mediaKeyOf(part));
    }
  }
  return keys;
}

export function stripMediaParts(
  messages: readonly Message[],
  keys: ReadonlySet<string> = captureMediaKeys(messages),
): readonly Message[] {
  return markMediaParts(messages, 'stripped', (part) => keys.has(mediaKeyOf(part)));
}

const MEDIA_RECOVERY_ID = 'media-degrade';

type MediaRecoveryEntry = LlmRecoveryEntry & { readonly rewrite: LlmMessageRewrite };

function stripEntry(messages: readonly Message[]): MediaRecoveryEntry {
  const keys = captureMediaKeys(messages);
  return {
    strategy: MEDIA_RECOVERY_ID,
    action: 'stripped',
    rewrite: (current) => stripMediaParts(current, keys),
  };
}

const DEGRADE: MediaRecoveryEntry = {
  strategy: MEDIA_RECOVERY_ID,
  action: 'degraded',
  rewrite: (messages) => degradeOlderMediaParts(messages, MEDIA_DEGRADE_KEEP_RECENT),
};

export function createMediaDegradeRecovery(): LlmRecovery {
  return {
    propose: ({ error, messages, appliedRecoveries }) => {
      const done = new Set(
        appliedRecoveries.filter((r) => r.strategy === MEDIA_RECOVERY_ID).map((r) => r.action),
      );
      const fresh = (entry: () => MediaRecoveryEntry) => {
        const candidate = entry();
        return !done.has(candidate.action) && candidate.rewrite(messages) !== messages
          ? candidate
          : undefined;
      };
      const strip = () => stripEntry(messages);
      if (error.kind === 'image_format') return fresh(strip);
      if (error.kind !== 'request_too_large') return undefined;
      return fresh(() => DEGRADE) ?? fresh(strip);
    },
  };
}
