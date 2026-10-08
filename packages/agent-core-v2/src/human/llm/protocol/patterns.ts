import type { Message, ThinkPart } from '#/llm/message';

import { convertToolResultToPlainText } from '../requester/bases/tool-result-text';
import type { Pattern } from './rewrite';

export interface MergeUsersPolicy<T> {
  readonly isUser: (message: T) => boolean;
  readonly isToolResultOnly: (message: T) => boolean;
  readonly merge: (last: T, next: T) => T;
}

export function mergeConsecutiveUsers<T>(policy: MergeUsersPolicy<T>): Pattern<T> {
  return {
    name: 'mergeConsecutiveUsers',
    rewrite(items, index) {
      const first = items[index];
      if (first === undefined || !policy.isUser(first)) return null;
      let acc: T = first;
      let end = index + 1;
      while (end < items.length) {
        const next = items[end] as T;
        if (!policy.isUser(next)) break;
        if (!policy.isToolResultOnly(acc) && policy.isToolResultOnly(next)) break;
        acc = policy.merge(acc, next);
        end += 1;
      }
      if (end === index + 1) return null;
      return { consumed: end - index, replacement: [acc] };
    },
  };
}

export const toolResultToPlainText: Pattern<Message> = {
  name: 'toolResultToPlainText',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role !== 'tool') return null;
    return {
      consumed: 1,
      replacement: [
        {
          role: 'tool',
          toolCallId: message.toolCallId,
          content: [
            { type: 'text', text: convertToolResultToPlainText(message) },
            ...message.content.filter((part): part is ThinkPart => part.type === 'think'),
          ],
        },
      ],
    };
  },
};
