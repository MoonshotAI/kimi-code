/**
 * Message patterns shared by protocols: merging consecutive user messages and converting tool results
 * to plain text.
 */
import type { Message, ThinkPart } from '#/llm/message';

import { convertToolResultToPlainText } from '../builtin/protocol/tool-result-text';
import type { Pattern } from './pattern';

export interface MergeUsersPolicy<T> {
  readonly isUser: (message: T) => boolean;
  readonly isToolResultOnly: (message: T) => boolean;
  readonly merge: (last: T, next: T) => T;
}

/**
 * Converts a run of consecutive user messages into one message merged by `policy`, stopping before
 * a tool-result-only message when the accumulated message is not tool-result-only.
 *
 * @example
 * // With content-concatenating `policy.merge`:
 * // Input:
 * [
 *   { role: 'user', content: [{ type: 'text', text: 'A' }] }, // ←
 *   { role: 'user', content: [{ type: 'text', text: 'B' }] }, // ←
 * ]
 * // Output:
 * [
 *   {
 *     role: 'user',
 *     content: [ // ←
 *       { type: 'text', text: 'A' },
 *       { type: 'text', text: 'B' },
 *     ],
 *   },
 * ]
 */
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

/**
 * Converts a tool message's text and media into one plain-text part with media placeholders, and
 * preserves its thinking parts after that text.
 *
 * @example
 * // Input:
 * {
 *   role: 'tool',
 *   toolCallId: 'call-1',
 *   content: [
 *     { type: 'text', text: 'Chart ready' },
 *     { type: 'image_url', imageUrl: { url: 'https://example.com/chart.png' } }, // ←
 *   ],
 * }
 * // Output:
 * {
 *   role: 'tool',
 *   toolCallId: 'call-1',
 *   content: [
 *     {
 *       type: 'text',
 *       text: 'Chart ready\n(image omitted: tool result converted to plain text)', // ←
 *     },
 *   ],
 * }
 */
export const toolResultToPlainText: Pattern<Message> = {
  name: 'toolResultToPlainText',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role !== 'tool') return null;
    return {
      consumed: 1,
      replacement: [
        {
          ...message,
          content: [
            { type: 'text', text: convertToolResultToPlainText(message) },
            ...message.content.filter((part): part is ThinkPart => part.type === 'think'),
          ],
        },
      ],
    };
  },
};
