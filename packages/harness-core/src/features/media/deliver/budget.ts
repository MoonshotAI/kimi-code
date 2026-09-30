import type { Message, MessageResolver } from '@moonshot-ai/agent-core';

import { sha256Hex } from '#/sha256';

import { isDataUrl } from '../inspect/format-policy';

export const REQUEST_MEDIA_BUDGET_BYTES = 20 * 1024 * 1024;
export const REQUEST_MEDIA_BUDGET_LOW_BYTES = 10 * 1024 * 1024;

interface MediaBudgetEntry {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly key: string;
  readonly kind: 'image' | 'video';
  readonly bytes: number;
}

export function createMediaBudgetResolver(): MessageResolver {
  return {
    id: 'media-budget',
    resolve: (messages) => {
      const entries: MediaBudgetEntry[] = [];
      messages.forEach((message, messageIndex) => {
        message.content.forEach((part, partIndex) => {
          if (part.type !== 'image_url' && part.type !== 'video_url') return;
          const url = part.type === 'image_url' ? part.imageUrl.url : part.videoUrl.url;
          if (!isDataUrl(url)) return;
          const kind = part.type === 'image_url' ? 'image' : 'video';
          const key = sha256Hex(`${kind}\0${url}`);
          entries.push({ messageIndex, partIndex, key, kind, bytes: url.length });
        });
      });
      if (entries.length === 0) return Promise.resolve(messages);
      const pending = new Map<string, number>();
      for (const entry of entries) {
        pending.set(entry.key, (pending.get(entry.key) ?? 0) + entry.bytes);
      }
      let total = 0;
      for (const bytes of pending.values()) total += bytes;
      if (total <= REQUEST_MEDIA_BUDGET_BYTES) return Promise.resolve(messages);
      const dropped = new Set<string>();
      for (const [key, bytes] of pending) {
        if (total <= REQUEST_MEDIA_BUDGET_LOW_BYTES) break;
        dropped.add(key);
        total -= bytes;
      }
      const out = messages.map((message) => ({ ...message, content: [...message.content] }));
      for (const entry of entries) {
        if (!dropped.has(entry.key)) continue;
        out[entry.messageIndex]!.content[entry.partIndex] = {
          type: 'text',
          text: `[${entry.kind} omitted: dropped to fit the request media budget]`,
        };
      }
      return Promise.resolve(out);
    },
  };
}
