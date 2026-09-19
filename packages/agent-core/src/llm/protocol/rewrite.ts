import type { Message, ThinkPart } from '#/llm/message';

import { convertToolResultToPlainText } from './tool-result-text';

export interface Rewrite<T> {
  readonly consumed: number;
  readonly replacement: readonly T[];
}

export interface Pattern<T> {
  readonly name: string;
  rewrite(items: readonly T[], index: number): Rewrite<T> | null;
}

export function applyPatterns<T>(items: readonly T[], patterns: readonly Pattern<T>[]): T[] {
  let current = [...items];
  for (const pattern of patterns) {
    const next: T[] = [];
    let i = 0;
    while (i < current.length) {
      const rewrite = pattern.rewrite(current, i);
      if (rewrite === null) {
        next.push(current[i] as T);
        i += 1;
      } else {
        next.push(...rewrite.replacement);
        i += rewrite.consumed;
      }
    }
    current = next;
  }
  return current;
}

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
